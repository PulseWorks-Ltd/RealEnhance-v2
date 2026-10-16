BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Lifetime monthly bonus codes
-- A code adds `bonus_credits` to the agency's monthly allowance for as long as
-- it has an active subscription. Each code can be redeemed by ONE agency only.
-- Only a SHA-256 hash of the code is stored, so the code itself never lives
-- in the repo or the database.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lifetime_bonus_codes (
  code_hash             TEXT PRIMARY KEY,
  label                 TEXT,
  bonus_credits         INTEGER     NOT NULL CHECK (bonus_credits > 0),
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  redeemed_by_agency_id TEXT,
  redeemed_by_user_id   TEXT,
  redeemed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lifetime_bonus_agency
  ON lifetime_bonus_codes (redeemed_by_agency_id)
  WHERE redeemed_by_agency_id IS NOT NULL;

-- Founding customer reward: +40 credits per month, single use.
INSERT INTO lifetime_bonus_codes (code_hash, label, bonus_credits)
VALUES ('75478df6c688f6ef81f1bda9253770c73a87b7f9c6f0a6e9d968e5c0c78a67c4', 'founding_customer_plus40', 40)
ON CONFLICT (code_hash) DO NOTHING;

COMMIT;
