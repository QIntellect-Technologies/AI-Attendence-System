-- Allow the support-controlled income-tax feature entitlement.
-- Run in the Supabase SQL editor or with psql against the tenant database.

BEGIN;

ALTER TABLE public.organization_modules
  DROP CONSTRAINT IF EXISTS organization_modules_module_name_check;

ALTER TABLE public.organization_modules
  ADD CONSTRAINT organization_modules_module_name_check
  CHECK (
    module_name = ANY (
      ARRAY[
        'attendance',
        'employees',
        'leave',
        'payroll',
        'income_tax',
        'overtime',
        'reports',
        'cctv',
        'liveattendance',
        'staff_directory',
        'leave_management',
        'live_attendance',
        'livecctv',
        'liveattendancemonitoring'
      ]::text[]
    )
  );

COMMIT;
