-- Migration: Enhanced Images History with Quota-Bound Retention
-- Created: 2026-01-12
-- Purpose: Store previously enhanced images with FIFO retention based on plan quota

-- ============================================================================
-- ENHANCEMENT_ATTEMPTS: Audit trail for all enhancement attempts
-- ============================================================================
-- Provides full traceability from stored images back to validator decisions
-- and model outputs. NEVER expose validator details to users.

CREATE TABLE IF NOT EXISTS enhancement_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('stage12', 'stage2', 'edit', 'region_edit')),
  attempt_number INTEGER NOT NULL DEFAULT 1,

  -- Model & prompt tracking
  model_used TEXT, -- e.g., "gemini-1.5-flash-002"
  prompt_version TEXT, -- e.g., "v2.1" or hash for reproducibility

  -- Validator results (INTERNAL ONLY - never expose to users)
  validator_passed BOOLEAN DEFAULT NULL,
  validator_summary_internal JSONB DEFAULT NULL, -- scores, warnings, structural checks

  -- Traceability
  trace_id TEXT NOT NULL, -- correlates with worker logs

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Index for job lookup
  CONSTRAINT enhancement_attempts_job_stage_key UNIQUE (job_id, stage, attempt_number)
);

CREATE INDEX idx_enhancement_attempts_job_id ON enhancement_attempts(job_id);
CREATE INDEX idx_enhancement_attempts_trace_id ON enhancement_attempts(trace_id);
CREATE INDEX idx_enhancement_attempts_created_at ON enhancement_attempts(created_at);

-- ============================================================================
-- ENHANCED_IMAGES: Stored enhanced images with quota-bound retention
-- ============================================================================
-- Retention window: up to 3 months of plan allowance (monthly_included_images * 3)
-- Oldest images expire first (FIFO). Users must download images they want to keep.

CREATE TABLE IF NOT EXISTS enhanced_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership & scoping
  agency_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,

  -- Stage completion tracking
  stages_completed TEXT[] NOT NULL DEFAULT '{}', -- e.g., ['1A', '1B', '2'] or ['1A', '2']

  -- Storage
  storage_key TEXT NOT NULL, -- S3 key (e.g., "realenhance/outputs/1736640000000-enhanced.jpg")
  public_url TEXT NOT NULL, -- Full public URL for direct access
  thumbnail_url TEXT, -- Optional thumbnail for gallery view (can be same as public_url)

  -- File metadata
  size_bytes BIGINT, -- File size in bytes (for storage cost tracking)
  content_type TEXT DEFAULT 'image/jpeg',

  -- Retention & expiry
  is_expired BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ, -- Computed based on retention policy (optional)

  -- Audit & traceability (NEVER expose validator details to users)
  audit_ref TEXT NOT NULL UNIQUE, -- Short human-friendly reference (e.g., "RE-7F3K9Q")
  trace_id TEXT NOT NULL, -- Correlates with worker logs and attempts
  stage12_attempt_id UUID REFERENCES enhancement_attempts(attempt_id) ON DELETE SET NULL,
  stage2_attempt_id UUID REFERENCES enhancement_attempts(attempt_id) ON DELETE SET NULL,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Ensure one record per job (idempotency)
  CONSTRAINT enhanced_images_job_id_key UNIQUE (job_id)
);

-- Indexes for efficient querying
CREATE INDEX idx_enhanced_images_agency_id ON enhanced_images(agency_id);
CREATE INDEX idx_enhanced_images_user_id ON enhanced_images(user_id);
CREATE INDEX idx_enhanced_images_agency_user ON enhanced_images(agency_id, user_id);
CREATE INDEX idx_enhanced_images_created_at ON enhanced_images(created_at);
CREATE INDEX idx_enhanced_images_is_expired ON enhanced_images(is_expired) WHERE is_expired = FALSE;
CREATE INDEX idx_enhanced_images_audit_ref ON enhanced_images(audit_ref);
CREATE INDEX idx_enhanced_images_trace_id ON enhanced_images(trace_id);

-- Combined index for efficient retention queries (agency + created_at)
CREATE INDEX idx_enhanced_images_agency_retention ON enhanced_images(agency_id, created_at DESC)
  WHERE is_expired = FALSE;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE enhancement_attempts IS 'Audit trail for all enhancement attempts. Provides full traceability to validator decisions. INTERNAL USE ONLY.';
COMMENT ON COLUMN enhancement_attempts.validator_summary_internal IS 'Validator results (scores, warnings, structural checks). NEVER expose to users.';
COMMENT ON COLUMN enhancement_attempts.trace_id IS 'Correlates with worker logs for debugging.';

COMMENT ON TABLE enhanced_images IS 'Previously enhanced images with quota-bound retention (3 months of plan allowance). FIFO expiry.';
COMMENT ON COLUMN enhanced_images.audit_ref IS 'Short human-friendly reference for support. May be shown to users as generic "Support reference".';
COMMENT ON COLUMN enhanced_images.trace_id IS 'Correlates with worker logs and enhancement_attempts. NEVER expose validator details.';
COMMENT ON COLUMN enhanced_images.is_expired IS 'Expired images are hidden from UI and may be deleted from storage.';
COMMENT ON COLUMN enhanced_images.stages_completed IS 'Array of completed stages (e.g., [''1A'', ''1B'', ''2'']). Used for UI display.';
