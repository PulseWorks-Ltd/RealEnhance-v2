-- Add user attribution and consumption flags to reservations for per-user rollups and accurate usage

ALTER TABLE job_reservations
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS stage12_consumed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stage2_consumed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_job_reservations_user_month
  ON job_reservations (agency_id, yyyymm, user_id);