-- Migration 1: additive organization -> department -> designation foundation
-- Run manually in the Supabase SQL Editor or through psql.
-- This migration creates schema objects only. It does not insert, update,
-- delete, or backfill any existing production data.

BEGIN;

CREATE TABLE IF NOT EXISTS public.designations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  code text NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'designations_org_id_fkey'
      AND n.nspname = 'public'
      AND t.relname = 'designations'
  ) THEN
    ALTER TABLE public.designations
      ADD CONSTRAINT designations_org_id_fkey
      FOREIGN KEY (org_id)
      REFERENCES public.organizations (id)
      ON DELETE CASCADE
      ON UPDATE NO ACTION;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'designations_status_check'
      AND n.nspname = 'public'
      AND t.relname = 'designations'
  ) THEN
    ALTER TABLE public.designations
      ADD CONSTRAINT designations_status_check
      CHECK (status IN ('active', 'inactive'));
  END IF;
END
$$;

-- PostgreSQL requires a primary/unique key on the exact referenced columns
-- before a composite foreign key can be created. This is a new supporting
-- index; it does not alter the existing departments primary key or indexes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_id_org_id
  ON public.departments (id, org_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_designations_id_org_id
  ON public.designations (id, org_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_designations_org_name
  ON public.designations (org_id, lower(btrim(name)));

CREATE INDEX IF NOT EXISTS idx_designations_org_status
  ON public.designations (org_id, status);

-- The relationship inherits branch scope from departments.branch_id. Keeping
-- no branch_id here avoids a second branch value that could drift from the
-- department's actual branch.
CREATE TABLE IF NOT EXISTS public.department_designations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  department_id uuid NOT NULL,
  designation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'department_designations_org_id_fkey'
      AND n.nspname = 'public'
      AND t.relname = 'department_designations'
  ) THEN
    ALTER TABLE public.department_designations
      ADD CONSTRAINT department_designations_org_id_fkey
      FOREIGN KEY (org_id)
      REFERENCES public.organizations (id)
      ON DELETE CASCADE
      ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'department_designations_department_org_fkey'
      AND n.nspname = 'public'
      AND t.relname = 'department_designations'
  ) THEN
    ALTER TABLE public.department_designations
      ADD CONSTRAINT department_designations_department_org_fkey
      FOREIGN KEY (department_id, org_id)
      REFERENCES public.departments (id, org_id)
      ON DELETE CASCADE
      ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'department_designations_designation_org_fkey'
      AND n.nspname = 'public'
      AND t.relname = 'department_designations'
  ) THEN
    ALTER TABLE public.department_designations
      ADD CONSTRAINT department_designations_designation_org_fkey
      FOREIGN KEY (designation_id, org_id)
      REFERENCES public.designations (id, org_id)
      ON DELETE CASCADE
      ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'department_designations_status_check'
      AND n.nspname = 'public'
      AND t.relname = 'department_designations'
  ) THEN
    ALTER TABLE public.department_designations
      ADD CONSTRAINT department_designations_status_check
      CHECK (status IN ('active', 'inactive'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'department_designations_pair_unique'
      AND n.nspname = 'public'
      AND t.relname = 'department_designations'
  ) THEN
    ALTER TABLE public.department_designations
      ADD CONSTRAINT department_designations_pair_unique
      UNIQUE (department_id, designation_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_department_designations_org
  ON public.department_designations (org_id);

CREATE INDEX IF NOT EXISTS idx_department_designations_department
  ON public.department_designations (department_id, status);

CREATE INDEX IF NOT EXISTS idx_department_designations_designation
  ON public.department_designations (designation_id, status);

ALTER TABLE public.client_staff
  ADD COLUMN IF NOT EXISTS designation_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'client_staff_designation_org_fkey'
      AND n.nspname = 'public'
      AND t.relname = 'client_staff'
  ) THEN
    ALTER TABLE public.client_staff
      ADD CONSTRAINT client_staff_designation_org_fkey
      FOREIGN KEY (designation_id, org_id)
      REFERENCES public.designations (id, org_id)
      ON DELETE SET NULL
      ON UPDATE NO ACTION;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_client_staff_designation_id
  ON public.client_staff (designation_id);

ALTER TABLE public.designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_designations ENABLE ROW LEVEL SECURITY;

COMMIT;
