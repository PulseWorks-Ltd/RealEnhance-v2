-- Global Stripe webhook idempotency ledger.
-- Each Stripe event.id can be claimed exactly once.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
