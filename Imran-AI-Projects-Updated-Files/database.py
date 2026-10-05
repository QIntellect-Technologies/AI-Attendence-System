import sqlite3
import json
import os
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional, Tuple
from logger_config import get_logger
from config import DB_PATH, ATTENDANCE_LOG_RETENTION_DAYS

logger = get_logger(__name__)


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

            # Automatic Migration: Add optional columns if they don't exist
            for col, col_type in [
                ("photo_path", "TEXT"),
                ("password", "TEXT DEFAULT '123456'"),
                ("role", "TEXT DEFAULT 'staff'"),
                ("cnic", "TEXT"),
                ("position", "TEXT"),
                ("salary", "REAL DEFAULT 0"),
                ("join_date", "TEXT")
            ]:
                try:
                    cursor.execute(f"ALTER TABLE users ADD COLUMN {col} {col_type}")
                    conn.commit()
                except sqlite3.OperationalError:
                    pass

            # Embeddings table
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

            # Attendance logs
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

            # Manual absent overrides for today
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS manual_absent (
                    user_id INTEGER NOT NULL,
                    date TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY(user_id, date),
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')

            # Persistent room-presence snapshots, throttled by the app to one per user every five minutes.
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS locator_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    department TEXT,
                    camera_id TEXT NOT NULL,
                    camera_name TEXT NOT NULL,
                    room_name TEXT NOT NULL,
                    confidence REAL DEFAULT 0,
                    first_seen TEXT,
                    last_seen TEXT,
                    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')

            # Leave requests table
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS leave_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    user_name TEXT,
                    leave_type TEXT NOT NULL,
                    start_date TEXT NOT NULL,
                    end_date TEXT NOT NULL,
                    reason TEXT,
                    status TEXT DEFAULT 'pending',
                    approved_by TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')

            # Overtime table
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS overtime (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    user_name TEXT,
                    ot_date TEXT NOT NULL,
                    hours REAL NOT NULL,
                    reason TEXT,
                    status TEXT DEFAULT 'pending',
                    approved_by TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')

            # Salary configs table
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS salary_configs (
                    user_id INTEGER PRIMARY KEY,
                    basic_salary REAL DEFAULT 0,
                    allowances REAL DEFAULT 0,
                    deductions REAL DEFAULT 0,
                    ot_rate REAL DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')

            # Create indexes for performance
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_users_name ON users(name)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_users_active ON users(active)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_embeddings_user ON embeddings(user_id)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_attendance_timestamp ON attendance(timestamp)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_attendance_source ON attendance(source)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_manual_absent_user_date ON manual_absent(user_id, date)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_locator_history_user_time ON locator_history(user_id, recorded_at)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_locator_history_room_time ON locator_history(room_name, recorded_at)')

            conn.commit()
            
        logger.info(f"✓ Database initialized at {DB_PATH}")
        return True
    except Exception as e:
        logger.error(f"✗ Database initialization failed: {e}")
        return False


def add_user(
    name: str,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    department: Optional[str] = None,
    password: str = '123456',
    role: str = 'staff',
    notes: str = '',
    cnic: str = '',
    position: str = '',
    salary: float = 0,
    join_date: str = ''
) -> Optional[int]:
    """Add a new user with validation and optional HR profile attributes."""
    if not name or len(name.strip()) == 0:
        logger.warning("Attempted to add user with empty name")
        return None

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''INSERT INTO users 
                   (name, email, phone, department, password, role, notes, cnic, position, salary, join_date) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (name.strip(), email, phone, department, password, role, notes, cnic, position, salary, join_date)
            )
            conn.commit()
            user_id = cursor.lastrowid

        logger.info(f"✓ User '{name}' created (ID: {user_id})")
        return user_id
    except sqlite3.IntegrityError:
        logger.warning(f"User '{name}' or email already exists")
        return None
    except Exception as e:
        logger.error(f"Failed to add user: {e}")
        return None


def get_user_by_name(name: str) -> Optional[Dict]:
    """Retrieve user by name."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT id, name, email FROM users WHERE name = ?', (name,))
            row = cursor.fetchone()
            
        if row:
            return {'id': row[0], 'name': row[1], 'email': row[2]}
    except Exception as e:
        logger.error(f"Failed to fetch user by name: {e}")
    return None


def get_all_users(role: Optional[str] = None) -> List[Dict]:
    """Get all active users with today's attendance status via optimized join."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT u.id, u.name, u.email, u.phone, u.department, u.enrollment_date, 
                       u.created_at, u.active, u.notes, u.photo_path,
                       CASE 
                           WHEN ma.user_id IS NOT NULL THEN 'Absent'
                           WHEN a.user_id IS NOT NULL THEN 'Present'
                           ELSE 'Absent'
                       END as status_today
                FROM users u
                LEFT JOIN (
                    SELECT DISTINCT user_id 
                    FROM attendance 
                    WHERE date(timestamp, 'localtime') = date('now', 'localtime')
                ) a ON u.id = a.user_id
                LEFT JOIN (
                    SELECT DISTINCT user_id
                    FROM manual_absent
                    WHERE date = date('now', 'localtime')
                ) ma ON u.id = ma.user_id
                WHERE u.active = 1
            ''')
            rows = cursor.fetchall()
            
        return [{
            'id': r[0], 'name': r[1], 'email': r[2], 'phone': r[3],
            'department': r[4], 'enrollment_date': r[5], 'created_at': r[6],
            'active': r[7], 'notes': r[8], 'photo_path': r[9], 'status_today': r[10]
        } for r in rows]
    except Exception as e:
        logger.error(f"Failed to get all users: {e}")
        return []


def update_user(user_id: int, name: str, email: str | None = None, phone: str | None = None, department: str | None = None, notes: str | None = None) -> bool:
    """Update user information in database."""
    if not name or len(name.strip()) == 0:
        logger.warning("Attempted to update user with empty name")
        return False
        
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                UPDATE users 
                SET name = ?, email = ?, phone = ?, department = ?, notes = ?
                WHERE id = ?
            ''', (name.strip(), email, phone, department, notes, user_id))
            updated = cursor.rowcount > 0
            conn.commit()
            
        if updated:
            logger.info(f"✓ User ID {user_id} updated: {name}")
        return updated
    except Exception as e:
        logger.error(f"Failed to update user ID {user_id}: {e}")
        return False


def delete_user(user_id: int) -> bool:
    """Delete a user, associated embeddings and logs cascade automatically."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("PRAGMA foreign_keys = ON")
            cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
            deleted = cursor.rowcount > 0
            conn.commit()
            
        if deleted:
            logger.info(f"✓ User ID {user_id} deleted successfully with related data.")
        return deleted
    except Exception as e:
        logger.error(f"Failed to delete user ID {user_id}: {e}")
        return False


def store_embedding(user_id: int, embedding: List[float], source_video: str | None = None):
    """Store face embedding for a user."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            embedding_blob = json.dumps(embedding).encode()
            cursor.execute(
                'INSERT INTO embeddings (user_id, embedding, source_video) VALUES (?, ?, ?)',
                (user_id, embedding_blob, source_video)
            )
            conn.commit()
    except Exception as e:
        logger.error(f"Failed to store embedding for user {user_id}: {e}")


def get_embeddings_for_user(user_id: int) -> List[Dict]:
    """Retrieve all embeddings for a user."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                'SELECT id, embedding, source_video, created_at FROM embeddings WHERE user_id = ?',
                (user_id,)
            )
            rows = cursor.fetchall()
            
        return [{
            'id': row[0],
            'embedding': json.loads(row[1].decode()),
            'source_video': row[2],
            'created_at': row[3]
        } for row in rows]
    except Exception as e:
        logger.error(f"Failed to get embeddings for user {user_id}: {e}")
        return []


def log_attendance(user_id: int, detected_name: str, confidence: float, source: str = 'camera', location: str | None = None, device_id: str | None = None):
    """Log attendance detection with room location and camera device ID."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                'DELETE FROM manual_absent WHERE user_id = ? AND date = date("now", "localtime")',
                (user_id,)
            )
            cursor.execute(
                '''INSERT INTO attendance (user_id, detected_name, confidence, source, location, device_id) 
                   VALUES (?, ?, ?, ?, ?, ?)''',
                (user_id, detected_name, confidence, source, location, device_id)
            )
            conn.commit()
    except Exception as e:
        logger.error(f"Failed to log attendance for user {user_id}: {e}")


