-- Migration: create payroll_payments table for marking payroll periods Paid/Pending
-- Run in Supabase SQL editor or psql connected to your DB

BEGIN;

CREATE TABLE IF NOT EXISTS public.payroll_payments (
  org_id text NOT NULL,
  staff_id text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  paid_at timestamptz NOT NULL,
  unpaid_leave_days numeric NOT NULL DEFAULT 0,
  late_count integer NOT NULL DEFAULT 0,
  breakdown jsonb,
  PRIMARY KEY (org_id, staff_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_payroll_payments_org_periods
ON public.payroll_payments (org_id, period_start, period_end);

COMMIT;
