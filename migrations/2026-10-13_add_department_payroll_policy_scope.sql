BEGIN;

ALTER TABLE public.payroll_policy_overrides
  ADD COLUMN IF NOT EXISTS department_id text NOT NULL DEFAULT '';

ALTER TABLE public.payroll_policy_overrides
  DROP CONSTRAINT IF EXISTS payroll_policy_overrides_scope_uidx;

ALTER TABLE public.payroll_policy_overrides
  ADD CONSTRAINT payroll_policy_overrides_scope_uidx
  UNIQUE (org_id, branch_id, department_id, staff_id);

ALTER TABLE public.payroll_policy_overrides
  DROP CONSTRAINT IF EXISTS payroll_policy_overrides_scope_check;

ALTER TABLE public.payroll_policy_overrides
  ADD CONSTRAINT payroll_policy_overrides_scope_check
  CHECK (
    (branch_id <> '')::integer +
    (department_id <> '')::integer +
    (staff_id <> '')::integer <= 1
  );

ALTER TABLE public.payroll_policy_history
  ADD COLUMN IF NOT EXISTS department_id text NOT NULL DEFAULT '';

ALTER TABLE public.payroll_policy_history
  DROP CONSTRAINT IF EXISTS payroll_policy_history_pkey;

ALTER TABLE public.payroll_policy_history
  ADD CONSTRAINT payroll_policy_history_pkey
  PRIMARY KEY (org_id, branch_id, department_id, staff_id, effective_from);

ALTER TABLE public.payroll_policy_history
  DROP CONSTRAINT IF EXISTS payroll_policy_history_check;

ALTER TABLE public.payroll_policy_history
  DROP CONSTRAINT IF EXISTS payroll_policy_history_scope_check;

ALTER TABLE public.payroll_policy_history
  ADD CONSTRAINT payroll_policy_history_scope_check
  CHECK (
    (branch_id <> '')::integer +
    (department_id <> '')::integer +
    (staff_id <> '')::integer <= 1
  );

COMMIT;