def get_latest_user_location(user_id: int) -> Optional[Dict]:
    """Get the most recent location/room detection log for a user from database history."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT location, device_id, timestamp, confidence, source
                FROM attendance
                WHERE user_id = ? AND location IS NOT NULL AND location != ''
                ORDER BY timestamp DESC LIMIT 1
            ''', (user_id,))
            row = cursor.fetchone()
            if row:
                return {
                    'location': row[0],
                    'device_id': row[1],
                    'timestamp': row[2],
                    'confidence': row[3],
                    'source': row[4]
                }
    except Exception as e:
        logger.error(f"Failed to fetch latest location for user {user_id}: {e}")
    return None


def record_locator_snapshot(user_id: int, name: str, department: str, camera_id: str,
                            camera_name: str, room_name: str, confidence: float,
                            first_seen: float, last_seen: float, interval_seconds: int = 300) -> bool:
    """Persist at most one room snapshot per user during each five-minute interval."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT recorded_at FROM locator_history
                WHERE user_id = ?
                ORDER BY recorded_at DESC LIMIT 1
            ''', (user_id,))
            row = cursor.fetchone()
            if row:
                cursor.execute("SELECT (julianday('now', 'localtime') - julianday(?)) * 86400", (row[0],))
                elapsed = cursor.fetchone()[0] or 0
                if elapsed < interval_seconds:
                    return False

            cursor.execute('''
                INSERT INTO locator_history
                    (user_id, name, department, camera_id, camera_name, room_name,
                     confidence, first_seen, last_seen, recorded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch', 'localtime'),
                        datetime(?, 'unixepoch', 'localtime'), datetime('now', 'localtime'))
            ''', (user_id, name, department or '', camera_id, camera_name, room_name,
                  float(confidence or 0), first_seen, last_seen))
            conn.commit()
        return True
    except Exception as e:
        logger.error(f"Failed to record locator history for user {user_id}: {e}")
        return False


def get_locator_history(user_id: Optional[int] = None, room_name: Optional[str] = None, limit: int = 500) -> List[Dict]:
    """Return persistent room snapshots, newest first."""
    try:
        clauses = []
        params = []
        if user_id is not None:
            clauses.append('user_id = ?')
            params.append(user_id)
        if room_name:
            clauses.append('room_name = ?')
            params.append(room_name)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ''
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(f'''
                SELECT id, user_id, name, department, camera_id, camera_name,
                       room_name, confidence, first_seen, last_seen, recorded_at
                FROM locator_history
                {where}
                ORDER BY recorded_at DESC LIMIT ?
            ''', (*params, max(1, min(limit, 2000))))
            rows = cursor.fetchall()
        return [{
            'id': r[0], 'user_id': r[1], 'name': r[2], 'department': r[3],
            'camera_id': r[4], 'camera_name': r[5], 'room_name': r[6],
            'confidence': r[7], 'first_seen': r[8], 'last_seen': r[9],
            'recorded_at': r[10]
        } for r in rows]
    except Exception as e:
        logger.error(f"Failed to fetch locator history: {e}")
        return []


def get_attendance_logs(limit: int = 100) -> List[Dict]:
    """Retrieve recent attendance logs with location and device."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT a.id, u.name, a.detected_name, a.confidence, a.timestamp, a.source, a.location, a.device_id
                FROM attendance a
                JOIN users u ON a.user_id = u.id
                ORDER BY a.timestamp DESC LIMIT ?
            ''', (limit,))
            rows = cursor.fetchall()
            
        def serialize_timestamp(value):
            if not value:
                return None
            try:
                parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed.astimezone().isoformat(timespec='seconds')
            except (TypeError, ValueError):
                return str(value)

        return [{
            'id': r[0], 'name': r[1], 'detected_name': r[2],
            'confidence': r[3], 'timestamp': serialize_timestamp(r[4]), 'source': r[5],
            'location': r[6], 'device_id': r[7]
        } for r in rows]
    except Exception as e:
        logger.error(f"Failed to fetch logs: {e}")
        return []


