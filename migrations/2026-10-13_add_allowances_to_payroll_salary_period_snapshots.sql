BEGIN;

ALTER TABLE public.payroll_salary_period_snapshots
  ADD COLUMN IF NOT EXISTS allowances numeric
    CHECK (allowances IS NULL OR allowances >= 0),
  ADD COLUMN IF NOT EXISTS applied_allowances jsonb;

COMMIT;
