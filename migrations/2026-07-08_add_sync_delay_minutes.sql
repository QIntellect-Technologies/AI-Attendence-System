-- Migration: add sync_delay_minutes to attendance_capture_settings
-- Run in Supabase SQL editor or psql connected to your DB

BEGIN;

ALTER TABLE public.attendance_capture_settings
  ADD COLUMN IF NOT EXISTS sync_delay_minutes integer DEFAULT 0;

COMMIT;
