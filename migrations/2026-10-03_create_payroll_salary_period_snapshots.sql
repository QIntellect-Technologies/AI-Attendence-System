BEGIN;

CREATE TABLE IF NOT EXISTS public.payroll_salary_period_snapshots (
  org_id text NOT NULL,
  staff_id text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  basic_salary numeric NOT NULL CHECK (basic_salary >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, staff_id, period_start, period_end)
);

COMMIT;
