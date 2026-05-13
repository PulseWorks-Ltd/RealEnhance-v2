-- Migration: User soft-delete support for enhanced images gallery
-- Created: 2026-05-13

ALTER TABLE enhanced_images
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS purge_status TEXT,
  ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

UPDATE enhanced_images
SET purge_status = 'not_queued'
WHERE purge_status IS NULL;

ALTER TABLE enhanced_images
  ALTER COLUMN purge_status SET DEFAULT 'not_queued';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'enhanced_images_purge_status_check'
  ) THEN
    ALTER TABLE enhanced_images
      ADD CONSTRAINT enhanced_images_purge_status_check
      CHECK (purge_status IN ('not_queued', 'pending', 'purged', 'failed', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_enhanced_images_deleted_at
  ON enhanced_images(deleted_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_enhanced_images_purge_status
  ON enhanced_images(purge_status)
  WHERE deleted_at IS NOT NULL;
