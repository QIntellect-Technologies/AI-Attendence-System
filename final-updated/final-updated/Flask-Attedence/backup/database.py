import sqlite3
import json
import os
from datetime import datetime, timedelta
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

            # Automatic Migration: Add photo_path column if it doesn't exist
            try:
                cursor.execute("ALTER TABLE users ADD COLUMN photo_path TEXT")
                conn.commit()
                logger.info("✓ Migration: 'photo_path' column added successfully.")
            except sqlite3.OperationalError:
                # Column already exists, ignore error safely
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

            # Create indexes for performance
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_users_name ON users(name)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_users_active ON users(active)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_embeddings_user ON embeddings(user_id)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_attendance_timestamp ON attendance(timestamp)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_attendance_source ON attendance(source)')

            conn.commit()
            
        logger.info(f"✓ Database initialized at {DB_PATH}")
        return True
    except Exception as e:
        logger.error(f"✗ Database initialization failed: {e}")
        return False


def add_user(name: str, email: str = None, phone: str = None, department: str = None) -> Optional[int]:
    """Add a new user with validation."""
    if not name or len(name.strip()) == 0:
        logger.warning("Attempted to add user with empty name")
        return None
        
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                'INSERT INTO users (name, email, phone, department) VALUES (?, ?, ?, ?)',
                (name.strip(), email, phone, department)
            )
            conn.commit()
            user_id = cursor.lastrowid
            
        logger.info(f"✓ User '{name}' created (ID: {user_id})")
        return user_id
    except sqlite3.IntegrityError:
        logger.warning(f"User '{name}' already exists")
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


def get_all_users() -> List[Dict]:
    """Get all active users with today's attendance status via optimized join."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT u.id, u.name, u.email, u.phone, u.department, u.enrollment_date, 
                       u.created_at, u.active, u.notes, u.photo_path,
                       CASE WHEN a.user_id IS NOT NULL THEN 'Present' ELSE 'Absent' END as status_today
                FROM users u
                LEFT JOIN (
                    SELECT DISTINCT user_id 
                    FROM attendance 
                    WHERE date(timestamp) = date('now', 'utc')
                ) a ON u.id = a.user_id
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


def update_user(user_id: int, name: str, email: str = None, phone: str = None, department: str = None, notes: str = None) -> bool:
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


def store_embedding(user_id: int, embedding: List[float], source_video: str = None):
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


def log_attendance(user_id: int, detected_name: str, confidence: float, source: str = 'camera'):
    """Log attendance detection."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute(
                'INSERT INTO attendance (user_id, detected_name, confidence, source) VALUES (?, ?, ?, ?)',
                (user_id, detected_name, confidence, source)
            )
            conn.commit()
    except Exception as e:
        logger.error(f"Failed to log attendance for user {user_id}: {e}")


def get_attendance_logs(limit: int = 100) -> List[Dict]:
    """Retrieve recent attendance logs."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT a.id, u.name, a.detected_name, a.confidence, a.timestamp, a.source
                FROM attendance a
                JOIN users u ON a.user_id = u.id
                ORDER BY a.timestamp DESC LIMIT ?
            ''', (limit,))
            rows = cursor.fetchall()
            
        return [{
            'id': r[0], 'name': r[1], 'detected_name': r[2],
            'confidence': r[3], 'timestamp': r[4], 'source': r[5]
        } for r in rows]
    except Exception as e:
        logger.error(f"Failed to fetch logs: {e}")
        return []


def get_attendance_by_user(user_id: int, days: int = 7) -> List[Dict]:
    """Get attendance logs for a user in the last N days."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT id, timestamp, confidence, source FROM attendance
                WHERE user_id = ? AND date(timestamp) >= date('now', 'utc', '-' || ? || ' days')
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
                WHERE date(timestamp) < date('now', 'utc', '-' || ? || ' days')
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
                WHERE date(timestamp) = date('now', 'utc')
            ''')
            today_count = cursor.fetchone()[0]
            
            cursor.execute('''
                SELECT COUNT(DISTINCT user_id) FROM attendance
                WHERE date(timestamp) = date('now', 'utc')
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


def is_user_present_today(user_id: int, source: str = None) -> bool:
    """Check if a user is already marked present today, optionally scoped to a specific source."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            if source:
                cursor.execute('''
                    SELECT COUNT(*) FROM attendance 
                    WHERE user_id = ? AND source = ? AND date(timestamp) = date('now', 'utc')
                ''', (user_id, source))
            else:
                cursor.execute('''
                    SELECT COUNT(*) FROM attendance 
                    WHERE user_id = ? AND date(timestamp) = date('now', 'utc')
                ''', (user_id,))
            count = cursor.fetchone()[0]
        return count > 0
    except Exception as e:
        logger.error(f"Failed to check today's attendance for user {user_id}: {e}")
        return False


def mark_user_absent_today(user_id: int) -> bool:
    """Manually mark a user absent today by removing today's logs."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                DELETE FROM attendance 
                WHERE user_id = ? AND date(timestamp) = date('now', 'utc')
            ''', (user_id,))
            deleted_count = cursor.rowcount
            conn.commit()
        logger.info(f"✓ Manually marked user ID {user_id} absent (removed {deleted_count} logs)")
        return True
    except Exception as e:
        logger.error(f"Failed to mark user ID {user_id} absent: {e}")
        return False


def mark_user_present_today(user_id: int) -> bool:
    """Manually mark a user present today by inserting an attendance log."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT name FROM users WHERE id = ?', (user_id,))
            row = cursor.fetchone()
            if not row:
                return False
            name = row[0]
            
            cursor.execute('''
                SELECT COUNT(*) FROM attendance 
                WHERE user_id = ? AND date(timestamp) = date('now', 'utc')
            ''', (user_id,))
            if cursor.fetchone()[0] > 0:
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


if __name__ == '__main__':
    init_db()