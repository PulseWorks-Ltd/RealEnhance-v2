/**
 * Enhanced Images Database Operations (Worker Side)
 *
 * Creates enhanced_images records after successful job completion.
 * This provides traceability and enables the "Previously Enhanced Images" feature.
 */

import { pool } from './index.js';

interface CreateEnhancedImageParams {
  agencyId: string;
  userId: string;
  jobId: string;
  stagesCompleted: string[];
  publicUrl: string;
  thumbnailUrl?: string;
  originalUrl?: string | null;
  originalS3Key?: string | null;
  enhancedS3Key?: string | null;
  thumbS3Key?: string | null;
  auditRef: string;
  traceId: string;
}

/**
 * Create enhanced_images record after successful job completion
 * This is called from the worker after publishing the final image.
 *
 * IMPORTANT: This is fail-safe - if it fails, log but don't block the job.
 */
export async function recordEnhancedImage(params: CreateEnhancedImageParams): Promise<void> {

  try {
    // Extract storage key from URL (remove protocol and domain)
    const storageKey = extractStorageKey(params.publicUrl);

    await pool.query(
      `INSERT INTO enhanced_images (
        agency_id, user_id, job_id, stages_completed,
        storage_key, public_url, thumbnail_url,
        original_s3_key, enhanced_s3_key, thumb_s3_key, remote_original_url,
        audit_ref, trace_id,
        is_expired
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, FALSE)
      ON CONFLICT (job_id) DO NOTHING`,
      [
        params.agencyId,
        params.userId,
        params.jobId,
        params.stagesCompleted,
        storageKey,
        params.publicUrl,
        params.thumbnailUrl || params.publicUrl,
        params.originalS3Key || null,
        params.enhancedS3Key || storageKey,
        params.thumbS3Key || storageKey,
        params.originalUrl || null,
        params.auditRef,
        params.traceId,
      ]
    );

    console.log(`[enhanced-images] Recorded: ${params.auditRef} for job ${params.jobId}`);
  } catch (error) {
    // FAIL-SAFE: Log but don't throw - this is not critical for job completion
    console.error(`[enhanced-images] Failed to record image for job ${params.jobId}:`, error);
  }
}

/**
 * Extract storage key from S3 URL
 * Handles both direct S3 URLs and CDN URLs
 */
function extractStorageKey(url: string): string {
  try {
    const urlObj = new URL(url);

    // Handle S3 direct URLs: https://bucket.s3.region.amazonaws.com/key
    if (urlObj.hostname.includes('.s3.') || urlObj.hostname.includes('.s3-')) {
      return urlObj.pathname.slice(1); // Remove leading /
    }

    // Handle CDN URLs: pathname is the key
    return urlObj.pathname.slice(1); // Remove leading /
  } catch (error) {
    console.error('[enhanced-images] Failed to parse S3 URL:', url, error);
    // Fallback: return URL as-is if parsing fails
    return url;
  }
}
