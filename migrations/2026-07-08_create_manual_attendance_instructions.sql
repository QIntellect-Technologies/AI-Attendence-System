-- Create manual_attendance_instructions table and remove half_day_leave_windows
-- Generated: 2026-07-08

BEGIN;

-- Create manual instructions table for admin-created attendance overrides
CREATE TABLE IF NOT EXISTS manual_attendance_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  staff_id uuid NULL,
  person_code text NULL,
  people_type text NULL,
  attendance_date date NOT NULL,
  check_in_time time NULL,
  check_out_time time NULL,
  reason text NULL,
  notes text NULL,
  status text NOT NULL DEFAULT 'pending',
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_instructions_org_branch_status
  ON manual_attendance_instructions (org_id, branch_id, status);

-- Drop retired half-day windows table if present
DROP TABLE IF EXISTS half_day_leave_windows;

COMMIT;
