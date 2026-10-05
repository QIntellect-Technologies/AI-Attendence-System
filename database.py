import sqlite3
import json
import os
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Tuple
from logger_config import get_logger
from config import DB_PATH, ATTENDANCE_LOG_RETENTION_DAYS
from core.vertical_templates import normalize_vertical_payload, build_vertical_config
from core.json_utils import safe_json_loads, json_dumps
logger = get_logger(__name__)
_CONTROL_PLANE_TABLES_LOGGED = False


def init_db():
    """Initialize SQLite database with proper schema, columns, and indexes."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            # Users table
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    email TEXT,
                    phone TEXT,
                    department TEXT,
                    enrollment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    active INTEGER DEFAULT 1,
                    notes TEXT
                )
            ''')
            # ── Automatic Migrations ───────────────────────────────────────────
            _migrations = [
                "ALTER TABLE users ADD COLUMN photo_path TEXT",
                "ALTER TABLE users ADD COLUMN password TEXT",
                "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'staff'",
                "ALTER TABLE users ADD COLUMN cnic TEXT",
                "ALTER TABLE users ADD COLUMN position TEXT",
                "ALTER TABLE users ADD COLUMN salary REAL DEFAULT 0.0",
                "ALTER TABLE users ADD COLUMN benefits TEXT DEFAULT '[]'",
                "ALTER TABLE users ADD COLUMN join_date TEXT",
                "ALTER TABLE users ADD COLUMN person_code TEXT",
                "ALTER TABLE users ADD COLUMN registration_number TEXT",
                "ALTER TABLE users ADD COLUMN people_type TEXT DEFAULT 'staff'",
                "ALTER TABLE users ADD COLUMN person_code_label TEXT",
                "ALTER TABLE users ADD COLUMN profile_image_url TEXT",
                "ALTER TABLE users ADD COLUMN profile_image_name TEXT",
                "ALTER TABLE users ADD COLUMN shift TEXT DEFAULT 'Morning'",
                "ALTER TABLE users ADD COLUMN duty_start TEXT DEFAULT '09:00'",
                "ALTER TABLE users ADD COLUMN duty_end TEXT DEFAULT '18:00'",
                "ALTER TABLE users ADD COLUMN staff_type TEXT DEFAULT 'office'",
                "ALTER TABLE users ADD COLUMN access_modules TEXT DEFAULT '[]'",
                "ALTER TABLE users ADD COLUMN deleted_at TEXT",
                "ALTER TABLE users ADD COLUMN retention_until TEXT",
                "ALTER TABLE users ADD COLUMN termination_reason TEXT",
                "ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'",
                "ALTER TABLE users ADD COLUMN assigned_location TEXT",
                "ALTER TABLE users ADD COLUMN location_lat REAL",
                "ALTER TABLE users ADD COLUMN location_lng REAL",
                "ALTER TABLE users ADD COLUMN geofence_radius INTEGER DEFAULT 100",
                "ALTER TABLE users ADD COLUMN is_face_verified INTEGER DEFAULT 0",
            ]
            for sql in _migrations:
                try:
                    cursor.execute(sql)
                    conn.commit()
                    col = sql.split("ADD COLUMN")[1].strip().split()[0]
                    logger.info(f"✓ Migration applied: '{col}' column added.")
                except sqlite3.OperationalError:
                    pass

            # Create unique index on person_code scope after migrations have
            # run so the column exists when the index expression references it.
            try:
                cursor.execute(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_person_code_scope
                    ON users (
                    organization_id,
                    branch_id,
                    people_type,
                    person_code
                    )
                    WHERE active = 1 AND person_code IS NOT NULL AND person_code != ''
                    """
                )
            except sqlite3.OperationalError:
                # If index creation still fails, log and continue; migrations
                # may be applied on next run.
                logger.warning('Could not create uq_users_person_code_scope index yet.')

            # ── Ensure default admin account exists ────────────────────────────
            cursor.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'")
            if cursor.fetchone()[0] == 0:
                cursor.execute(
                    """INSERT INTO users
                       (name, email, password, role, department, active, notes)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    ("Administrator", "admin@company.com", "admin123",
                     "admin", "Administration", 1, "Default admin user"),
                )
                conn.commit()
                logger.info("✓ Default admin user created.")

            # ── Embeddings ─────────────────────────────────────────────────────
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS embeddings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    embedding BLOB NOT NULL,
                    source_video TEXT,
                    quality_score REAL DEFAULT 1.0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')

            # ── Attendance logs ────────────────────────────────────────────────
            # ARCH §8: canonical columns are org_id, branch_id, user_id(=staff_id),
            # timestamp, source, confidence. org_id/branch_id added via migration
            # below so existing installs are not broken.
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS attendance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    detected_name TEXT,
                    confidence REAL,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    source TEXT,
                    frame_quality TEXT,
                    location TEXT,
                    device_id TEXT,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')

            # ── Attendance migration: add org_id + branch_id (ARCH §8) ─────────
            for _att_col_sql in (
                "ALTER TABLE attendance ADD COLUMN org_id INTEGER",
                "ALTER TABLE attendance ADD COLUMN branch_id INTEGER",
            ):
                try:
                    cursor.execute(_att_col_sql)
                    conn.commit()
                    col = _att_col_sql.split("ADD COLUMN")[1].strip().split()[0]
                    logger.info(f"✓ Attendance migration: '{col}' column added.")
                except sqlite3.OperationalError:
                    pass

            # ── Leave requests ─────────────────────────────────────────────────
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS leave_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    user_name TEXT,
                    leave_type TEXT,
                    start_date TEXT,
                    end_date TEXT,
                    reason TEXT,
                    status TEXT DEFAULT 'pending',
                    approved_by TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')

            # ── Overtime ───────────────────────────────────────────────────────
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS overtime (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    user_name TEXT,
                    ot_date TEXT,
                    hours REAL,
                    reason TEXT,
                    status TEXT DEFAULT 'pending',
                    approved_by TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')

            # ── Salary configs ─────────────────────────────────────────────────
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS salary_configs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL UNIQUE,
                    basic_salary REAL DEFAULT 0.0,
                    allowances REAL DEFAULT 0.0,
                    deductions REAL DEFAULT 0.0,
                    ot_rate REAL DEFAULT 0.0,
                    effective_from TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')

            # ── Indexes ────────────────────────────────────────────────────────
            _indexes = [
                'CREATE INDEX IF NOT EXISTS idx_users_name        ON users(name)',
                'CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email)',
                'CREATE INDEX IF NOT EXISTS idx_users_active      ON users(active)',
                'CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role)',
                'CREATE INDEX IF NOT EXISTS idx_embeddings_user   ON embeddings(user_id)',
                'CREATE INDEX IF NOT EXISTS idx_attendance_user   ON attendance(user_id)',
                'CREATE INDEX IF NOT EXISTS idx_attendance_ts     ON attendance(timestamp)',
                'CREATE INDEX IF NOT EXISTS idx_attendance_source ON attendance(source)',
                'CREATE INDEX IF NOT EXISTS idx_attendance_org    ON attendance(org_id)',
                'CREATE INDEX IF NOT EXISTS idx_attendance_branch ON attendance(branch_id)',
                'CREATE INDEX IF NOT EXISTS idx_leave_user        ON leave_requests(user_id)',
                'CREATE INDEX IF NOT EXISTS idx_leave_status      ON leave_requests(status)',
                'CREATE INDEX IF NOT EXISTS idx_overtime_user     ON overtime(user_id)',
                'CREATE INDEX IF NOT EXISTS idx_overtime_status   ON overtime(status)',
                'CREATE INDEX IF NOT EXISTS idx_salary_user       ON salary_configs(user_id)',
            ]
            for idx_sql in _indexes:
                cursor.execute(idx_sql)

            conn.commit()

        try:
            ensure_notification_tables()
        except Exception as notification_error:
            logger.warning(f"Notification table initialization deferred: {notification_error}")

        logger.info(f"✓ Database initialized at {DB_PATH}")
        return True
    except Exception as e:
        logger.error(f"✗ Database initialization failed: {e}")
        return False


# ── Internal helpers ───────────────────────────────────────────────────────────

def _row_to_user(row, columns: List[str]) -> Dict:
    """Convert a DB row tuple + column list into a typed user dict."""
    data = dict(zip(columns, row))
    raw_modules = data.get('access_modules', '[]') or '[]'
    data['access_modules'] = json.loads(raw_modules) if isinstance(raw_modules, str) else raw_modules
    data['salary'] = float(data['salary']) if data.get('salary') is not None else 0.0
    data['location_lat'] = float(data['location_lat']) if data.get('location_lat') is not None else None
    data['location_lng'] = float(data['location_lng']) if data.get('location_lng') is not None else None
    data['geofence_radius'] = int(data['geofence_radius']) if data.get('geofence_radius') is not None else 100
    data['is_face_verified'] = bool(data.get('is_face_verified', 0))
    return data


_USER_COLUMNS = [
    'id', 'name', 'email', 'phone', 'department',
    'enrollment_date', 'created_at', 'active', 'notes', 'photo_path',
    'password', 'role', 'cnic', 'position', 'salary', 'benefits', 'join_date',
    'shift', 'duty_start', 'duty_end', 'staff_type', 'access_modules',
    'assigned_location', 'location_lat', 'location_lng',
    'geofence_radius', 'is_face_verified',
]

_USER_SELECT = ', '.join(f'u.{c}' if '{alias}' not in c else c for c in _USER_COLUMNS)
_USER_SELECT_PLAIN = ', '.join(_USER_COLUMNS)


# ── User CRUD ──────────────────────────────────────────────────────────────────

def get_user_by_name(name: str) -> Optional[Dict]:
    """Retrieve a full user record by exact name match (active users only)."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f'SELECT {_USER_SELECT_PLAIN} FROM users WHERE name = ? AND active = 1',
                (name,),
            )
            row = cursor.fetchone()
        if not row:
            return None
        return _row_to_user(row, _USER_COLUMNS)
    except Exception as e:
        logger.error(f"Failed to fetch user by name '{name}': {e}")
        return None


def get_archived_users(
    organization_id: int = None,
    branch_id: int = None,
) -> List[Dict]:
    """Return archived/inactive retained employees."""
    ensure_staff_api_columns()

    try:
        filters = [
            "active = 0",
            "deleted_at IS NOT NULL",
            "retention_until IS NOT NULL",
        ]
        params: List = []

        if organization_id is not None:
            filters.append("organization_id = ?")
            params.append(int(organization_id))

        if branch_id is not None:
            filters.append("branch_id = ?")
            params.append(int(branch_id))

        where_sql = " AND ".join(filters)

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT {_staff_select_columns()}
                FROM users
                WHERE {where_sql}
                ORDER BY deleted_at DESC
                """,
                tuple(params),
            )
            rows = cursor.fetchall()

        return [_row_to_staff_api_user(row, _STAFF_API_COLUMNS) for row in rows]

    except Exception as e:
        logger.exception(f"Failed to get archived users: {e}")
        return []

def delete_user(user_id: int) -> bool:
    """Hard-delete a user. Cascades to embeddings and attendance via FK."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("PRAGMA foreign_keys = ON")
            cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
            deleted = cursor.rowcount > 0
            conn.commit()
        if deleted:
            logger.info(f"✓ User ID {user_id} deleted (cascade applied)")
        return deleted
    except Exception as e:
        logger.error(f"Failed to delete user ID {user_id}: {e}")
        return False

def hard_delete_archived_user(
    user_id: int,
    organization_id: int = None,
    deleted_by: int = None,
) -> Optional[Dict]:
    """Permanently delete one archived employee and all dependent records."""
    ensure_staff_api_columns()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("PRAGMA foreign_keys = ON")

            cursor.execute(
                """
                SELECT id, name, organization_id, photo_path
                FROM users
                WHERE id = ?
                  AND active = 0
                  AND deleted_at IS NOT NULL
                """,
                (int(user_id),),
            )
            row = cursor.fetchone()

            if not row:
                return None

            db_user_id, user_name, user_org_id, photo_path = row

            if organization_id is not None and int(user_org_id or 0) != int(organization_id):
                return None

            dependent_counts = {}
            for table_name in (
                "embeddings",
                "attendance",
                "leave_requests",
                "overtime",
                "salary_configs",
            ):
                cursor.execute(
                    f"DELETE FROM {table_name} WHERE user_id = ?",
                    (int(user_id),),
                )
                dependent_counts[table_name] = int(cursor.rowcount or 0)

            cursor.execute(
                "DELETE FROM users WHERE id = ? AND active = 0",
                (int(user_id),),
            )
            deleted = cursor.rowcount > 0
            conn.commit()

        if not deleted:
            return None

        try:
            if photo_path and os.path.exists(photo_path):
                os.remove(photo_path)
        except Exception as photo_error:
            logger.warning(
                f"Could not remove profile photo for purged user {user_id}: {photo_error}"
            )

        logger.info(
            f"Permanently deleted archived user ID {user_id}; "
            f"deleted_by={deleted_by}; dependent_counts={dependent_counts}"
        )

        return {
            "user_id": int(db_user_id),
            "name": user_name,
            "organization_id": int(user_org_id) if user_org_id is not None else None,
            "deleted_by": int(deleted_by) if deleted_by is not None else None,
            "dependent_counts": dependent_counts,
        }

    except Exception as e:
        logger.error(f"Failed to permanently delete archived user {user_id}: {e}")
        return None


