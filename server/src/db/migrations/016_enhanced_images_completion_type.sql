-- Migration: Add completion_type metadata to enhanced_images
-- Created: 2026-05-14
-- Purpose: Distinguish full-success vs fallback completions for analytics/debugging.

ALTER TABLE enhanced_images
  ADD COLUMN IF NOT EXISTS completion_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'enhanced_images_completion_type_check'
  ) THEN
    ALTER TABLE enhanced_images
      ADD CONSTRAINT enhanced_images_completion_type_check
      CHECK (completion_type IN ('full_success', 'fallback_1b', 'fallback_1a'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_enhanced_images_completion_type
  ON enhanced_images(completion_type)
  WHERE deleted_at IS NULL;
