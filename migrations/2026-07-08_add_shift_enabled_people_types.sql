-- Migration: add shift_enabled_people_types to client_onboarding_configs
-- Run in Supabase SQL editor or psql connected to your DB

BEGIN;

ALTER TABLE public.client_onboarding_configs
  ADD COLUMN IF NOT EXISTS shift_enabled_people_types jsonb;

-- Backfill from company_profile JSON when present
UPDATE public.client_onboarding_configs
SET shift_enabled_people_types = (company_profile -> 'shift_enabled_people_types')
WHERE company_profile IS NOT NULL
  AND (company_profile -> 'shift_enabled_people_types') IS NOT NULL;

COMMIT;
