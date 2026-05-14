BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Pilot promo definitions (seeded; global cap / credit amounts live here)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pilot_promos (
  code             TEXT PRIMARY KEY,
  credits_granted  INTEGER  NOT NULL,
  expiry_days      INTEGER  NOT NULL DEFAULT 30,
  global_cap       INTEGER  NOT NULL DEFAULT 10,
  total_redemptions INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN  NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-redemption tracking: one row per (user, promo) pair
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pilot_promo_redemptions (
  id               SERIAL PRIMARY KEY,
  promo_code       TEXT     NOT NULL REFERENCES pilot_promos(code),
  agency_id        TEXT,
  user_id          TEXT     NOT NULL,
  credits_granted  INTEGER  NOT NULL,
  credits_used     INTEGER  NOT NULL DEFAULT 0,
  redeemed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each user may redeem a given pilot promo at most once
CREATE UNIQUE INDEX IF NOT EXISTS idx_pilot_redemption_user
  ON pilot_promo_redemptions (promo_code, user_id);

-- Each agency may redeem a given pilot promo at most once (when agency_id is present)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pilot_redemption_agency
  ON pilot_promo_redemptions (promo_code, agency_id)
  WHERE agency_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Extend job_reservations to carry pilot-promo allocation per job
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE job_reservations
  ADD COLUMN IF NOT EXISTS reserved_from_pilot_promo INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pilot_promo_redemption_id  INTEGER  REFERENCES pilot_promo_redemptions(id),
  ADD COLUMN IF NOT EXISTS stage12_from_pilot_promo   INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stage2_from_pilot_promo    INTEGER  NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed pilot promo definitions
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO pilot_promos (code, credits_granted, expiry_days, global_cap)
VALUES
  ('PILOT_50', 50, 30, 10),
  ('PILOT_30', 30, 30, 10)
ON CONFLICT (code) DO UPDATE
  SET credits_granted = EXCLUDED.credits_granted,
      expiry_days     = EXCLUDED.expiry_days,
      global_cap      = EXCLUDED.global_cap,
      updated_at      = NOW();

COMMIT;
