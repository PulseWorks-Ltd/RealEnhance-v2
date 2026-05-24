-- Migration: Expand enhanced_images completion_type contract to match runtime semantics
-- Created: 2026-05-21
-- Purpose: Keep database constraint aligned with worker/server completion type definitions.

ALTER TABLE enhanced_images
  DROP CONSTRAINT IF EXISTS enhanced_images_completion_type_check;

ALTER TABLE enhanced_images
  ADD CONSTRAINT enhanced_images_completion_type_check
  CHECK (
    completion_type IS NULL OR completion_type IN (
      'full_success',
      'fallback_1b',
      'fallback_1a',
      'intentional_1a_success',
      'optimized_1a_success'
    )
  );