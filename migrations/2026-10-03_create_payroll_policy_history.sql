BEGIN;

CREATE TABLE IF NOT EXISTS public.payroll_policy_history (
  org_id text NOT NULL,
  branch_id text NOT NULL DEFAULT '',
  staff_id text NOT NULL DEFAULT '',
  effective_from date NOT NULL,
  policy jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, branch_id, staff_id, effective_from),
  CHECK (jsonb_typeof(policy) = 'object'),
  CHECK (branch_id = '' OR staff_id = '')
);

INSERT INTO public.payroll_policy_history (
  org_id,
  branch_id,
  staff_id,
  effective_from,
  policy
)
SELECT
  org_id,
  '',
  '',
  DATE '0001-01-01',
  payroll_policy
FROM public.client_onboarding_configs
WHERE jsonb_typeof(payroll_policy) = 'object'
ON CONFLICT (org_id, branch_id, staff_id, effective_from) DO NOTHING;

INSERT INTO public.payroll_policy_history (
  org_id,
  branch_id,
  staff_id,
  effective_from,
  policy
)
SELECT
  org_id,
  branch_id,
  staff_id,
  DATE '0001-01-01',
  policy
FROM public.payroll_policy_overrides
WHERE jsonb_typeof(policy) = 'object'
ON CONFLICT (org_id, branch_id, staff_id, effective_from) DO NOTHING;

COMMIT;
