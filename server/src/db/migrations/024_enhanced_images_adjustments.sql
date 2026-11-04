-- Migration: Photo Adjust (non-destructive slider edits)
-- Created: 2026-11-04
-- Purpose: store the slider values with each adjusted version, and allow
-- source = 'adjust' for versions saved from the Adjust tool.

ALTER TABLE enhanced_images
  ADD COLUMN IF NOT EXISTS adjustments JSONB;

ALTER TABLE enhanced_images
  DROP CONSTRAINT IF EXISTS enhanced_images_source_check;

ALTER TABLE enhanced_images
  ADD CONSTRAINT enhanced_images_source_check
  CHECK (source IN ('stage2', 'region-edit', 'adjust'));
