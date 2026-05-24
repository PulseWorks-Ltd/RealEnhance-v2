-- Migration: Introduce orthogonal semantic dimensions for enhanced image outcomes
-- Created: 2026-05-21
-- Purpose: Separate user outcome, execution mode, and persistence status while
-- retaining backward-compatible completion_type.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enhanced_image_user_outcome_enum') THEN
    CREATE TYPE enhanced_image_user_outcome_enum AS ENUM (
      'success',
      'partial_success',
      'failed'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enhanced_image_execution_mode_enum') THEN
    CREATE TYPE enhanced_image_execution_mode_enum AS ENUM (
      'full_pipeline',
      'fallback_1b',
      'fallback_1a',
      'intentional_1a',
      'optimized_1a',
      'stage2_repair'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enhanced_image_persistence_status_enum') THEN
    CREATE TYPE enhanced_image_persistence_status_enum AS ENUM (
      'recorded',
      'recorded_with_warnings',
      'pending_repair'
    );
  END IF;
END $$;

ALTER TABLE enhanced_images
  ADD COLUMN IF NOT EXISTS user_outcome enhanced_image_user_outcome_enum,
  ADD COLUMN IF NOT EXISTS execution_mode enhanced_image_execution_mode_enum,
  ADD COLUMN IF NOT EXISTS persistence_status enhanced_image_persistence_status_enum;

UPDATE enhanced_images
SET
  execution_mode = CASE completion_type
    WHEN 'fallback_1b' THEN 'fallback_1b'::enhanced_image_execution_mode_enum
    WHEN 'fallback_1a' THEN 'fallback_1a'::enhanced_image_execution_mode_enum
    WHEN 'intentional_1a_success' THEN 'intentional_1a'::enhanced_image_execution_mode_enum
    WHEN 'optimized_1a_success' THEN 'optimized_1a'::enhanced_image_execution_mode_enum
    ELSE 'full_pipeline'::enhanced_image_execution_mode_enum
  END,
  user_outcome = CASE completion_type
    WHEN 'fallback_1a' THEN 'partial_success'::enhanced_image_user_outcome_enum
    ELSE 'success'::enhanced_image_user_outcome_enum
  END,
  persistence_status = COALESCE(
    persistence_status,
    'recorded'::enhanced_image_persistence_status_enum
  )
WHERE execution_mode IS NULL OR user_outcome IS NULL OR persistence_status IS NULL;

ALTER TABLE enhanced_images
  ALTER COLUMN execution_mode SET DEFAULT 'full_pipeline'::enhanced_image_execution_mode_enum,
  ALTER COLUMN user_outcome SET DEFAULT 'success'::enhanced_image_user_outcome_enum,
  ALTER COLUMN persistence_status SET DEFAULT 'recorded'::enhanced_image_persistence_status_enum;

ALTER TABLE enhanced_images
  ALTER COLUMN execution_mode SET NOT NULL,
  ALTER COLUMN user_outcome SET NOT NULL,
  ALTER COLUMN persistence_status SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_enhanced_images_user_outcome
  ON enhanced_images(user_outcome)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_enhanced_images_execution_mode
  ON enhanced_images(execution_mode)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_enhanced_images_persistence_status
  ON enhanced_images(persistence_status)
  WHERE deleted_at IS NULL;