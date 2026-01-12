BEGIN;

CREATE TABLE IF NOT EXISTS agency_accounts (
  agency_id TEXT PRIMARY KEY,
  plan_tier TEXT NOT NULL DEFAULT 'starter',
  monthly_included_images INTEGER NOT NULL DEFAULT 0,
  addon_images_balance INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agency_month_usage (
  id SERIAL PRIMARY KEY,
  agency_id TEXT NOT NULL,
  yyyymm TEXT NOT NULL,
  included_limit INTEGER NOT NULL,
  included_used INTEGER NOT NULL DEFAULT 0,
  addon_used INTEGER NOT NULL DEFAULT 0,
  stage12_used INTEGER NOT NULL DEFAULT 0,
  stage2_used INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agency_id, yyyymm)
);

CREATE TYPE reservation_status AS ENUM ('reserved', 'consumed', 'released', 'partially_released');

CREATE TABLE IF NOT EXISTS job_reservations (
  job_id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  yyyymm TEXT NOT NULL,
  requested_stage12 BOOLEAN NOT NULL DEFAULT TRUE,
  requested_stage2 BOOLEAN NOT NULL DEFAULT FALSE,
  reserved_images INTEGER NOT NULL,
  reservation_status reservation_status NOT NULL DEFAULT 'reserved',
  reserved_stage12 BOOLEAN NOT NULL DEFAULT TRUE,
  reserved_stage2 BOOLEAN NOT NULL DEFAULT FALSE,
  reserved_from_included INTEGER NOT NULL DEFAULT 0,
  reserved_from_addon INTEGER NOT NULL DEFAULT 0,
  stage12_from_included INTEGER NOT NULL DEFAULT 0,
  stage12_from_addon INTEGER NOT NULL DEFAULT 0,
  stage2_from_included INTEGER NOT NULL DEFAULT 0,
  stage2_from_addon INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  edit_count INTEGER NOT NULL DEFAULT 0,
  amendments_locked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS addon_purchases (
  id SERIAL PRIMARY KEY,
  agency_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  source TEXT NOT NULL,
  metadata JSONB,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_reservations_agency ON job_reservations(agency_id);
CREATE INDEX IF NOT EXISTS idx_agency_month_usage_agency ON agency_month_usage(agency_id);

COMMIT;
