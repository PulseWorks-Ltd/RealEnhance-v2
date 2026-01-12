-- Add S3 key columns for originals/enhanced/thumbs and legacy remote original URL
ALTER TABLE enhanced_images
  ADD COLUMN IF NOT EXISTS original_s3_key TEXT,
  ADD COLUMN IF NOT EXISTS enhanced_s3_key TEXT,
  ADD COLUMN IF NOT EXISTS thumb_s3_key TEXT,
  ADD COLUMN IF NOT EXISTS remote_original_url TEXT;

-- Backfill enhanced_s3_key from existing storage_key when empty
UPDATE enhanced_images SET enhanced_s3_key = storage_key WHERE enhanced_s3_key IS NULL;

-- Optional: keep thumbnail aligned if missing
UPDATE enhanced_images SET thumb_s3_key = storage_key WHERE thumb_s3_key IS NULL AND thumbnail_url = public_url;
