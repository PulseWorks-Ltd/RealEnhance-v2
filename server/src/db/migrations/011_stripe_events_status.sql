-- Add processing status to Stripe webhook idempotency ledger for basic auditability.
ALTER TABLE stripe_events
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processed';