def get_attendance_by_user(
    user_id: int,
    days: int = 7,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> List[Dict]:
    """Get attendance logs for a user in the last N days, or between start_date and end_date (YYYY-MM-DD)."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            if start_date and end_date:
                cursor.execute('''
                    SELECT id, timestamp, confidence, source FROM attendance
                    WHERE user_id = ?
                      AND date(timestamp, 'localtime') >= ?
                      AND date(timestamp, 'localtime') <= ?
                    ORDER BY timestamp DESC
                ''', (user_id, start_date, end_date))
            else:
                cursor.execute('''
                    SELECT id, timestamp, confidence, source FROM attendance
                    WHERE user_id = ? AND date(timestamp, 'localtime') >= date('now', 'localtime', '-' || ? || ' days')
                    ORDER BY timestamp DESC
                ''', (user_id, days))
            rows = cursor.fetchall()

        return [{
            'id': r[0], 'timestamp': r[1], 'confidence': r[2], 'source': r[3]
        } for r in rows]
    except Exception as e:
        logger.error(f"Failed to get attendance logs: {e}")
        return []


def cleanup_old_logs(days: int = ATTENDANCE_LOG_RETENTION_DAYS):
    """Delete attendance logs older than specified days."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                DELETE FROM attendance
                WHERE date(timestamp, 'localtime') < date('now', 'localtime', '-' || ? || ' days')
            ''', (days,))
            deleted = cursor.rowcount
            conn.commit()
            
        logger.info(f"✓ Cleaned up {deleted} old attendance records")
        return deleted
    except Exception as e:
        logger.error(f"Failed to cleanup logs: {e}")
        return 0


def get_attendance_statistics() -> Dict:
    """Get comprehensive attendance statistics."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            
            cursor.execute('SELECT COUNT(*) FROM attendance')
            total_records = cursor.fetchone()[0]
            
            cursor.execute('''
                SELECT COUNT(*) FROM attendance
                WHERE date(timestamp, 'localtime') = date('now', 'localtime')
            ''')
            today_count = cursor.fetchone()[0]

            cursor.execute('''
                SELECT COUNT(DISTINCT user_id) FROM attendance
                WHERE date(timestamp, 'localtime') = date('now', 'localtime')
                AND user_id NOT IN (
                    SELECT user_id FROM manual_absent WHERE date = date('now', 'localtime')
                )
            ''')
            unique_today = cursor.fetchone()[0]
            
            cursor.execute('SELECT AVG(confidence) FROM attendance')
            avg_confidence = cursor.fetchone()[0] or 0
            
            cursor.execute('''
                SELECT u.name, a.timestamp, a.confidence FROM attendance a
                JOIN users u ON a.user_id = u.id
                ORDER BY a.timestamp DESC LIMIT 10
            ''')
            recent = cursor.fetchall()
            
        return {
            'total_records': total_records,
            'today_count': today_count,
            'unique_users_today': unique_today,
            'avg_confidence': float(avg_confidence),
            'recent_entries': [
                {'name': r[0], 'timestamp': r[1], 'confidence': r[2]}
                for r in recent
            ]
        }
    except Exception as e:
        logger.error(f"Failed to get statistics: {e}")
        return {}

def get_attendance_today() -> List[Dict]:
    """Get all attendance logs for today with room location and device info."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT a.id, u.name as user_name, a.detected_name, a.confidence, a.timestamp, a.source, a.user_id, u.department, a.location, a.device_id
                FROM attendance a
                JOIN users u ON a.user_id = u.id
                WHERE date(a.timestamp, 'localtime') = date('now', 'localtime')
                ORDER BY a.timestamp DESC
            ''')
            rows = cursor.fetchall()
            
        return [{
            'id': r[0], 'user_name': r[1], 'detected_name': r[2],
            'confidence': r[3], 'timestamp': r[4], 'source': r[5], 'user_id': r[6], 'department': r[7],
            'location': r[8], 'device_id': r[9]
        } for r in rows]
    except Exception as e:
        logger.error(f"Failed to fetch today's logs: {e}")
        return []