def hard_delete_archived_users(
    user_ids: List[int],
    organization_id: int = None,
    deleted_by: int = None,
) -> Dict:
    """Permanently delete multiple archived employees."""
    deleted_user_ids: List[int] = []
    skipped_user_ids: List[int] = []

    for raw_id in user_ids or []:
        try:
            uid = int(raw_id)
        except (TypeError, ValueError):
            continue

        result = hard_delete_archived_user(
            uid,
            organization_id=organization_id,
            deleted_by=deleted_by,
        )

        if result:
            deleted_user_ids.append(uid)
        else:
            skipped_user_ids.append(uid)

    return {
        "deleted_count": len(deleted_user_ids),
        "deleted_user_ids": deleted_user_ids,
        "skipped_user_ids": skipped_user_ids,
        "deleted_by": int(deleted_by) if deleted_by is not None else None,
    }


def _normalize_retention_years(value, default: int = 5) -> int:
    """Clamp employee HR retention policy to a safe production range."""
    try:
        years = int(value)
    except (TypeError, ValueError):
        years = default
    return max(1, min(years, 10))


def get_employee_retention_policy(organization_id: int) -> Optional[Dict]:
    """Return the employee HR retention policy for an organization."""
    ensure_control_plane_tables()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, name,
                       COALESCE(employee_retention_years, 5),
                       retention_policy_updated_at,
                       retention_policy_updated_by
                FROM organizations
                WHERE id = ?
                """,
                (int(organization_id),),
            )
            row = cursor.fetchone()

        if not row:
            return None

        return {
            "organization_id": int(row[0]),
            "organization_name": row[1],
            "employee_retention_years": _normalize_retention_years(row[2]),
            "retention_policy_updated_at": row[3],
            "retention_policy_updated_by": row[4],
        }
    except Exception as e:
        logger.error(f"Failed to get employee retention policy for org {organization_id}: {e}")
        return None


def update_employee_retention_policy(
    organization_id: int,
    employee_retention_years: int,
    updated_by: int = None,
) -> Optional[Dict]:
    """Persist employee HR retention years in the company/organization config."""
    ensure_control_plane_tables()
    years = _normalize_retention_years(employee_retention_years)

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE organizations
                SET employee_retention_years = ?,
                    retention_policy_updated_at = datetime('now'),
                    retention_policy_updated_by = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (years, updated_by, int(organization_id)),
            )

            if cursor.rowcount == 0:
                conn.rollback()
                return None

            conn.commit()

        return get_employee_retention_policy(int(organization_id))
    except Exception as e:
        logger.error(f"Failed to update employee retention policy for org {organization_id}: {e}")
        return None


def archive_user_for_retention(
    user_id: int,
    retention_years: int = None,
    reason: str = "Removed from staff directory",
    archived_by: int = None,
    organization_id: int = None,
) -> Optional[Dict]:
    """Soft-delete / archive an employee."""
    ensure_staff_api_columns()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            cursor.execute(
                "SELECT id, name, organization_id FROM users WHERE id = ?",
                (int(user_id),),
            )
            row = cursor.fetchone()
            if not row:
                return None

            db_user_id, user_name, user_org_id = row

            # Same invariant as restore_archived_user/hard_delete_archived_user:
            # if a caller passes organization_id, the target must actually
            # belong to that org, or we refuse — callers must pass the org_id
            # from a verified auth token, never a client-supplied one, so this
            # is what actually stops a cross-org archive/delete.
            if organization_id is not None and int(user_org_id or 0) != int(organization_id):
                return None

            effective_org_id = organization_id if organization_id is not None else user_org_id

            if retention_years is None and effective_org_id:
                policy = get_employee_retention_policy(int(effective_org_id))
                retention_years = (
                    policy.get("employee_retention_years")
                    if policy
                    else 5
                )

            years = _normalize_retention_years(retention_years)

            cursor.execute("DELETE FROM embeddings WHERE user_id = ?", (int(user_id),))
            deleted_embeddings = cursor.rowcount

            cursor.execute(
                """
                UPDATE users
                SET active = 0,
                    status = 'inactive',
                    deleted_at = datetime('now'),
                    retention_until = datetime('now', ?),
                    termination_reason = ?
                WHERE id = ?
                """,
                (f"+{years} years", reason, int(user_id)),
            )

            cursor.execute(
                """
                SELECT deleted_at, retention_until
                FROM users
                WHERE id = ?
                """,
                (int(user_id),),
            )
            archive_row = cursor.fetchone()
            conn.commit()

            logger.info(
                f"Archived user ID {user_id}; embeddings deleted={deleted_embeddings}; "
                f"retention={years} years; archived_by={archived_by}"
            )

            return {
                "user_id": int(db_user_id),
                "name": user_name,
                "organization_id": int(effective_org_id) if effective_org_id is not None else None,
                "retention_years": years,
                "deleted_embeddings": int(deleted_embeddings or 0),
                "deleted_at": archive_row[0] if archive_row else None,
                "retention_until": archive_row[1] if archive_row else None,
            }

    except Exception as e:
        logger.error(f"Failed to archive user ID {user_id}: {e}")
        return None


def restore_archived_user(
    user_id: int,
    restored_by: int = None,
    organization_id: int = None,
) -> Optional[Dict]:
    """Restore an archived employee back to active directory."""
    try:
        ensure_staff_api_columns()

        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            cursor.execute(
                "SELECT * FROM users WHERE id = ?",
                (int(user_id),),
            )
            user = cursor.fetchone()

            if not user:
                return None

            user_dict = dict(user)

            if organization_id is not None:
                if int(user_dict.get("organization_id") or 0) != int(organization_id):
                    return None

            email = user_dict.get("email")
            if email:
                cursor.execute(
                    """
                    SELECT id FROM users
                    WHERE LOWER(email) = LOWER(?)
                      AND id != ?
                      AND active = 1
                    LIMIT 1
                    """,
                    (email, int(user_id)),
                )

                if cursor.fetchone():
                    raise ValueError(
                        "Another active employee already uses this email."
                    )

            cursor.execute(
                """
                UPDATE users
                SET active = 1,
                    status = 'active',
                    deleted_at = NULL,
                    retention_until = NULL,
                    termination_reason = NULL,
                    attendance_enabled = 1,
                    is_face_verified = 0
                WHERE id = ?
                """,
                (int(user_id),),
            )

            conn.commit()

        restored = get_user_by_id(int(user_id))

        return {
            "user_id": int(user_id),
            "name": restored.get("name") if restored else user_dict.get("name"),
            "organization_id": restored.get("organization_id") if restored else user_dict.get("organization_id"),
            "branch_id": restored.get("branch_id") if restored else user_dict.get("branch_id"),
            "restored_by": restored_by,
            "requires_training": True,
            "message": "Employee restored. Biometric training is required again.",
        }

    except Exception as e:
        logger.error(f"Failed to restore archived user {user_id}: {e}")
        raise

def purge_expired_archived_users(organization_id: int = None) -> Dict:
    """Permanently delete archived users whose retention period has expired."""
    ensure_staff_api_columns()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("PRAGMA foreign_keys = ON")

            params = []
            org_filter = ""
            if organization_id is not None:
                org_filter = " AND organization_id = ?"
                params.append(int(organization_id))

            cursor.execute(
                f"""
                SELECT id FROM users
                WHERE active = 0
                  AND retention_until IS NOT NULL
                  AND datetime(retention_until) <= datetime('now')
                  {org_filter}
                """,
                tuple(params),
            )

            user_ids = [int(row[0]) for row in cursor.fetchall()]

            for uid in user_ids:
                cursor.execute("DELETE FROM users WHERE id = ?", (uid,))

            conn.commit()
            logger.info(f"Purged {len(user_ids)} expired archived users")

            return {
                "purged_count": len(user_ids),
                "purged_user_ids": user_ids,
            }

    except Exception as e:
        logger.error(f"Failed to purge expired archived users: {e}")
        return {
            "purged_count": 0,
            "purged_user_ids": [],
        }


def change_password(user_id: int, new_password: str) -> bool:
    """Update a user's password."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                'UPDATE users SET password = ? WHERE id = ?',
                (new_password, user_id),
            )
            updated = cursor.rowcount > 0
            conn.commit()
        return updated
    except Exception as e:
        logger.error(f"Failed to change password for user {user_id}: {e}")
        return False


# ── Notifications ─────────────────────────────────────────────────────────────

def ensure_notification_tables() -> bool:
    """Create durable dashboard notification tables."""
    try:
        ensure_staff_api_columns()
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("PRAGMA foreign_keys = ON")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    organization_id INTEGER,
                    branch_id INTEGER,
                    module_key TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT,
                    actor_user_id INTEGER,
                    actor_name TEXT,
                    target_user_id INTEGER,
                    target_entity_id TEXT,
                    target_entity_type TEXT,
                    target_route TEXT,
                    metadata_json TEXT DEFAULT '{}',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
                    FOREIGN KEY(target_user_id) REFERENCES users(id) ON DELETE SET NULL
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS notification_recipients (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    notification_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    read_at TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(notification_id, user_id),
                    FOREIGN KEY(notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_notifications_org_branch ON notifications(organization_id, branch_id)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_notifications_module ON notifications(module_key)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_notification_recipients_user ON notification_recipients(user_id, read_at)"
            )
            conn.commit()
        return True
    except Exception as e:
        logger.error(f"Failed to initialize notification tables: {e}")
        return False


def _notification_json_array(value) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except Exception:
            pass
        return [item.strip() for item in raw.split(',') if item.strip()]
    return []


def _notification_user_has_module(user: Dict, module_key: str) -> bool:
    allowed = set(_notification_json_array(user.get('access_modules')))
    return module_key in allowed


def _notification_recipient_users(
    organization_id: int,
    branch_id: int = None,
    module_key: str = '',
    exclude_user_id: int = None,
) -> List[int]:
    ensure_notification_tables()

    if not organization_id:
        return []

    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT DISTINCT
                    u.id,
                    u.role,
                    u.branch_id,
                    u.organization_id,
                    u.access_modules,
                    u.active
                FROM users u
                LEFT JOIN organization_admins oa ON oa.user_id = u.id
                WHERE COALESCE(u.active, 1) = 1
                  AND (
                    u.organization_id = ?
                    OR oa.organization_id = ?
                  )
                """,
                (int(organization_id), int(organization_id)),
            )
            rows = [dict(row) for row in cursor.fetchall()]

        recipients: List[int] = []
        for user in rows:
            uid = int(user.get('id'))
            if exclude_user_id is not None and uid == int(exclude_user_id):
                continue

            role = str(user.get('role') or '').lower()

            if role == 'admin':
                recipients.append(uid)
                continue

            if role != 'staff':
                continue

            if branch_id is not None:
                try:
                    if int(user.get('branch_id') or 0) != int(branch_id):
                        continue
                except (TypeError, ValueError):
                    continue

            if module_key and not _notification_user_has_module(user, module_key):
                continue

            recipients.append(uid)

        return sorted(set(recipients))

    except Exception as e:
        logger.error(f"Failed to resolve notification recipients: {e}")
        return []


def _notification_valid_extra_recipients(
    user_ids: List[int],
    organization_id: int,
) -> List[int]:
    cleaned: List[int] = []
    for raw_id in user_ids or []:
        try:
            uid = int(raw_id)
        except (TypeError, ValueError):
            continue
        if uid > 0 and uid not in cleaned:
            cleaned.append(uid)

    if not cleaned:
        return []

    try:
        placeholders = ",".join("?" for _ in cleaned)
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT DISTINCT u.id, u.role, u.organization_id
                FROM users u
                LEFT JOIN organization_admins oa ON oa.user_id = u.id
                WHERE COALESCE(u.active, 1) = 1
                  AND u.id IN ({placeholders})
                  AND (
                    LOWER(COALESCE(u.role, '')) = 'admin'
                    OR u.organization_id = ?
                    OR oa.organization_id = ?
                  )
                """,
                tuple(cleaned + [int(organization_id), int(organization_id)]),
            )
            rows = cursor.fetchall()

        return [int(row["id"]) for row in rows]

    except Exception as e:
        logger.error(f"Failed to validate explicit notification recipients: {e}")
        return []


