import sqlite3
import sys
from pathlib import Path

DB = Path(r"C:\ProgramData\QIntellect\AttendanceNode\local_node.db")
MIG = Path("migrations") / "2026-07-16_add_unique_attendance_index.sql"
if not DB.exists():
    print("ERROR: DB not found:", DB)
    sys.exit(2)
if not MIG.exists():
    print("ERROR: migration file not found:", MIG)
    sys.exit(2)

conn = sqlite3.connect(str(DB))
cur = conn.cursor()
dups = cur.execute(
    "SELECT branch_id,people_type,person_code,attendance_date,COUNT(*) AS cnt FROM attendance_buffer GROUP BY branch_id,people_type,person_code,attendance_date HAVING cnt>1;"
).fetchall()
if dups:
    print("DUPLICATES FOUND: resolve before creating UNIQUE index")
    for row in dups:
        print(row)
    conn.close()
    sys.exit(3)

sql = MIG.read_text(encoding="utf-8")
try:
    conn.executescript(sql)
    conn.commit()
    print("Migration applied")
finally:
    conn.close()