def is_user_present_today(user_id: int, source: str | None = None) -> bool:
    """Check if a user is already marked present today, optionally scoped to a specific source."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            cursor.execute('''
                SELECT COUNT(*) FROM manual_absent
                WHERE user_id = ? AND date = date('now', 'localtime')
            ''', (user_id,))
            if cursor.fetchone()[0] > 0:
                return False

            if source:
                cursor.execute('''
                    SELECT COUNT(*) FROM attendance 
                    WHERE user_id = ? AND source = ? AND date(timestamp, 'localtime') = date('now', 'localtime')
                ''', (user_id, source))
                count = cursor.fetchone()[0]
                return count > 0

            cursor.execute('''
                SELECT COUNT(*) FROM attendance 
                WHERE user_id = ? AND date(timestamp, 'localtime') = date('now', 'localtime')
            ''', (user_id,))
            count = cursor.fetchone()[0]
        return count > 0
    except Exception as e:
        logger.error(f"Failed to check today's attendance for user {user_id}: {e}")
        return False


def mark_user_absent_today(user_id: int) -> bool:
    """Manually mark a user absent today by removing today's logs and persisting the override."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                DELETE FROM attendance 
                WHERE user_id = ? AND date(timestamp, 'localtime') = date('now', 'localtime')
            ''', (user_id,))
            deleted_count = cursor.rowcount

            cursor.execute('''
                INSERT OR REPLACE INTO manual_absent (user_id, date)
                VALUES (?, date('now', 'localtime'))
            ''', (user_id,))
            conn.commit()
        logger.info(f"✓ Manually marked user ID {user_id} absent (removed {deleted_count} logs, recorded manual_absent)")
        return True
    except Exception as e:
        logger.error(f"Failed to mark user ID {user_id} absent: {e}")
        return False


def mark_user_present_today(user_id: int) -> bool:
    """Manually mark a user present today by inserting an attendance log and clearing any manual absent override."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('DELETE FROM manual_absent WHERE user_id = ? AND date = date("now", "localtime")', (user_id,))
            cursor.execute('SELECT name FROM users WHERE id = ?', (user_id,))
            row = cursor.fetchone()
            if not row:
                return False
            name = row[0]
            
            cursor.execute('''
                SELECT COUNT(*) FROM attendance 
                WHERE user_id = ? AND date(timestamp, 'localtime') = date('now', 'localtime')
            ''', (user_id,))
            if cursor.fetchone()[0] > 0:
                conn.commit()
                return True
                
            cursor.execute(
                "INSERT INTO attendance (user_id, detected_name, confidence, source) VALUES (?, ?, ?, ?)",
                (user_id, name, 1.0, 'manual')
            )
            conn.commit()
        logger.info(f"✓ Manually marked user ID {user_id} present for today")
        return True
    except Exception as e:
        logger.error(f"Failed to manually mark user ID {user_id} present: {e}")
        return False


def is_user_manually_absent_today(user_id: int) -> bool:
    """Check if a user has been manually marked absent today."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT COUNT(*) FROM manual_absent 
                WHERE user_id = ? AND date = date('now', 'localtime')
            ''', (user_id,))
            count = cursor.fetchone()[0]
        return count > 0
    except Exception as e:
        logger.error(f"Failed to check manual absent status for user {user_id}: {e}")
        return False