def create_notification(
    organization_id: int,
    branch_id: int = None,
    module_key: str = '',
    event_type: str = '',
    title: str = '',
    body: str = '',
    actor_user_id: int = None,
    actor_name: str = '',
    target_user_id: int = None,
    target_entity_id=None,
    target_entity_type: str = '',
    target_route: str = '',
    metadata: Dict = None,
    exclude_user_id: int = None,
    extra_recipient_user_ids: List[int] = None,
) -> Optional[Dict]:
    """Persist one notification and deliver it to calculated recipients."""
    ensure_notification_tables()

    if not organization_id or not module_key or not event_type or not title:
        return None

    recipients = set(_notification_recipient_users(
        organization_id=int(organization_id),
        branch_id=int(branch_id) if branch_id is not None else None,
        module_key=str(module_key),
        exclude_user_id=exclude_user_id,
    ))

    for uid in _notification_valid_extra_recipients(
        extra_recipient_user_ids or [],
        int(organization_id),
    ):
        if exclude_user_id is not None and int(uid) == int(exclude_user_id):
            continue
        recipients.add(int(uid))

    recipients = sorted(recipients)

    if not recipients:
        logger.info(
            f"Notification skipped without recipients: module={module_key}, org={organization_id}, branch={branch_id}"
        )
        return None

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO notifications (
                    organization_id, branch_id, module_key, event_type,
                    title, body, actor_user_id, actor_name, target_user_id,
                    target_entity_id, target_entity_type, target_route,
                    metadata_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(organization_id),
                    int(branch_id) if branch_id is not None else None,
                    str(module_key),
                    str(event_type),
                    str(title),
                    str(body or ''),
                    int(actor_user_id) if actor_user_id is not None else None,
                    str(actor_name or ''),
                    int(target_user_id) if target_user_id is not None else None,
                    str(target_entity_id) if target_entity_id is not None else None,
                    str(target_entity_type or ''),
                    str(target_route or ''),
                    json.dumps(metadata or {}, ensure_ascii=False),
                ),
            )
            notification_id = int(cursor.lastrowid)

            for recipient_id in recipients:
                cursor.execute(
                    """
                    INSERT OR IGNORE INTO notification_recipients
                        (notification_id, user_id)
                    VALUES (?, ?)
                    """,
                    (notification_id, int(recipient_id)),
                )

            conn.commit()

        return {
            'id': notification_id,
            'recipient_user_ids': recipients,
            'recipient_count': len(recipients),
        }

    except Exception as e:
        logger.error(f"Failed to create notification: {e}")
        return None


def _row_to_notification(row) -> Dict:
    data = dict(row)
    metadata_json = data.pop('metadata_json', None)
    try:
        data['metadata'] = json.loads(metadata_json) if metadata_json else {}
    except Exception:
        data['metadata'] = {}
    data['is_read'] = bool(data.get('read_at'))
    return data


def get_notifications_for_user(
    user_id: int,
    organization_id: int = None,
    unread_only: bool = False,
    limit: int = 50,
) -> List[Dict]:
    ensure_notification_tables()

    try:
        filters = ["nr.user_id = ?"]
        params: List = [int(user_id)]

        if organization_id is not None and int(organization_id) > 0:
            filters.append("n.organization_id = ?")
            params.append(int(organization_id))

        if unread_only:
            filters.append("nr.read_at IS NULL")

        where_sql = " AND ".join(filters)
        safe_limit = max(1, min(int(limit or 50), 200))

        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT
                    n.id, n.organization_id, n.branch_id, n.module_key,
                    n.event_type, n.title, n.body, n.actor_user_id, n.actor_name,
                    n.target_user_id, n.target_entity_id, n.target_entity_type,
                    n.target_route, n.metadata_json, n.created_at, nr.read_at
                FROM notification_recipients nr
                JOIN notifications n ON n.id = nr.notification_id
                WHERE {where_sql}
                ORDER BY datetime(n.created_at) DESC, n.id DESC
                LIMIT ?
                """,
                tuple(params + [safe_limit]),
            )
            rows = cursor.fetchall()

        return [_row_to_notification(row) for row in rows]

    except Exception as e:
        logger.error(f"Failed to get notifications for user {user_id}: {e}")
        return []


def get_unread_notification_count(user_id: int, organization_id: int = None) -> int:
    ensure_notification_tables()

    try:
        filters = ["nr.user_id = ?", "nr.read_at IS NULL"]
        params: List = [int(user_id)]

        if organization_id is not None and int(organization_id) > 0:
            filters.append("n.organization_id = ?")
            params.append(int(organization_id))

        where_sql = " AND ".join(filters)

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT COUNT(*)
                FROM notification_recipients nr
                JOIN notifications n ON n.id = nr.notification_id
                WHERE {where_sql}
                """,
                tuple(params),
            )
            return int(cursor.fetchone()[0] or 0)

    except Exception as e:
        logger.error(f"Failed to get unread notification count for user {user_id}: {e}")
        return 0


def mark_notification_read(notification_id: int, user_id: int) -> bool:
    ensure_notification_tables()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE notification_recipients
                SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
                WHERE notification_id = ? AND user_id = ?
                """,
                (int(notification_id), int(user_id)),
            )
            updated = cursor.rowcount > 0
            conn.commit()
        return updated
    except Exception as e:
        logger.error(f"Failed to mark notification {notification_id} read: {e}")
        return False


def delete_notification(
    notification_id: int,
    user_id: int,
    organization_id: int | None = None,
) -> bool:
    ensure_notification_tables()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            if organization_id is not None and int(organization_id) > 0:
                cursor.execute(
                    """
                    DELETE FROM notification_recipients
                    WHERE notification_id = ?
                      AND user_id = ?
                      AND notification_id IN (
                        SELECT id FROM notifications WHERE organization_id = ?
                      )
                    """,
                    (int(notification_id), int(user_id), int(organization_id)),
                )
            else:
                cursor.execute(
                    """
                    DELETE FROM notification_recipients
                    WHERE notification_id = ? AND user_id = ?
                    """,
                    (int(notification_id), int(user_id)),
                )
            deleted = cursor.rowcount > 0
            conn.commit()
        return deleted
    except Exception as e:
        logger.error(f"Failed to delete notification {notification_id}: {e}")
        return False


def bulk_delete_notifications(
    notification_ids: list[int],
    user_id: int,
    organization_id: int | None = None,
) -> int:
    ensure_notification_tables()

    ids = sorted({int(i) for i in (notification_ids or []) if i is not None})
    if not ids:
        return 0

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            placeholders = ",".join("?" for _ in ids)
            params: list = [*ids, int(user_id)]

            if organization_id is not None and int(organization_id) > 0:
                params.append(int(organization_id))
                cursor.execute(
                    f"""
                    DELETE FROM notification_recipients
                    WHERE notification_id IN ({placeholders})
                      AND user_id = ?
                      AND notification_id IN (
                        SELECT id FROM notifications WHERE organization_id = ?
                      )
                    """,
                    tuple(params),
                )
            else:
                cursor.execute(
                    f"""
                    DELETE FROM notification_recipients
                    WHERE notification_id IN ({placeholders})
                      AND user_id = ?
                    """,
                    tuple(params),
                )
            deleted = int(cursor.rowcount or 0)
            conn.commit()
        return deleted
    except Exception as e:
        logger.error(f"Failed to bulk delete notifications for user {user_id}: {e}")
        return 0


def mark_all_notifications_read(user_id: int, organization_id: int = None) -> int:
    ensure_notification_tables()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            if organization_id is not None:
                cursor.execute(
                    """
                    UPDATE notification_recipients
                    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
                    WHERE user_id = ?
                      AND read_at IS NULL
                      AND notification_id IN (
                        SELECT id FROM notifications WHERE organization_id = ?
                      )
                    """,
                    (int(user_id), int(organization_id)),
                )
            else:
                cursor.execute(
                    """
                    UPDATE notification_recipients
                    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
                    WHERE user_id = ? AND read_at IS NULL
                    """,
                    (int(user_id),),
                )

            updated = int(cursor.rowcount or 0)
            conn.commit()
        return updated
    except Exception as e:
        logger.error(f"Failed to mark all notifications read for user {user_id}: {e}")
        return 0


# ── Photo ──────────────────────────────────────────────────────────────────────

def save_user_photo(user_id: int, photo_path: str) -> bool:
    """Persist profile photo path and dashboard/Flutter photo URL aliases."""
    ensure_staff_api_columns()

    try:
        filename = os.path.basename(photo_path or '')
        photo_url = f"/api/users/{int(user_id)}/photo"

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE users
                SET photo_path = ?,
                    profile_image_url = ?,
                    profile_image_name = ?
                WHERE id = ?
                """,
                (photo_path, photo_url, filename, int(user_id)),
            )
            updated = cursor.rowcount > 0
            conn.commit()
        return updated
    except Exception as e:
        logger.error(f"Failed to save photo for user {user_id}: {e}")
        return False


def get_user_photo(user_id: int) -> Optional[str]:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT photo_path FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
        return row[0] if row and row[0] else None
    except Exception as e:
        logger.error(f"Failed to get photo for user {user_id}: {e}")
        return None


# ── Embeddings ─────────────────────────────────────────────────────────────────

def store_embedding(user_id: int, embedding: List[float], source_video: str = None):
    """Persist a face embedding vector for a user in local SQLite.

    ARCH §2B / §4: For Local mode, this is the primary matching store.
    The cloud fallback copy is written separately by the node sync worker
    via support_db.mark_node_training_job_trained() which handles
    face_embeddings_cloud with is_fallback_copy=True.
    For Cloud mode, embeddings go directly into Supabase via the training
    job pipeline — this function is not called for cloud-mode orgs.
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                'INSERT INTO embeddings (user_id, embedding, source_video) VALUES (?, ?, ?)',
                (user_id, json.dumps(embedding).encode(), source_video),
            )
            conn.commit()
    except Exception as e:
        logger.error(f"Failed to store embedding for user {user_id}: {e}")


def delete_embeddings_for_user(user_id: int) -> int:
    """Delete all stored biometric embeddings for one user before re-training."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                'DELETE FROM embeddings WHERE user_id = ?',
                (int(user_id),),
            )
            deleted = cursor.rowcount
            conn.commit()

        logger.info(
            f"Deleted {int(deleted or 0)} old biometric embeddings for user {user_id}"
        )
        return int(deleted or 0)
    except Exception as e:
        logger.error(f"Failed to delete embeddings for user {user_id}: {e}")
        return 0


def get_embeddings_for_user(user_id: int) -> List[Dict]:
    """Return all embeddings for a user."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                'SELECT id, embedding, source_video, created_at FROM embeddings WHERE user_id = ?',
                (user_id,),
            )
            rows = cursor.fetchall()
        return [
            {'id': r[0], 'embedding': json.loads(r[1].decode()),
             'source_video': r[2], 'created_at': r[3]}
            for r in rows
        ]
    except Exception as e:
        logger.error(f"Failed to get embeddings for user {user_id}: {e}")
        return []

def mark_user_face_verified(user_id: int, verified: bool = True) -> bool:
    """Mark a user as biometrically trained after embeddings are stored."""
    ensure_staff_api_columns()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE users
                SET is_face_verified = ?
                WHERE id = ?
                  AND active = 1
                """,
                (1 if verified else 0, int(user_id)),
            )
            updated = cursor.rowcount > 0
            conn.commit()

        return updated
    except Exception as e:
        logger.error(f"Failed to mark user {user_id} face verified: {e}")
        return False


# ── Attendance ─────────────────────────────────────────────────────────────────

