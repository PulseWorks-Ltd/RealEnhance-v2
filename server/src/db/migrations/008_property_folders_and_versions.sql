-- Migration: Property folders + version history fields on enhanced_images
-- Created: 2026-03-06

-- ---------------------------------------------------------------------------
-- PROPERTY FOLDERS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  address TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_agency_normalized_unique
  ON properties (agency_id, normalized_address);

CREATE INDEX IF NOT EXISTS idx_properties_agency_id
  ON properties (agency_id);

CREATE INDEX IF NOT EXISTS idx_properties_created_by
  ON properties (created_by_user_id);

-- ---------------------------------------------------------------------------
-- ENHANCED IMAGES EXTENSIONS
-- ---------------------------------------------------------------------------
ALTER TABLE enhanced_images
  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_image_id UUID REFERENCES enhanced_images(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source TEXT;

UPDATE enhanced_images
SET source = 'stage2'
WHERE source IS NULL;

ALTER TABLE enhanced_images
  ALTER COLUMN source SET DEFAULT 'stage2';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'enhanced_images_source_check'
  ) THEN
    ALTER TABLE enhanced_images
      ADD CONSTRAINT enhanced_images_source_check
      CHECK (source IN ('stage2', 'region-edit'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_enhanced_images_property_id
  ON enhanced_images(property_id);

CREATE INDEX IF NOT EXISTS idx_enhanced_images_parent_image_id
  ON enhanced_images(parent_image_id);

CREATE INDEX IF NOT EXISTS idx_enhanced_images_source
  ON enhanced_images(source);