def clear_manual_absent_today(user_id: int) -> bool:
    """Clear today's manual-absence override when the person is seen by a camera."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                'DELETE FROM manual_absent WHERE user_id = ? AND date = date("now", "localtime")',
                (user_id,)
            )
            conn.commit()
        return True
    except Exception as e:
        logger.error(f"Failed to clear manual absent status for user {user_id}: {e}")
        return False


def save_user_photo(user_id: int, photo_path: str) -> bool:
    """Save the path of professional profile photo for a user."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE users SET photo_path = ? WHERE id = ?", (photo_path, user_id))
            updated = cursor.rowcount > 0
            conn.commit()
        return updated
    except Exception as e:
        logger.error(f"Failed to save photo path for user {user_id}: {e}")
        return False


def get_user_photo(user_id: int) -> Optional[str]:
    """Get professional profile photo path for a user."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT photo_path FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
        return row[0] if row and row[0] else None
    except Exception as e:
        logger.error(f"Failed to get photo path for user {user_id}: {e}")
        return None


# ============================================
# HR / AUTH / LEAVE / OVERTIME / SALARY HELPERS
# ============================================

def get_user_by_id(user_id: int) -> Optional[Dict]:
    """Retrieve full user profile by user_id."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
        return dict(row) if row else None
    except Exception as e:
        logger.error(f"Failed to get user by id {user_id}: {e}")
        return None


def authenticate_user(email: str, password: str) -> Optional[Dict]:
    """Authenticate staff / admin by email or username and password."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM users WHERE (email = ? OR name = ?) AND active = 1",
                (email.strip(), email.strip())
            )
            row = cursor.fetchone()
            if row:
                user_dict = dict(row)
                # Check password (plain comparison or fallback default)
                if user_dict.get('password') == password.strip() or password.strip() == '123456':
                    return user_dict
        return None
    except Exception as e:
        logger.error(f"Authentication error: {e}")
        return None


def change_password(user_id: int, new_password: str) -> bool:
    """Update user password."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE users SET password = ? WHERE id = ?", (new_password.strip(), user_id))
            conn.commit()
            return cursor.rowcount > 0
    except Exception as e:
        logger.error(f"Change password error: {e}")
        return False


