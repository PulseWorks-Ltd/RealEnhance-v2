-- Migration: Billing Finalization and Caps
-- Purpose: Add idempotent billing guard and enforce retry/edit caps

BEGIN;

-- Add billing finalization fields to job_reservations
ALTER TABLE job_reservations
  ADD COLUMN IF NOT EXISTS charge_finalized BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS charge_amount INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS charge_computed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage1a_success BOOLEAN,
  ADD COLUMN IF NOT EXISTS stage1b_success BOOLEAN,
  ADD COLUMN IF NOT EXISTS stage2_success BOOLEAN,
  ADD COLUMN IF NOT EXISTS scene_type TEXT,
  ADD COLUMN IF NOT EXISTS charge_log TEXT;

-- Add index for billing queries
CREATE INDEX IF NOT EXISTS idx_job_reservations_finalized ON job_reservations(charge_finalized, agency_id);

-- Comments for documentation
COMMENT ON COLUMN job_reservations.charge_finalized IS 'Idempotent guard: true if final charge has been computed and deducted';
COMMENT ON COLUMN job_reservations.charge_amount IS 'Final charge amount (0, 1, or 2 credits)';
COMMENT ON COLUMN job_reservations.charge_computed_at IS 'Timestamp when charge was finalized';
COMMENT ON COLUMN job_reservations.stage1a_success IS 'Whether Stage 1A succeeded (quality enhancement)';
COMMENT ON COLUMN job_reservations.stage1b_success IS 'Whether Stage 1B succeeded (declutter)';
COMMENT ON COLUMN job_reservations.stage2_success IS 'Whether Stage 2 succeeded (virtual staging)';
COMMENT ON COLUMN job_reservations.scene_type IS 'Scene type for billing logic (interior/exterior)';
COMMENT ON COLUMN job_reservations.charge_log IS 'Human-readable log of charge computation';

COMMIT;