def log_attendance(
    user_id: int,
    detected_name: str,
    confidence: float,
    source: str = 'camera',
    org_id: int = None,
    branch_id: int = None,
):
    """Insert a single attendance record.

    ARCH §5: source must be one of the canonical tags:
      camera | camera_cloud | mobile_office | mobile_field |
      mobile_fallback | mobile_cloud
    org_id and branch_id are stored so reports remain tenant-scoped.
    For Local-mode CCTV the node pushes directly to Supabase via
    /v1/node/push-attendance; this function handles legacy SQLite installs
    and the frame-level recognition path on Railway for Cloud mode.
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''INSERT INTO attendance
                   (user_id, detected_name, confidence, source, org_id, branch_id)
                   VALUES (?, ?, ?, ?, ?, ?)''',
                (user_id, detected_name, confidence, source,
                 int(org_id) if org_id is not None else None,
                 int(branch_id) if branch_id is not None else None),
            )
            conn.commit()
    except Exception as e:
        logger.error(f"Failed to log attendance for user {user_id}: {e}")


def is_user_present_today(user_id: int) -> bool:
    """Return True if user already has an attendance record for today (UTC)."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT COUNT(*) FROM attendance WHERE user_id = ? AND date(timestamp) = date('now', 'utc')",
                (user_id,),
            )
            return cursor.fetchone()[0] > 0
    except Exception as e:
        logger.error(f"Failed to check today's attendance for user {user_id}: {e}")
        return False


def get_attendance_logs(
    limit: int = 100,
    organization_id: int = None,
    branch_id: int = None,
    start: str = None,
    end: str = None,
) -> List[Dict]:
    """Return the most recent attendance records joined with user/branch metadata."""
    try:
        filters: List[str] = []
        params: List = []

        if organization_id is not None:
            filters.append("u.organization_id = ?")
            params.append(int(organization_id))

        if branch_id is not None:
            filters.append("u.branch_id = ?")
            params.append(int(branch_id))

        if start:
            filters.append("date(a.timestamp) >= date(?)")
            params.append(start)

        if end:
            filters.append("date(a.timestamp) <= date(?)")
            params.append(end)

        where_sql = f"WHERE {' AND '.join(filters)}" if filters else ""
        safe_limit = max(1, min(int(limit or 100), 1000))

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f'''
                SELECT
                    a.id, u.id AS user_id, u.name AS user_name,
                    a.detected_name, a.confidence, a.timestamp, a.source,
                    u.department, u.branch_id, u.branch_name
                FROM attendance a
                JOIN users u ON a.user_id = u.id
                {where_sql}
                ORDER BY a.timestamp DESC
                LIMIT ?
                ''',
                tuple(params + [safe_limit]),
            )
            rows = cursor.fetchall()

        return [
            {
                'id': r[0],
                'user_id': r[1],
                'user_name': r[2],
                'name': r[2],
                'detected_name': r[3],
                'confidence': float(r[4] or 0),
                'timestamp': r[5],
                'created_at': r[5],
                'source': r[6],
                'department': r[7] or '',
                'branch_id': r[8],
                'branch_name': r[9] or '',
                'status': 'Present',
            }
            for r in rows
        ]
    except Exception as e:
        logger.error(f"Failed to fetch attendance logs: {e}")
        return []

def get_attendance_by_user(
    user_id: int,
    days: int = 7,
    start: str = None,
    end: str = None,
) -> List[Dict]:
    """Return attendance records for a user — by date range or last N days."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            if start and end:
                cursor.execute(
                    '''SELECT id, timestamp, confidence, source FROM attendance
                       WHERE user_id = ? AND date(timestamp) >= date(?) AND date(timestamp) <= date(?)
                       ORDER BY timestamp DESC''',
                    (user_id, start, end),
                )
            else:
                cursor.execute(
                    '''SELECT id, timestamp, confidence, source FROM attendance
                       WHERE user_id = ? AND date(timestamp) >= date('now', 'utc', '-' || ? || ' days')
                       ORDER BY timestamp DESC''',
                    (user_id, days),
                )
            rows = cursor.fetchall()
        return [{'id': r[0], 'timestamp': r[1], 'confidence': r[2], 'source': r[3]} for r in rows]
    except Exception as e:
        logger.error(f"Failed to get attendance for user {user_id}: {e}")
        return []


def get_attendance_today(
    organization_id: int = None,
    branch_id: int = None,
) -> List[Dict]:
    """Return all attendance records for today with user/branch metadata."""
    try:
        filters: List[str] = ["date(a.timestamp) = date('now', 'utc')"]
        params: List = []

        if organization_id is not None:
            filters.append("u.organization_id = ?")
            params.append(int(organization_id))

        if branch_id is not None:
            filters.append("u.branch_id = ?")
            params.append(int(branch_id))

        where_sql = " AND ".join(filters)

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f'''
                SELECT
                    a.id, u.id AS user_id, u.name AS user_name,
                    a.confidence, a.source, a.timestamp,
                    u.department, u.branch_id, u.branch_name
                FROM attendance a
                JOIN users u ON a.user_id = u.id
                WHERE {where_sql}
                ORDER BY a.timestamp DESC
                ''',
                tuple(params),
            )
            rows = cursor.fetchall()

        return [
            {
                'id': r[0],
                'user_id': r[1],
                'user_name': r[2],
                'confidence': float(r[3] or 0),
                'source': r[4],
                'check_in': r[5],
                'check_out': None,
                'status': 'PRESENT',
                'log_date': r[5].split(' ')[0] if r[5] else '',
                'created_at': r[5],
                'department': r[6] or '',
                'branch_id': r[7],
                'branch_name': r[8] or '',
            }
            for r in rows
        ]
    except Exception as e:
        logger.error(f"Failed to get today's attendance: {e}")
        return []

def get_attendance_statistics(
    organization_id: int = None,
    branch_id: int = None,
) -> Dict:
    """Return attendance statistics scoped by org/branch."""
    try:
        ensure_staff_api_columns()

        user_filters = ["u.active = 1"]
        attendance_user_filters = [
            "u.active = 1",
            "COALESCE(u.attendance_enabled, 1) = 1",
        ]

        user_params = []
        attendance_user_params = []

        if organization_id is not None:
            user_filters.append("u.organization_id = ?")
            attendance_user_filters.append("u.organization_id = ?")
            user_params.append(int(organization_id))
            attendance_user_params.append(int(organization_id))

        if branch_id is not None:
            user_filters.append("u.branch_id = ?")
            attendance_user_filters.append("u.branch_id = ?")
            user_params.append(int(branch_id))
            attendance_user_params.append(int(branch_id))

        user_where = " AND ".join(user_filters)
        attendance_user_where = " AND ".join(attendance_user_filters)

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            cursor.execute(f"SELECT COUNT(*) FROM users u WHERE {user_where}", tuple(user_params))
            total_users = cursor.fetchone()[0]

            cursor.execute(f"SELECT COUNT(*) FROM users u WHERE {attendance_user_where}", tuple(attendance_user_params))
            attendance_users = cursor.fetchone()[0]

            cursor.execute(
                f"""
                SELECT COUNT(DISTINCT u.id)
                FROM users u
                JOIN embeddings e ON e.user_id = u.id
                WHERE {attendance_user_where}
                """,
                tuple(attendance_user_params),
            )
            enrolled_users = cursor.fetchone()[0]

            cursor.execute(
                f"""
                SELECT COUNT(*)
                FROM attendance a
                JOIN users u ON a.user_id = u.id
                WHERE {attendance_user_where}
                """,
                tuple(attendance_user_params),
            )
            total_records = cursor.fetchone()[0]

            cursor.execute(
                f"""
                SELECT COUNT(*)
                FROM attendance a
                JOIN users u ON a.user_id = u.id
                WHERE {attendance_user_where}
                  AND date(a.timestamp) = date('now', 'utc')
                """,
                tuple(attendance_user_params),
            )
            today_count = cursor.fetchone()[0]

            cursor.execute(
                f"""
                SELECT COUNT(DISTINCT a.user_id)
                FROM attendance a
                JOIN users u ON a.user_id = u.id
                WHERE {attendance_user_where}
                  AND date(a.timestamp) = date('now', 'utc')
                """,
                tuple(attendance_user_params),
            )
            unique_today = cursor.fetchone()[0]

            cursor.execute(
                f"""
                SELECT AVG(a.confidence)
                FROM attendance a
                JOIN users u ON a.user_id = u.id
                WHERE {attendance_user_where}
                """,
                tuple(attendance_user_params),
            )
            avg_confidence = cursor.fetchone()[0] or 0.0

        return {
            "total_users": int(total_users or 0),
            "attendance_users": int(attendance_users or 0),
            "enrolled_users": int(enrolled_users or 0),
            "total_records": int(total_records or 0),
            "today_count": int(today_count or 0),
            "unique_users_today": int(unique_today or 0),
            "present_today": int(unique_today or 0),
            "absent_today": max(0, int(attendance_users or 0) - int(unique_today or 0)),
            "avg_confidence": float(avg_confidence),
            "recent_entries": [],
        }

    except Exception as e:
        logger.error(f"Failed to get statistics: {e}")
        return {
            "total_users": 0, "attendance_users": 0, "enrolled_users": 0,
            "total_records": 0, "today_count": 0, "unique_users_today": 0,
            "present_today": 0, "absent_today": 0, "avg_confidence": 0.0,
            "recent_entries": [],
        }


def cleanup_old_logs(days: int = ATTENDANCE_LOG_RETENTION_DAYS) -> int:
    """Delete attendance logs older than N days. Returns count deleted."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM attendance WHERE date(timestamp) < date('now', 'utc', '-' || ? || ' days')",
                (days,),
            )
            deleted = cursor.rowcount
            conn.commit()
        logger.info(f"✓ Cleaned up {deleted} old attendance records")
        return deleted
    except Exception as e:
        logger.error(f"Failed to cleanup logs: {e}")
        return 0


def mark_user_absent_today(user_id: int) -> bool:
    """Remove all today's attendance records for a user (marks them absent)."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM attendance WHERE user_id = ? AND date(timestamp) = date('now', 'utc')",
                (user_id,),
            )
            conn.commit()
        logger.info(f"✓ User ID {user_id} marked absent for today")
        return True
    except Exception as e:
        logger.error(f"Failed to mark user {user_id} absent: {e}")
        return False


def mark_user_present_today(user_id: int) -> bool:
    """Insert a manual attendance record for today if none exists."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT name FROM users WHERE id = ?', (user_id,))
            row = cursor.fetchone()
            if not row:
                return False
            name = row[0]

            cursor.execute(
                "SELECT COUNT(*) FROM attendance WHERE user_id = ? AND date(timestamp) = date('now', 'utc')",
                (user_id,),
            )
            if cursor.fetchone()[0] > 0:
                return True

            cursor.execute(
                "INSERT INTO attendance (user_id, detected_name, confidence, source) VALUES (?, ?, ?, ?)",
                (user_id, name, 1.0, 'manual'),
            )
            conn.commit()
        logger.info(f"✓ User ID {user_id} manually marked present")
        return True
    except Exception as e:
        logger.error(f"Failed to manually mark user {user_id} present: {e}")
        return False


# ── Leave ──────────────────────────────────────────────────────────────────────

def get_leave_requests(
    user_id: int = None,
    status: str = None,
    branch_id: int = None,
    organization_id: int = None,
) -> List[Dict]:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            query = """
                SELECT
                    lr.id, lr.user_id,
                    COALESCE(u.name, lr.user_name) AS user_name,
                    lr.leave_type, lr.start_date, lr.end_date, lr.reason,
                    lr.status, lr.approved_by, lr.created_at, lr.updated_at,
                    u.branch_id, u.branch_name, u.department
                FROM leave_requests lr
                LEFT JOIN users u ON u.id = lr.user_id
            """

            filters = []
            params = []

            if user_id is not None:
                filters.append("lr.user_id = ?")
                params.append(int(user_id))
            if status:
                filters.append("LOWER(lr.status) = ?")
                params.append(str(status).lower())
            if branch_id is not None:
                filters.append("u.branch_id = ?")
                params.append(int(branch_id))
            if organization_id is not None:
                filters.append("u.organization_id = ?")
                params.append(int(organization_id))

            if filters:
                query += " WHERE " + " AND ".join(filters)
            query += " ORDER BY lr.created_at DESC"

            cursor.execute(query, tuple(params))
            rows = cursor.fetchall()

        return [
            {
                "id": r[0], "user_id": r[1], "user_name": r[2], "name": r[2],
                "leave_type": r[3], "type": r[3], "start_date": r[4],
                "end_date": r[5], "reason": r[6], "status": r[7],
                "approved_by": r[8], "created_at": r[9], "updated_at": r[10],
                "branch_id": r[11], "branch_name": r[12] or "",
                "department": r[13] or "", "dept": r[13] or "",
            }
            for r in rows
        ]
    except Exception as e:
        logger.error(f"Failed to get leave requests: {e}")
        return []

