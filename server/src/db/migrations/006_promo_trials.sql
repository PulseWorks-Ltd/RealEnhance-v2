BEGIN;

-- Promo codes for non-subscription trials
CREATE TABLE IF NOT EXISTS promo_codes (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  code_normalized TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  max_redemptions INTEGER,
  redemptions_count INTEGER NOT NULL DEFAULT 0,
  trial_days INTEGER NOT NULL DEFAULT 30,
  credits_granted INTEGER NOT NULL DEFAULT 50,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT promo_codes_code_norm_unique UNIQUE (code_normalized)
);

-- Trial claim records (one per normalized email)
CREATE TABLE IF NOT EXISTS trial_claims (
  id SERIAL PRIMARY KEY,
  email_hash TEXT NOT NULL,
  promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE SET NULL,
  org_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_hash TEXT,
  ua_hash TEXT,
  CONSTRAINT trial_claims_email_unique UNIQUE (email_hash)
);

-- Trial state per organisation (agency)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trial_status_enum') THEN
    CREATE TYPE trial_status_enum AS ENUM ('none', 'pending', 'active', 'expired', 'converted');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS organisations (
  agency_id TEXT PRIMARY KEY,
  trial_status trial_status_enum NOT NULL DEFAULT 'none',
  trial_expires_at TIMESTAMPTZ,
  trial_credits_total INTEGER NOT NULL DEFAULT 0,
  trial_credits_used INTEGER NOT NULL DEFAULT 0,
  trial_promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trial credit reservations per job for refund-on-failure bookkeeping
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trial_reservation_status') THEN
    CREATE TYPE trial_reservation_status AS ENUM ('reserved', 'consumed', 'released');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS trial_reservations (
  job_id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  reserved_images INTEGER NOT NULL,
  status trial_reservation_status NOT NULL DEFAULT 'reserved',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trial_reservations_agency ON trial_reservations(agency_id);

COMMIT;
