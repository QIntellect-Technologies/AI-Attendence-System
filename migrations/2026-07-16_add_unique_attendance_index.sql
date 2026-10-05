-- Migration: Add UNIQUE index to prevent duplicate attendance rows
-- Ensures (branch_id, people_type, person_code, attendance_date) is unique.

-- Check for duplicates first. If this returns any rows, you must
-- resolve them (delete or merge) before applying the index.
SELECT branch_id, people_type, person_code, attendance_date, COUNT(*) AS cnt
FROM attendance_buffer
GROUP BY branch_id, people_type, person_code, attendance_date
HAVING cnt > 1;

-- If no duplicates are present, create the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_person_date_unique
ON attendance_buffer(branch_id, people_type, person_code, attendance_date);
