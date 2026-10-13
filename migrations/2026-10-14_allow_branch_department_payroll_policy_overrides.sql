BEGIN;

ALTER TABLE public.payroll_policy_overrides
  DROP CONSTRAINT IF EXISTS payroll_policy_overrides_scope_check;

ALTER TABLE public.payroll_policy_overrides
  ADD CONSTRAINT payroll_policy_overrides_scope_check
  CHECK (
    staff_id = ''
    OR (branch_id = '' AND department_id = '')
  );

ALTER TABLE public.payroll_policy_history
  DROP CONSTRAINT IF EXISTS payroll_policy_history_scope_check;

ALTER TABLE public.payroll_policy_history
  ADD CONSTRAINT payroll_policy_history_scope_check
  CHECK (
    staff_id = ''
    OR (branch_id = '' AND department_id = '')
  );

COMMIT;
