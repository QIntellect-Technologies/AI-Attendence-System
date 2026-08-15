import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path(r"C:\ProgramData\QIntellect\AttendanceNode\local_node.db")
if not DB_PATH.exists():
    print(f"ERROR: DB not found at {DB_PATH}")
    raise SystemExit(2)

stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
backup = DB_PATH.with_name(f"local_node.db.bak.{stamp}")
shutil.copy2(DB_PATH, backup)
print(f"Backed up {DB_PATH} -> {backup}")

# Delete row id=82 if present
conn = sqlite3.connect(str(DB_PATH))
cur = conn.cursor()
cur.execute("SELECT COUNT(*) FROM attendance_buffer WHERE id = ?", (82,))
count = cur.fetchone()[0]
if count == 0:
    print("Row id=82 not found; nothing to delete.")
else:
    cur.execute("DELETE FROM attendance_buffer WHERE id = ?", (82,))
    conn.commit()
    print(f"Deleted {cur.rowcount} row(s) with id=82")

conn.close()