def add_leave_request(
    user_id: int,
    user_name: str,
    leave_type: str,
    start_date: str,
    end_date: str,
    reason: str,
) -> Optional[int]:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''INSERT INTO leave_requests
                   (user_id, user_name, leave_type, start_date, end_date, reason, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?)''',
                (user_id, user_name, leave_type, start_date, end_date, reason, 'pending'),
            )
            conn.commit()
            return cursor.lastrowid
    except Exception as e:
        logger.error(f"Failed to add leave request for user {user_id}: {e}")
        return None


def update_leave_status(leave_id: int, status: str, approved_by: str) -> bool:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''UPDATE leave_requests
                   SET status = ?, approved_by = ?, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?''',
                (status.lower(), approved_by, leave_id),
            )
            conn.commit()
        return cursor.rowcount > 0
    except Exception as e:
        logger.error(f"Failed to update leave {leave_id}: {e}")
        return False


def delete_leave_request(leave_id: int) -> bool:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('DELETE FROM leave_requests WHERE id = ?', (leave_id,))
            conn.commit()
        return cursor.rowcount > 0
    except Exception as e:
        logger.error(f"Failed to delete leave {leave_id}: {e}")
        return False


# ── Overtime ───────────────────────────────────────────────────────────────────

def get_overtime(
    user_id: int = None,
    status: str = None,
    branch_id: int = None,
    organization_id: int = None,
) -> List[Dict]:
    try:
        ensure_staff_api_columns()

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            query = """
                SELECT
                    ot.id, ot.user_id,
                    COALESCE(u.name, ot.user_name) AS user_name,
                    ot.ot_date, ot.hours, ot.reason, ot.status, ot.approved_by,
                    ot.created_at, ot.updated_at,
                    u.branch_id, u.branch_name, u.department, u.organization_id
                FROM overtime ot
                LEFT JOIN users u ON u.id = ot.user_id
            """

            filters = []
            params = []

            if user_id is not None:
                filters.append("ot.user_id = ?")
                params.append(int(user_id))
            if status:
                filters.append("LOWER(ot.status) = ?")
                params.append(str(status).lower())
            if branch_id is not None:
                filters.append("u.branch_id = ?")
                params.append(int(branch_id))
            if organization_id is not None:
                filters.append("u.organization_id = ?")
                params.append(int(organization_id))

            if filters:
                query += " WHERE " + " AND ".join(filters)
            query += " ORDER BY ot.created_at DESC"

            cursor.execute(query, tuple(params))
            rows = cursor.fetchall()

        return [
            {
                "id": r[0], "user_id": r[1], "user_name": r[2], "name": r[2],
                "ot_date": r[3], "hours": float(r[4]) if r[4] is not None else 0.0,
                "reason": r[5], "status": r[6], "approved_by": r[7],
                "created_at": r[8], "updated_at": r[9],
                "branch_id": r[10], "branch_name": r[11] or "",
                "department": r[12] or "", "organization_id": r[13],
            }
            for r in rows
        ]

    except Exception as e:
        logger.error(f"Failed to get overtime records: {e}")
        return []

def add_overtime(
    user_id: int,
    user_name: str,
    ot_date: str,
    hours: float,
    reason: str,
) -> Optional[int]:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''INSERT INTO overtime
                   (user_id, user_name, ot_date, hours, reason, status)
                   VALUES (?, ?, ?, ?, ?, ?)''',
                (user_id, user_name, ot_date, hours, reason, 'pending'),
            )
            conn.commit()
            return cursor.lastrowid
    except Exception as e:
        logger.error(f"Failed to add overtime for user {user_id}: {e}")
        return None


def update_overtime_status(ot_id: int, status: str, approved_by: str) -> bool:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''UPDATE overtime
                   SET status = ?, approved_by = ?, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?''',
                (status.lower(), approved_by, ot_id),
            )
            conn.commit()
        return cursor.rowcount > 0
    except Exception as e:
        logger.error(f"Failed to update overtime {ot_id}: {e}")
        return False


# ── Salary ─────────────────────────────────────────────────────────────────────

def get_all_salary_configs(
    organization_id: int = None,
    branch_id: int = None,
) -> List[Dict]:
    try:
        ensure_staff_api_columns()

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            filters = []
            params = []

            if organization_id is not None:
                filters.append("u.organization_id = ?")
                params.append(int(organization_id))
            if branch_id is not None:
                filters.append("u.branch_id = ?")
                params.append(int(branch_id))

            where_sql = f"WHERE {' AND '.join(filters)}" if filters else ""

            cursor.execute(
                f"""
                SELECT
                    sc.id, sc.user_id, u.name, u.department,
                    u.branch_id, u.branch_name,
                    sc.basic_salary, sc.allowances, sc.deductions,
                    sc.ot_rate, sc.effective_from, sc.updated_at
                FROM salary_configs sc
                LEFT JOIN users u ON sc.user_id = u.id
                {where_sql}
                ORDER BY u.name COLLATE NOCASE ASC
                """,
                tuple(params),
            )
            rows = cursor.fetchall()

        return [
            {
                "id": r[0], "user_id": r[1], "name": r[2] or "Unknown",
                "department": r[3] or "", "branch_id": r[4], "branch_name": r[5] or "",
                "basic_salary": float(r[6] or 0), "allowances": float(r[7] or 0),
                "deductions": float(r[8] or 0), "ot_rate": float(r[9] or 0),
                "effective_from": r[10], "updated_at": r[11],
                "net_pay": float((r[6] or 0) + (r[7] or 0) - (r[8] or 0)),
            }
            for r in rows
        ]
    except Exception as e:
        logger.error(f"Failed to get salary configs: {e}")
        return []

