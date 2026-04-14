BEGIN;

-- Add listing pack credit balance to agency_accounts
ALTER TABLE agency_accounts
  ADD COLUMN IF NOT EXISTS listing_pack_credits INTEGER NOT NULL DEFAULT 0;

-- Track listing pack allocation in job reservations
ALTER TABLE job_reservations
  ADD COLUMN IF NOT EXISTS reserved_from_listing_pack INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stage12_from_listing_pack INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stage2_from_listing_pack INTEGER NOT NULL DEFAULT 0;

-- Audit table for listing pack purchases
CREATE TABLE IF NOT EXISTS listing_pack_purchases (
  id SERIAL PRIMARY KEY,
  agency_id TEXT NOT NULL,
  credits_added INTEGER NOT NULL,
  stripe_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_pack_purchases_agency
  ON listing_pack_purchases(agency_id);

COMMIT;