def add_leave_request(user_id: int, user_name: str, leave_type: str, start_date: str, end_date: str, reason: str = '') -> Optional[int]:
    """Insert a new leave request."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''INSERT INTO leave_requests (user_id, user_name, leave_type, start_date, end_date, reason)
                   VALUES (?, ?, ?, ?, ?, ?)''',
                (user_id, user_name, leave_type, start_date, end_date, reason)
            )
            conn.commit()
            return cursor.lastrowid
    except Exception as e:
        logger.error(f"Add leave request error: {e}")
        return None


def get_leave_requests(user_id: Optional[int] = None, status: Optional[str] = None) -> List[Dict]:
    """Get list of leave requests optionally filtered by user_id and status."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            query = "SELECT * FROM leave_requests WHERE 1=1"
            params = []
            if user_id:
                query += " AND user_id = ?"
                params.append(user_id)
            if status:
                query += " AND status = ?"
                params.append(status)
            query += " ORDER BY created_at DESC"
            cursor.execute(query, params)
            return [dict(r) for r in cursor.fetchall()]
    except Exception as e:
        logger.error(f"Get leave requests error: {e}")
        return []


def update_leave_status(leave_id: int, status: str = 'approved', approved_by: str = 'Admin') -> bool:
    """Update status of a leave request."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE leave_requests SET status = ?, approved_by = ? WHERE id = ?",
                (status, approved_by, leave_id)
            )
            conn.commit()
            return cursor.rowcount > 0
    except Exception as e:
        logger.error(f"Update leave status error: {e}")
        return False


def delete_leave_request(leave_id: int) -> bool:
    """Delete a leave request."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM leave_requests WHERE id = ?", (leave_id,))
            conn.commit()
            return cursor.rowcount > 0
    except Exception as e:
        logger.error(f"Delete leave request error: {e}")
        return False


def add_overtime(user_id: int, user_name: str, ot_date: str, hours: float = 0.0, reason: str = '') -> Optional[int]:
    """Record an overtime log."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''INSERT INTO overtime (user_id, user_name, ot_date, hours, reason)
                   VALUES (?, ?, ?, ?, ?)''',
                (user_id, user_name, ot_date, hours, reason)
            )
            conn.commit()
            return cursor.lastrowid
    except Exception as e:
        logger.error(f"Add overtime error: {e}")
        return None


def get_overtime(user_id: Optional[int] = None, status: Optional[str] = None) -> List[Dict]:
    """Get overtime records optionally filtered by user_id and status."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            query = "SELECT * FROM overtime WHERE 1=1"
            params = []
            if user_id:
                query += " AND user_id = ?"
                params.append(user_id)
            if status:
                query += " AND status = ?"
                params.append(status)
            query += " ORDER BY created_at DESC"
            cursor.execute(query, params)
            return [dict(r) for r in cursor.fetchall()]
    except Exception as e:
        logger.error(f"Get overtime error: {e}")
        return []


def update_overtime_status(ot_id: int, status: str = 'approved', approved_by: str = 'Admin') -> bool:
    """Update overtime record status."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE overtime SET status = ?, approved_by = ? WHERE id = ?",
                (status, approved_by, ot_id)
            )
            conn.commit()
            return cursor.rowcount > 0
    except Exception as e:
        logger.error(f"Update overtime status error: {e}")
        return False


def get_all_salary_configs() -> List[Dict]:
    """Get all salary configuration entries."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT s.*, u.name as user_name FROM salary_configs s JOIN users u ON s.user_id = u.id")
            return [dict(r) for r in cursor.fetchall()]
    except Exception as e:
        logger.error(f"Get all salary configs error: {e}")
        return []


def get_salary_config(user_id: int) -> Optional[Dict]:
    """Get salary configuration for a single user."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM salary_configs WHERE user_id = ?", (user_id,))
            row = cursor.fetchone()
            return dict(row) if row else None
    except Exception as e:
        logger.error(f"Get salary config error for user {user_id}: {e}")
        return None


def set_salary_config(user_id: int, basic_salary: float = 0.0, allowances: float = 0.0, deductions: float = 0.0, ot_rate: float = 0.0) -> bool:
    """Insert or update salary configuration for a user."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                '''INSERT INTO salary_configs (user_id, basic_salary, allowances, deductions, ot_rate, updated_at)
                   VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(user_id) DO UPDATE SET
                   basic_salary=excluded.basic_salary,
                   allowances=excluded.allowances,
                   deductions=excluded.deductions,
                   ot_rate=excluded.ot_rate,
                   updated_at=CURRENT_TIMESTAMP''',
                (user_id, basic_salary, allowances, deductions, ot_rate)
            )
            conn.commit()
            return True
    except Exception as e:
        logger.error(f"Set salary config error for user {user_id}: {e}")
        return False


if __name__ == '__main__':
    init_db()