def get_salary_config(user_id: int) -> Optional[Dict]:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''SELECT id, user_id, basic_salary, allowances, deductions,
                          ot_rate, effective_from, updated_at
                   FROM salary_configs WHERE user_id = ?''',
                (user_id,),
            )
            row = cursor.fetchone()
        if not row:
            return None
        return {
            'id': row[0], 'user_id': row[1],
            'basic_salary': float(row[2] or 0), 'allowances': float(row[3] or 0),
            'deductions': float(row[4] or 0), 'ot_rate': float(row[5] or 0),
            'effective_from': row[6], 'updated_at': row[7],
        }
    except Exception as e:
        logger.error(f"Failed to get salary config for user {user_id}: {e}")
        return None


def set_salary_config(
    user_id: int,
    basic_salary: float = 0.0,
    allowances: float = 0.0,
    deductions: float = 0.0,
    ot_rate: float = 0.0,
    effective_from: str = None,
) -> bool:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT id FROM salary_configs WHERE user_id = ?', (user_id,))
            if cursor.fetchone():
                cursor.execute(
                    '''UPDATE salary_configs
                       SET basic_salary = ?, allowances = ?, deductions = ?,
                           ot_rate = ?, effective_from = ?,
                           updated_at = CURRENT_TIMESTAMP
                       WHERE user_id = ?''',
                    (basic_salary, allowances, deductions, ot_rate, effective_from, user_id),
                )
            else:
                cursor.execute(
                    '''INSERT INTO salary_configs
                       (user_id, basic_salary, allowances, deductions, ot_rate, effective_from)
                       VALUES (?, ?, ?, ?, ?, ?)''',
                    (user_id, basic_salary, allowances, deductions, ot_rate, effective_from),
                )
            conn.commit()
        return True
    except Exception as e:
        logger.error(f"Failed to set salary config for user {user_id}: {e}")
        return False

def ensure_control_plane_tables() -> bool:
    """Creates support/control-plane tables inside attendance.db.

    ARCH §8: organizations now includes attendance_mode,
    node_offline_threshold_seconds, and max_branches as required by the spec.
    These are added via ALTER TABLE migration so existing installs are safe.
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            user_migrations = [
                "ALTER TABLE users ADD COLUMN organization_id INTEGER",
                "ALTER TABLE users ADD COLUMN company_logo TEXT",
            ]
            for sql in user_migrations:
                try:
                    cursor.execute(sql)
                except sqlite3.OperationalError:
                    pass

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS organizations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    biz_type TEXT,
                    tagline TEXT,
                    address TEXT,
                    size TEXT,
                    logo TEXT,
                    db_path TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    branch_count INTEGER DEFAULT 0,
                    module_count INTEGER DEFAULT 0,
                    status TEXT DEFAULT 'active',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

            # One-time rename for local SQLite installs that already applied
            # the old migration (Phase 1 backend rename: minutes -> seconds
            # scale). SQLite 3.25+ supports RENAME COLUMN natively. On installs
            # where it fails (column already renamed, or pre-3.25 SQLite), this
            # is a safe no-op — nothing else in this codebase reads the old
            # column name.
            try:
                cursor.execute(
                    "ALTER TABLE organizations "
                    "RENAME COLUMN node_offline_threshold_mins TO node_offline_threshold_seconds"
                )
                conn.commit()
                logger.info(
                    "✓ Migration: renamed node_offline_threshold_mins -> node_offline_threshold_seconds."
                )
            except sqlite3.OperationalError:
                pass

           
            # ARCH §8: add spec-required columns to organizations.
            # attendance_mode controls the entire CCTV/node pipeline.
            # node_offline_threshold_seconds triggers automatic fallback.
            # max_branches enforces the per-client branch ceiling.
            org_migrations = [
                "ALTER TABLE organizations ADD COLUMN employee_retention_years INTEGER DEFAULT 5",
                "ALTER TABLE organizations ADD COLUMN retention_policy_updated_at TEXT",
                "ALTER TABLE organizations ADD COLUMN retention_policy_updated_by INTEGER",
                "ALTER TABLE organizations ADD COLUMN attendance_mode TEXT DEFAULT 'cloud'",
                "ALTER TABLE organizations ADD COLUMN node_offline_threshold_seconds INTEGER",
                "ALTER TABLE organizations ADD COLUMN max_branches INTEGER DEFAULT 1",

                # Vertical/template architecture migration.
                # These columns are support-owned and client-read-only.
                "ALTER TABLE organizations ADD COLUMN business_type TEXT DEFAULT 'company'",
                "ALTER TABLE organizations ADD COLUMN primary_people_type TEXT DEFAULT 'staff'",
                "ALTER TABLE organizations ADD COLUMN enabled_people_types TEXT DEFAULT '[\"staff\"]'",
                "ALTER TABLE organizations ADD COLUMN vertical_config TEXT DEFAULT '{}'",
            ]
            for sql in org_migrations:
                try:
                    cursor.execute(sql)
                except sqlite3.OperationalError:
                    pass

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS organization_modules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    organization_id INTEGER NOT NULL,
                    module_key TEXT NOT NULL,
                    enabled INTEGER DEFAULT 1,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(organization_id, module_key),
                    FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
                )
                """
            )

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS organization_admins (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    organization_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    role TEXT DEFAULT 'owner',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(organization_id, user_id),
                    FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS organization_billing (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    organization_id INTEGER NOT NULL UNIQUE,
                    plan_name TEXT DEFAULT 'trial',
                    billing_status TEXT DEFAULT 'trial',
                    contact_email TEXT,
                    contact_phone TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
                )
                """
            )

            cursor.execute("CREATE INDEX IF NOT EXISTS idx_org_slug ON organizations(slug)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_org_status ON organizations(status)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_org_admin_user ON organization_admins(user_id)")
            conn.commit()

        global _CONTROL_PLANE_TABLES_LOGGED
        if not _CONTROL_PLANE_TABLES_LOGGED:
            logger.info("✓ Control-plane organization tables ready")
            _CONTROL_PLANE_TABLES_LOGGED = True
        return True
    except Exception as e:
        logger.error(f"Failed to initialize control-plane tables: {e}")
        return False


def _json_load_or_empty(value):
    try:
        return json.loads(value) if value else {}
    except Exception:
        return {}
    
def _json_load_or_default(value, fallback):
    try:
        if value is None:
            return fallback
        if isinstance(value, (dict, list)):
            return value
        if isinstance(value, str) and value.strip():
            return json.loads(value)
        return fallback
    except Exception:
        return fallback


def _normalize_org_vertical_fields(org: Dict) -> Dict:
    """
    Ensure old organizations get company/staff defaults without breaking.
    """
    if not org:
        return org

    business_type = (
        org.get("business_type")
        or org.get("biz_type")
        or "company"
    )

    vertical_config = _json_load_or_default(
        org.get("vertical_config"),
        build_vertical_config(business_type),
    )

    enabled_people_types = _json_load_or_default(
        org.get("enabled_people_types"),
        vertical_config.get("enabled_people_types") or ["staff"],
    )

    org["business_type"] = business_type
    org["biz_type"] = org.get("biz_type") or business_type
    org["primary_people_type"] = (
        org.get("primary_people_type")
        or vertical_config.get("primary_people_type")
        or "staff"
    )
    org["enabled_people_types"] = enabled_people_types
    org["vertical_config"] = vertical_config

    return org

def update_organization_template_local(
    organization_id: int,
    business_type: str,
) -> Optional[Dict]:
    """
    Local SQLite support-owned template update.
    Used only for legacy/local organization records.
    """
    ensure_control_plane_tables()

    payload = normalize_vertical_payload({"business_type": business_type})

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE organizations
                SET business_type = ?,
                    biz_type = ?,
                    primary_people_type = ?,
                    enabled_people_types = ?,
                    vertical_config = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    payload["business_type"],
                    payload["biz_type"],
                    payload["primary_people_type"],
                    json.dumps(payload["enabled_people_types"], ensure_ascii=False),
                    json.dumps(payload["vertical_config"], ensure_ascii=False),
                    int(organization_id),
                ),
            )

            if cursor.rowcount == 0:
                conn.rollback()
                return None

            conn.commit()

        return get_organization_by_id(int(organization_id))

    except Exception as e:
        logger.error(f"Failed to update local organization template {organization_id}: {e}")
        return None

def _row_to_organization(row) -> Optional[Dict]:
    if not row:
        return None

    # Backward-compatible row unpacking.
    # Old SELECTs may return 15 columns.
    # New SELECTs should return 19 columns.
    row = list(row)

    org_id = row[0]
    slug = row[1]
    name = row[2]
    biz_type = row[3]
    tagline = row[4]
    address = row[5]
    size = row[6]
    logo = row[7]
    db_path = row[8]
    config_json = row[9]
    branch_count = row[10]
    module_count = row[11]
    status = row[12]
    created_at = row[13]
    updated_at = row[14]

    business_type = row[15] if len(row) > 15 else biz_type or "company"
    primary_people_type = row[16] if len(row) > 16 else "staff"
    enabled_people_types = row[17] if len(row) > 17 else '["staff"]'
    vertical_config = row[18] if len(row) > 18 else "{}"

    org = {
        "id": org_id,
        "slug": slug,
        "name": name,
        "biz_type": biz_type or business_type,
        "tagline": tagline,
        "address": address,
        "size": size,
        "logo": logo,
        "db_path": db_path,
        "config": _json_load_or_empty(config_json),
        "config_json": config_json,
        "branch_count": int(branch_count or 0),
        "module_count": int(module_count or 0),
        "status": status,
        "created_at": created_at,
        "updated_at": updated_at,

        # New vertical/template architecture fields.
        "business_type": business_type or biz_type or "company",
        "primary_people_type": primary_people_type or "staff",
        "enabled_people_types": _json_load_or_default(enabled_people_types, ["staff"]),
        "vertical_config": _json_load_or_default(
            vertical_config,
            build_vertical_config(business_type or biz_type or "company"),
        ),
    }

    return _normalize_org_vertical_fields(org)

def organization_slug_exists(slug: str) -> bool:
    ensure_control_plane_tables()
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT 1 FROM organizations WHERE slug = ? LIMIT 1", (slug,))
            return cursor.fetchone() is not None
    except Exception as e:
        logger.error(f"Failed checking org slug '{slug}': {e}")
        return True


def reserve_unique_org_slug(base_slug: str) -> str:
    ensure_control_plane_tables()
    candidate = base_slug
    i = 2
    while organization_slug_exists(candidate):
        candidate = f"{base_slug}-{i}"
        i += 1
    return candidate


def create_organization_record(data: Dict) -> Optional[int]:
    """Inserts the control-plane organization record and enabled modules."""
    ensure_control_plane_tables()
    data = normalize_vertical_payload(data)
    config = data.get("config") or {}
    modules = config.get("modules") if isinstance(config.get("modules"), list) else []

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO organizations (
                    slug, name, biz_type, tagline, address, size, logo, db_path,
                    config_json, branch_count, module_count, status,
                    business_type, primary_people_type, enabled_people_types, vertical_config
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data["slug"], data["name"], data.get("biz_type") or data.get("business_type"),
                    data.get("tagline", ""), data.get("address", ""),
                    data.get("size", ""), data.get("logo"), data["db_path"],
                    json.dumps(config, ensure_ascii=False),
                    int(data.get("branch_count", 0) or 0),
                    int(data.get("module_count", 0) or 0),
                    data.get("status", "active"),
                    data.get("business_type", "company"),
                    data.get("primary_people_type", "staff"),
                    json.dumps(data.get("enabled_people_types") or ["staff"], ensure_ascii=False),
                    json.dumps(data.get("vertical_config") or build_vertical_config(data.get("business_type")), ensure_ascii=False),
                )
            )
            org_id = cursor.lastrowid

            for module_key in modules:
                cursor.execute(
                    """
                    INSERT OR IGNORE INTO organization_modules
                        (organization_id, module_key, enabled)
                    VALUES (?, ?, 1)
                    """,
                    (org_id, str(module_key)),
                )

            cursor.execute(
                """
                INSERT OR IGNORE INTO organization_billing
                    (organization_id, plan_name, billing_status)
                VALUES (?, 'trial', 'trial')
                """,
                (org_id,),
            )

            conn.commit()

        logger.info(f"✓ Organization '{data['name']}' created in control plane (ID: {org_id})")
        return int(org_id)
    except Exception as e:
        logger.error(f"Failed to create organization record: {e}")
        raise


def assign_user_to_organization(user_id: int, organization_id: int) -> bool:
    ensure_control_plane_tables()
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR IGNORE INTO organization_admins
                    (organization_id, user_id, role)
                VALUES (?, ?, 'owner')
                """,
                (organization_id, user_id),
            )
            cursor.execute(
                "UPDATE users SET organization_id = ? WHERE id = ?",
                (organization_id, user_id),
            )
            conn.commit()

        logger.info(f"✓ User {user_id} linked to organization {organization_id}")
        return True
    except Exception as e:
        logger.error(f"Failed linking user {user_id} to org {organization_id}: {e}")
        return False


def get_organization_by_id(organization_id: int) -> Optional[Dict]:
    ensure_control_plane_tables()
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, slug, name, biz_type, tagline, address, size, logo,
                    db_path, config_json, branch_count, module_count, status,
                    created_at, updated_at,
                    business_type, primary_people_type, enabled_people_types, vertical_config
                FROM organizations
                WHERE id = ?
                """,
                (organization_id,),
            )
            return _row_to_organization(cursor.fetchone())
    except Exception as e:
        logger.error(f"Failed to fetch org {organization_id}: {e}")
        return None

def get_organization_attendance_mode(organization_id: int) -> str:
    """Return the attendance_mode for a legacy SQLite organization.

    ARCH §2: attendance_mode is set by QIntellect Support Dashboard at
    onboarding time and determines the entire CCTV/node pipeline.
    Returns 'cloud' as a safe default if the column is missing (older install).
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT attendance_mode FROM organizations WHERE id = ?",
                (int(organization_id),),
            )
            row = cursor.fetchone()
        if not row or not row[0]:
            return 'cloud'
        return str(row[0]).lower()
    except Exception as e:
        logger.error(f"Failed to get attendance_mode for org {organization_id}: {e}")
        return 'cloud'


def _camera_status(value) -> str:
    raw = str(value or "Configured").lower()
    if "offline" in raw:
        return "Offline"
    if "error" in raw:
        return "Error"
    if "alert" in raw:
        return "Alert"
    if "online" in raw:
        return "Online"
    return "Configured"


def _safe_json_loads(value, fallback):
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str) or not value.strip():
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def _normalize_camera(raw: Dict, branch: Dict = None) -> Dict:
    branch = branch or {}

    raw_id = (
        raw.get("id") or raw.get("camera_id") or raw.get("cameraId") or raw.get("key")
    )
    branch_id = (
        raw.get("branchId") or raw.get("branch_id") or branch.get("id")
    )
    camera_id = str(
        raw_id or f"cam_{branch_id or 'global'}_{abs(hash(json.dumps(raw, sort_keys=True, default=str))) % 100000}"
    )
    branch_name = (
        raw.get("branchName") or raw.get("branch_name") or branch.get("name")
        or (f"Branch {branch_id}" if branch_id else "")
    )
    name = (
        raw.get("cameraName") or raw.get("camera_name") or raw.get("name") or "Camera"
    )
    rtsp_url = (
        raw.get("rtspUrl") or raw.get("rtsp_url") or raw.get("url") or raw.get("stream_url")
    )

    normalized_branch_id = None
    try:
        normalized_branch_id = int(branch_id) if branch_id is not None else None
    except (TypeError, ValueError):
        normalized_branch_id = None

    return {
        "id": camera_id,
        "camera_id": camera_id,
        "branch_id": normalized_branch_id,
        "branchId": normalized_branch_id,
        "branch_name": branch_name,
        "branchName": branch_name,
        "name": name,
        "camera_name": name,
        "cameraName": name,
        "location": raw.get("location") or "Unassigned",
        "rtsp_url": rtsp_url,
        "rtspUrl": rtsp_url,
        "has_url": bool(str(rtsp_url or "").strip()),
        "stream_path": f"/stream/{camera_id}",
        "streamPath": f"/stream/{camera_id}",
        "stream_url": f"/api/stream/{camera_id}",
        "streamUrl": f"/api/stream/{camera_id}",
        "status": _camera_status(raw.get("status")),
        "last_seen": raw.get("lastSeen") or raw.get("last_seen"),
        "lastSeen": raw.get("lastSeen") or raw.get("last_seen"),
        "error": raw.get("error"),
    }


def _extract_cameras_from_org_config(config: Dict) -> List[Dict]:
    config = config or {}
    branches = config.get("branches") if isinstance(config.get("branches"), list) else []

    branches_by_id = {}
    for branch in branches:
        if not isinstance(branch, dict):
            continue
        branch_id = branch.get("id") or branch.get("branchId") or branch.get("branch_id")
        if branch_id is None:
            continue
        try:
            branches_by_id[int(branch_id)] = branch
        except (TypeError, ValueError):
            continue

    cameras = []
    raw_cameras = config.get("cameras")

    if isinstance(raw_cameras, dict):
        for branch_key, branch_cameras in raw_cameras.items():
            try:
                branch_id = int(branch_key)
            except (TypeError, ValueError):
                branch_id = None
            branch = branches_by_id.get(branch_id, {"id": branch_id})
            if isinstance(branch_cameras, list):
                for camera in branch_cameras:
                    if isinstance(camera, dict):
                        cameras.append(_normalize_camera(camera, branch))

    elif isinstance(raw_cameras, list):
        for camera in raw_cameras:
            if not isinstance(camera, dict):
                continue
            branch_id = camera.get("branchId") or camera.get("branch_id")
            branch = {}
            if branch_id is not None:
                try:
                    branch = branches_by_id.get(int(branch_id), {})
                except (TypeError, ValueError):
                    branch = {}
            cameras.append(_normalize_camera(camera, branch))

    for branch in branches:
        if not isinstance(branch, dict):
            continue
        for source_key in ("cameras", "cctvCameras", "cameraList", "rtspCameras"):
            source = branch.get(source_key)
            if not isinstance(source, list):
                continue
            for camera in source:
                if isinstance(camera, dict):
                    cameras.append(_normalize_camera(camera, branch))

    deduped = {}
    for camera in cameras:
        camera_id = str(camera.get("id") or "")
        if camera_id:
            deduped[camera_id] = camera

    return list(deduped.values())


def get_cameras(organization_id: int, branch_id: int = None) -> List[Dict]:
    """Return configured cameras from backend organization config."""
    try:
        ensure_control_plane_tables()

        org = get_organization_by_id(int(organization_id))
        if not org:
            return []

        config = _safe_json_loads(
            org.get("config") or org.get("config_json") or org.get("settings") or {},
            {}
        )
        cameras = _extract_cameras_from_org_config(config)

        if branch_id is not None:
            scoped = []
            for camera in cameras:
                camera_branch_id = camera.get("branch_id")
                if camera_branch_id is None:
                    scoped.append(camera)
                    continue
                try:
                    if int(camera_branch_id) == int(branch_id):
                        scoped.append(camera)
                except (TypeError, ValueError):
                    pass
            cameras = scoped

        return cameras

    except Exception as e:
        logger.error(f"Failed to get cameras for org={organization_id}: {e}")
        return []


def get_camera_by_id(camera_id: str, organization_id: int = None) -> Optional[Dict]:
    """Resolve one configured camera by ID."""
    try:
        ensure_control_plane_tables()

        if organization_id is not None:
            cameras = get_cameras(organization_id=int(organization_id))
            return next(
                (c for c in cameras if str(c.get("id")) == str(camera_id)),
                None,
            )

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM organizations ORDER BY id DESC LIMIT 1")
            row = cursor.fetchone()

        if not row:
            return None

        cameras = get_cameras(organization_id=int(row[0]))
        return next(
            (c for c in cameras if str(c.get("id")) == str(camera_id)),
            None,
        )

    except Exception as e:
        logger.error(f"Failed to get camera by ID {camera_id}: {e}")
        return None

def get_organization_for_user(user_id: int) -> Optional[Dict]:
    """Return the organization owned/assigned to this exact user."""
    ensure_control_plane_tables()
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return None

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            cursor.execute(
                """
                SELECT o.id, o.slug, o.name, o.biz_type, o.tagline, o.address,
                       o.size, o.logo, o.db_path, o.config_json, o.branch_count,
                       o.module_count, o.status, o.created_at, o.updated_at
                FROM organizations o
                JOIN organization_admins oa ON oa.organization_id = o.id
                WHERE oa.user_id = ?
                ORDER BY o.created_at DESC
                LIMIT 1
                """,
                (uid,),
            )
            org = _row_to_organization(cursor.fetchone())
            if org:
                return org

            cursor.execute(
                "SELECT organization_id FROM users WHERE id = ? LIMIT 1",
                (uid,),
            )
            row = cursor.fetchone()

            if not row or row[0] is None:
                return None

            cursor.execute(
                """
                SELECT id, slug, name, biz_type, tagline, address, size, logo,
                    db_path, config_json, branch_count, module_count, status,
                    created_at, updated_at,
                    business_type, primary_people_type, enabled_people_types, vertical_config
                FROM organizations
                WHERE id = ?
                LIMIT 1
                """,
                (int(row[0]),),
            )
            return _row_to_organization(cursor.fetchone())
    except Exception as e:
        logger.error(f"Failed to fetch org for user {user_id}: {e}")
        return None


def get_user_dashboard_state(user_id: int) -> Dict:
    """Return route/auth readiness flags for one user."""
    ensure_staff_api_columns()

    default = {
        "dashboard_ready": False,
        "dashboardReady": False,
        "requires_onboarding": True,
        "requiresOnboarding": True,
        "organization_id": None,
        "organizationId": None,
        "organization_status": "missing",
        "organizationStatus": "missing",
    }

    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return default

    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, role, active, organization_id, branch_id, access_modules
                FROM users WHERE id = ? LIMIT 1
                """,
                (uid,),
            )
            user = cursor.fetchone()

        if not user:
            return default

        role = str(user["role"] or "staff").lower()
        active = int(user["active"] or 0) == 1
        org = get_organization_for_user(uid)
        org_id = int(org["id"]) if org and org.get("id") else None
        org_status = str(org.get("status") or "missing").lower() if org else "missing"
        org_active = bool(org_id and org_status in {"active", "launched", "trial"})

        if role == "admin":
            ready = bool(active and org_active)
            requires_onboarding = not ready
        elif role == "staff":
            ready = bool(active and org_active and user["branch_id"] is not None)
            requires_onboarding = False
        else:
            ready = False
            requires_onboarding = False

        return {
            "dashboard_ready": ready,
            "dashboardReady": ready,
            "requires_onboarding": requires_onboarding,
            "requiresOnboarding": requires_onboarding,
            "organization_id": org_id,
            "organizationId": org_id,
            "organization_status": org_status,
            "organizationStatus": org_status,
        }
    except Exception as e:
        logger.error(f"Failed to resolve dashboard state for user {user_id}: {e}")
        return default


def get_latest_organization() -> Optional[Dict]:
    ensure_control_plane_tables()
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, slug, name, biz_type, tagline, address, size, logo,
                    db_path, config_json, branch_count, module_count, status,
                    created_at, updated_at,
                    business_type, primary_people_type, enabled_people_types, vertical_config
                FROM organizations
                ORDER BY created_at DESC
                LIMIT 1
                """
            )
            return _row_to_organization(cursor.fetchone())
    except Exception as e:
        logger.error(f"Failed to fetch latest organization: {e}")
        return None


# ── Phase 2B — Staff API single source of truth helpers ─────────────────────

_STAFF_API_COLUMNS = [
    'id', 'name', 'email', 'phone', 'department',
    'enrollment_date', 'created_at', 'active', 'notes', 'photo_path',
    'password', 'role', 'cnic', 'position', 'salary', 'benefits', 'join_date',
    'shift', 'duty_start', 'duty_end', 'staff_type', 'access_modules',
    'assigned_location', 'location_lat', 'location_lng',
    'geofence_radius', 'is_face_verified',
    'organization_id', 'company_logo', 'branch_id', 'branch_name',
    'employee_id', 'status', 'shift_id', 'shift_label',
    'profile_image_url', 'profile_image_name',
    'training_video_url', 'training_video_name',
    'attendance_enabled',
]


def ensure_staff_api_columns() -> bool:
    """Add staff-directory/API columns without breaking older SQLite installs."""
    ensure_control_plane_tables()

    migrations = [
        "ALTER TABLE users ADD COLUMN organization_id INTEGER",
        "ALTER TABLE users ADD COLUMN company_logo TEXT",
        "ALTER TABLE users ADD COLUMN branch_id INTEGER",
        "ALTER TABLE users ADD COLUMN branch_name TEXT",
        "ALTER TABLE users ADD COLUMN employee_id TEXT",
        "ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'",
        "ALTER TABLE users ADD COLUMN benefits TEXT DEFAULT '[]'",
        "ALTER TABLE users ADD COLUMN shift_id TEXT",
        "ALTER TABLE users ADD COLUMN shift_label TEXT",
        "ALTER TABLE users ADD COLUMN profile_image_url TEXT",
        "ALTER TABLE users ADD COLUMN profile_image_name TEXT",
        "ALTER TABLE users ADD COLUMN training_video_url TEXT",
        "ALTER TABLE users ADD COLUMN training_video_name TEXT",
        "ALTER TABLE users ADD COLUMN deleted_at TEXT",
        "ALTER TABLE users ADD COLUMN retention_until TEXT",
        "ALTER TABLE users ADD COLUMN termination_reason TEXT",
        "ALTER TABLE users ADD COLUMN attendance_enabled INTEGER DEFAULT 1",
    ]

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            for sql in migrations:
                try:
                    cursor.execute(sql)
                except sqlite3.OperationalError:
                    pass

            cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_employee_id ON users(employee_id)")
            conn.commit()

        return True
    except Exception as e:
        logger.error(f"Failed to ensure staff API columns: {e}")
        return False


def _json_array(value):
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


def _row_to_staff_api_user(row, columns: List[str]) -> Dict:
    data = dict(zip(columns, row))

    data['access_modules'] = _json_array(data.get('access_modules', '[]'))
    data['benefits'] = _json_array(data.get('benefits', '[]'))
    data['salary'] = float(data['salary']) if data.get('salary') is not None else 0.0
    data['location_lat'] = float(data['location_lat']) if data.get('location_lat') is not None else None
    data['location_lng'] = float(data['location_lng']) if data.get('location_lng') is not None else None
    data['geofence_radius'] = int(data['geofence_radius']) if data.get('geofence_radius') is not None else 100
    data['is_face_verified'] = bool(data.get('is_face_verified', 0))
    data['attendance_enabled'] = bool(data.get('attendance_enabled', 1))

    if data.get('organization_id') is not None:
        data['organization_id'] = int(data['organization_id'])
    if data.get('branch_id') is not None:
        data['branch_id'] = int(data['branch_id'])

    if not data.get('status'):
        data['status'] = 'active' if int(data.get('active') or 0) == 1 else 'inactive'

    if not data.get('employee_id'):
        data['employee_id'] = str(data.get('id'))

    if not data.get('shift_id'):
        data['shift_id'] = str(data.get('shift') or 'morning').lower()

    if not data.get('shift_label'):
        data['shift_label'] = str(data.get('shift') or 'Morning')

    if not data.get('profile_image_url') and data.get('photo_path') and data.get('id'):
        data['profile_image_url'] = f"/api/users/{int(data['id'])}/photo"

    data['profileImageUrl'] = data.get('profile_image_url') or ''
    data['avatarUrl'] = data.get('profile_image_url') or ''
    data['photo_url'] = data.get('profile_image_url') or ''
    data['profileImageName'] = data.get('profile_image_name') or ''

    return data


def _staff_select_columns() -> str:
    return ', '.join(_STAFF_API_COLUMNS)


def get_user_by_id(user_id: int) -> Optional[Dict]:
    """Phase 2B override: retrieve full user record including org/staff fields."""
    ensure_staff_api_columns()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f"SELECT {_staff_select_columns()} FROM users WHERE id = ?",
                (user_id,),
            )
            row = cursor.fetchone()

        if not row:
            return None

        return _row_to_staff_api_user(row, _STAFF_API_COLUMNS)
    except Exception as e:
        logger.error(f"Failed to get user by ID {user_id}: {e}")
        return None


def authenticate_user(email: str, password: str) -> Optional[Dict]:
    """Phase 2B override: login returns org/staff fields too."""
    ensure_staff_api_columns()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT {_staff_select_columns()}
                FROM users
                WHERE email = ? AND password = ? AND active = 1
                """,
                (email, password),
            )
            row = cursor.fetchone()

        if not row:
            return None

        return _row_to_staff_api_user(row, _STAFF_API_COLUMNS)
    except Exception as e:
        logger.error(f"Failed to authenticate user '{email}': {e}")
        return None


def get_all_users(
    role: str = None,
    organization_id: int = None,
    branch_id: int = None,
) -> List[Dict]:
    """Phase 2B override: branch/org-filterable user query for StaffDirectory."""
    ensure_staff_api_columns()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            filters = ["active = 1"]
            params: List = []

            if role:
                filters.append("role = ?")
                params.append(role)
            if organization_id is not None:
                filters.append("organization_id = ?")
                params.append(int(organization_id))
            if branch_id is not None:
                filters.append("branch_id = ?")
                params.append(int(branch_id))

            where_sql = " AND ".join(filters)

            cursor.execute(
                f"""
                SELECT {_staff_select_columns()}
                FROM users
                WHERE {where_sql}
                ORDER BY name COLLATE NOCASE ASC
                """,
                tuple(params),
            )
            rows = cursor.fetchall()

        return [_row_to_staff_api_user(row, _STAFF_API_COLUMNS) for row in rows]
    except Exception as e:
        logger.error(f"Failed to get all users: {e}")
        return []


def add_user(
    name: str,
    email: str = None,
    phone: str = None,
    department: str = None,
    password: str = None,
    role: str = 'staff',
    notes: str = None,
    cnic: str = None,
    position: str = None,
    salary: float = 0.0,
    benefits: str = '[]',
    join_date: str = None,
    shift: str = 'Morning',
    duty_start: str = '09:00',
    duty_end: str = '18:00',
    staff_type: str = 'office',
    access_modules: str = '[]',
    organization_id: int = None,
    branch_id: int = None,
    branch_name: str = None,
    employee_id: str = None,
    status: str = 'active',
    shift_id: str = None,
    shift_label: str = None,
    profile_image_url: str = None,
    profile_image_name: str = None,
    training_video_url: str = None,
    training_video_name: str = None,
) -> Optional[int]:
    """Phase 2B override: add a staff/admin user with org/branch metadata."""
    ensure_staff_api_columns()

    if not name or not name.strip():
        logger.warning("Attempted to add user with empty name")
        return None

    safe_status = status if status in ('active', 'inactive', 'pending') else 'active'

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO users (
                    name, email, phone, department, password, role, notes, cnic, position,
                    salary, benefits, join_date, shift, duty_start, duty_end, staff_type, access_modules,
                    organization_id, branch_id, branch_name, employee_id, status,
                    shift_id, shift_label, profile_image_url, profile_image_name,
                    training_video_url, training_video_name
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name.strip(), email, phone, department, password, role, notes, cnic,
                    position, salary, benefits, join_date, shift, duty_start, duty_end,
                    staff_type, access_modules,
                    organization_id, branch_id, branch_name, employee_id, safe_status,
                    shift_id, shift_label, profile_image_url, profile_image_name,
                    training_video_url, training_video_name,
                ),
            )
            user_id = cursor.lastrowid

            if not employee_id:
                employee_id = f"EMP-{int(user_id):04d}"
                cursor.execute(
                    "UPDATE users SET employee_id = ? WHERE id = ?",
                    (employee_id, user_id),
                )

            conn.commit()

        logger.info(f"✓ User '{name}' created (ID: {user_id})")
        return int(user_id)
    except sqlite3.IntegrityError as e:
        logger.warning(f"User '{name}' already exists or conflicts: {e}")
        return None
    except Exception as e:
        logger.error(f"Failed to add user '{name}': {e}")
        return None


def update_user_fields(user_id: int, data: Dict) -> bool:
    """Flexible staff update used by /api/users/<id>."""
    ensure_staff_api_columns()

    allowed = {
        'name', 'email', 'phone', 'department', 'notes', 'cnic', 'position',
        'salary', 'benefits', 'join_date', 'shift', 'duty_start', 'duty_end',
        'staff_type', 'organization_id', 'branch_id', 'branch_name',
        'employee_id', 'status', 'shift_id', 'shift_label',
        'profile_image_url', 'profile_image_name',
        'training_video_url', 'training_video_name',
        'company_logo', 'attendance_enabled',
    }

    payload = {key: value for key, value in (data or {}).items() if key in allowed}

    if 'name' in payload and (not payload['name'] or not str(payload['name']).strip()):
        return False

    if 'name' in payload:
        payload['name'] = str(payload['name']).strip()

    if 'access_modules' in (data or {}):
        payload['access_modules'] = json.dumps(data.get('access_modules') or [])

    if 'benefits' in (data or {}):
        payload['benefits'] = json.dumps(data.get('benefits') or [])

    if 'status' in payload and payload['status'] not in ('active', 'inactive', 'pending'):
        payload['status'] = 'active'

    if not payload:
        return True

    assignments = ", ".join(f"{key} = ?" for key in payload.keys())
    values = list(payload.values()) + [user_id]

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                f"UPDATE users SET {assignments} WHERE id = ?",
                tuple(values),
            )
            updated = cursor.rowcount > 0
            conn.commit()

        if updated:
            logger.info(f"✓ User ID {user_id} updated through staff API")

        return updated
    except Exception as e:
        logger.error(f"Failed updating staff user {user_id}: {e}")
        return False


def update_user(
    user_id: int,
    name: str,
    email: str = None,
    phone: str = None,
    department: str = None,
    notes: str = None,
    shift: str = None,
    duty_start: str = None,
    duty_end: str = None,
    staff_type: str = None,
    access_modules: str = None,
) -> bool:
    """Backward-compatible wrapper around update_user_fields."""
    data = {
        'name': name,
        'email': email,
        'phone': phone,
        'department': department,
        'notes': notes,
    }

    if shift is not None:
        data['shift'] = shift
    if duty_start is not None:
        data['duty_start'] = duty_start
    if duty_end is not None:
        data['duty_end'] = duty_end
    if staff_type is not None:
        data['staff_type'] = staff_type
    if access_modules is not None:
        try:
            data['access_modules'] = json.loads(access_modules)
        except Exception:
            data['access_modules'] = []

    return update_user_fields(user_id, data)


# ── Branch comparison / summary ───────────────────────────────────────────────

def _branch_config_rows_for_org(organization_id: int) -> List[Dict]:
    """Return normalized branch metadata from organization config_json."""
    if organization_id is None:
        return []
    org = get_organization_by_id(int(organization_id))
    config = org.get("config") if org else {}
    raw_branches = config.get("branches") if isinstance(config, dict) else []

    rows: List[Dict] = []
    if isinstance(raw_branches, list):
        for index, branch in enumerate(raw_branches):
            if not isinstance(branch, dict):
                continue
            try:
                branch_id = int(branch.get("id") or branch.get("branchId") or index + 1)
            except (TypeError, ValueError):
                branch_id = index + 1

            rows.append({
                "branch_id": branch_id,
                "branch_name": str(
                    branch.get("name") or branch.get("branchName") or f"Branch {branch_id}"
                ),
                "branch_city": str(branch.get("city") or branch.get("branchCity") or ""),
            })

    return rows


def get_branch_comparison_summary(
    organization_id: int,
    people_type: str | None = None,
) -> Dict:
    """Return production branch-comparison metrics for the global Branches page."""
    clean_people_type = (
        str(people_type or "").strip().lower() or None
    )
    _empty = {
        "organization_id": organization_id,
        "generated_at": datetime.utcnow().isoformat(),
        "totals": {
            "branches": 0, "staff": 0, "activeStaff": 0, "enrolledStaff": 0,
            "presentToday": 0, "absentToday": 0, "payroll": 0, "late": 0,
            "pendingLeaves": 0, "overtimeHours": 0, "attendanceRate": 0,
        },
        "branches": [],
    }

    if organization_id is None:
        return _empty

    ensure_staff_api_columns()
    organization_id = int(organization_id)

    configured_branches = _branch_config_rows_for_org(organization_id)
    branch_map: Dict[int, Dict] = {
        int(branch["branch_id"]): dict(branch) for branch in configured_branches
    }

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            cursor.execute(
                """
                SELECT DISTINCT branch_id, branch_name
                FROM users
                WHERE organization_id = ? AND branch_id IS NOT NULL
                """,
                (organization_id,),
            )
            for branch_id, branch_name in cursor.fetchall():
                if branch_id is None:
                    continue
                bid = int(branch_id)
                branch_map.setdefault(bid, {
                    "branch_id": bid,
                    "branch_name": branch_name or f"Branch {bid}",
                    "branch_city": "",
                })
                if branch_name and not branch_map[bid].get("branch_name"):
                    branch_map[bid]["branch_name"] = branch_name

            cursor.execute(
                """
                SELECT COALESCE(branch_id, 0) AS branch_id,
                       COUNT(*) AS staff_count,
                       SUM(CASE WHEN COALESCE(status, 'active') = 'active' THEN 1 ELSE 0 END) AS active_staff,
                       SUM(COALESCE(salary, 0)) AS payroll
                FROM users
                WHERE organization_id = ? AND role = 'staff' AND active = 1
                """
                + ("AND LOWER(COALESCE(people_type, 'staff')) = ? " if clean_people_type else "")
                + """
                GROUP BY COALESCE(branch_id, 0)
                """,
                (organization_id, clean_people_type) if clean_people_type else (organization_id,),
            )
            staff_rows = {
                int(row[0]): {
                    "staff_count": int(row[1] or 0),
                    "active_staff": int(row[2] or 0),
                    "payroll": float(row[3] or 0),
                }
                for row in cursor.fetchall()
            }

            cursor.execute(
                """
                SELECT COALESCE(u.branch_id, 0) AS branch_id,
                       COUNT(DISTINCT u.id) AS enrolled_staff
                FROM users u
                JOIN embeddings e ON e.user_id = u.id
                WHERE u.organization_id = ? AND u.role = 'staff' AND u.active = 1
                GROUP BY COALESCE(u.branch_id, 0)
                """,
                (organization_id,),
            )
            enrolled_rows = {int(row[0]): int(row[1] or 0) for row in cursor.fetchall()}

            cursor.execute(
                """
                SELECT COALESCE(u.branch_id, 0) AS branch_id,
                       COUNT(DISTINCT a.user_id) AS present_today,
                       COUNT(DISTINCT CASE
                           WHEN time(a.timestamp) > time(COALESCE(NULLIF(u.duty_start, ''), '09:00'), '+15 minutes')
                           THEN a.user_id
                       END) AS late_count
                FROM attendance a
                JOIN users u ON u.id = a.user_id
                                WHERE u.organization_id = ? AND u.role = 'staff' AND u.active = 1
                                """
                                + ("AND LOWER(COALESCE(u.people_type, 'staff')) = ? " if clean_people_type else "")
                                + """
                                    AND date(a.timestamp) = date('now', 'utc')
                                GROUP BY COALESCE(u.branch_id, 0)
                                """,
                                (organization_id, clean_people_type) if clean_people_type else (organization_id,),
            )
            attendance_rows = {
                int(row[0]): {
                    "present_today": int(row[1] or 0),
                    "late_count": int(row[2] or 0),
                }
                for row in cursor.fetchall()
            }

            cursor.execute(
                """
                SELECT COALESCE(u.branch_id, 0) AS branch_id,
                       COUNT(*) AS pending_leaves
                FROM leave_requests lr
                JOIN users u ON u.id = lr.user_id
                                WHERE u.organization_id = ?
                                """
                                + ("AND LOWER(COALESCE(u.people_type, 'staff')) = ? " if clean_people_type else "")
                                + """
                                    AND LOWER(COALESCE(lr.status, 'pending')) = 'pending'
                                GROUP BY COALESCE(u.branch_id, 0)
                                """,
                                (organization_id, clean_people_type) if clean_people_type else (organization_id,),
            )
            leave_rows = {int(row[0]): int(row[1] or 0) for row in cursor.fetchall()}

            cursor.execute(
                """
                SELECT COALESCE(u.branch_id, 0) AS branch_id,
                       SUM(COALESCE(ot.hours, 0)) AS overtime_hours
                FROM overtime ot
                JOIN users u ON u.id = ot.user_id
                                WHERE u.organization_id = ?
                                """
                                + ("AND LOWER(COALESCE(u.people_type, 'staff')) = ? " if clean_people_type else "")
                                + """
                                    AND date(ot.ot_date) >= date('now', 'start of month')
                                GROUP BY COALESCE(u.branch_id, 0)
                                """,
                                (organization_id, clean_people_type) if clean_people_type else (organization_id,),
            )
            overtime_rows = {int(row[0]): float(row[1] or 0) for row in cursor.fetchall()}

        for bid in set(staff_rows) | set(enrolled_rows) | set(attendance_rows):
            if bid and bid not in branch_map:
                branch_map[bid] = {
                    "branch_id": bid,
                    "branch_name": f"Branch {bid}",
                    "branch_city": "",
                }

        branches = []
        for bid in sorted(branch_map.keys()):
            if bid <= 0:
                continue

            meta = branch_map[bid]
            staff = staff_rows.get(bid, {})
            attendance = attendance_rows.get(bid, {})

            staff_count = int(staff.get("staff_count", 0) or 0)
            active_staff = int(staff.get("active_staff", 0) or 0)
            payroll = float(staff.get("payroll", 0) or 0)
            enrolled_staff = int(enrolled_rows.get(bid, 0) or 0)
            present_today = int(attendance.get("present_today", 0) or 0)
            late_count = int(attendance.get("late_count", 0) or 0)
            absent_today = max(0, staff_count - present_today)
            attendance_rate = round((present_today / staff_count) * 100, 2) if staff_count else 0.0

            branches.append({
                "id": bid, "branchId": bid,
                "name": meta.get("branch_name") or f"Branch {bid}",
                "branchName": meta.get("branch_name") or f"Branch {bid}",
                "city": meta.get("branch_city") or "",
                "branchCity": meta.get("branch_city") or "",
                "staff": staff_count, "staffCount": staff_count,
                "activeStaff": active_staff,
                "enrolledStaff": enrolled_staff,
                "presentToday": present_today,
                "absentToday": absent_today,
                "attendance": attendance_rate,
                "attendanceRate": attendance_rate,
                "payroll": payroll, "revenue": payroll,
                "late": late_count, "lateCount": late_count,
                "pendingLeaves": int(leave_rows.get(bid, 0) or 0),
                "overtimeHours": float(overtime_rows.get(bid, 0) or 0),
            })

        total_staff = sum(item["staffCount"] for item in branches)
        total_present = sum(item["presentToday"] for item in branches)
        totals = {
            "branches": len(branches),
            "staff": total_staff,
            "activeStaff": sum(item["activeStaff"] for item in branches),
            "enrolledStaff": sum(item["enrolledStaff"] for item in branches),
            "presentToday": total_present,
            "absentToday": sum(item["absentToday"] for item in branches),
            "payroll": sum(item["payroll"] for item in branches),
            "late": sum(item["lateCount"] for item in branches),
            "pendingLeaves": sum(item["pendingLeaves"] for item in branches),
            "overtimeHours": sum(item["overtimeHours"] for item in branches),
            "attendanceRate": round((total_present / total_staff) * 100, 2) if total_staff else 0.0,
        }

        return {
            "organization_id": organization_id,
            "generated_at": datetime.utcnow().isoformat(),
            "totals": totals,
            "branches": branches,
        }

    except Exception as e:
        logger.exception(f"Failed to build branch comparison summary for org {organization_id}: {e}")
        return {
            "organization_id": organization_id,
            "generated_at": datetime.utcnow().isoformat(),
            "totals": {
                "branches": 0, "staff": 0, "activeStaff": 0, "enrolledStaff": 0,
                "presentToday": 0, "absentToday": 0, "payroll": 0, "late": 0,
                "pendingLeaves": 0, "overtimeHours": 0, "attendanceRate": 0,
            },
            "branches": [],
        }


if __name__ == '__main__':
    init_db()