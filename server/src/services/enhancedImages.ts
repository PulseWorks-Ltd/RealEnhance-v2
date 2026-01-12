/**
 * Enhanced Images Service
 *
 * Manages previously enhanced images with quota-bound retention.
 * Retention window: up to 3 months of plan allowance (monthly_included_images * 3)
 * Oldest images expire first (FIFO).
 */

import { pool } from '../db/index.js';
import type { EnhancedImage, EnhancedImageListItem } from '@realenhance/shared/types';
import { generateAuditRef, generateTraceId, extractStorageKey } from '../utils/audit.js';
import { getS3SignedUrl, deleteS3Object } from '../utils/s3.js';

// Best-effort signer with short TTL; falls back to null if signing fails or key missing
async function safeSign(key?: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    return await getS3SignedUrl(key, 900); // 15 minutes
  } catch (err) {
    console.warn('[enhanced-images] Failed to sign URL', key, err);
    return null;
  }
}

/**
 * LAZY CLEANUP APPROACH (V1)
 *
 * Retention is enforced lazily:
 * - On list/read operations, count retained images
 * - If count > max allowed, expire oldest images
 * - Expired images are immediately hidden from UI
 *
 * Why lazy cleanup?
 * - Simpler implementation for launch
 * - No background job infrastructure required
 * - Automatic enforcement on every read
 * - Storage deletion can be done async (optional)
 *
 * Future: Consider background cleanup job for storage deletion
 */

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
  sizeBytes?: number;
  contentType?: string;
  traceId?: string;
  stage12AttemptId?: string;
  stage2AttemptId?: string;
}

/**
 * Create a new enhanced image record
 * Automatically generates audit_ref and enforces retention limits
 */
export async function createEnhancedImage(
  params: CreateEnhancedImageParams
): Promise<EnhancedImage> {

  const auditRef = generateAuditRef();
  const traceId = params.traceId || generateTraceId(params.jobId);
  const storageKey = extractStorageKey(params.publicUrl);
  const enhancedKey = params.enhancedS3Key || storageKey;
  const thumbKey = params.thumbS3Key || (params.thumbnailUrl ? extractStorageKey(params.thumbnailUrl) : enhancedKey);
  const originalKey = params.originalS3Key || (params.originalUrl ? extractStorageKey(params.originalUrl) : null);

  const result = await pool.query(
    `INSERT INTO enhanced_images (
      agency_id, user_id, job_id, stages_completed,
      storage_key, public_url, thumbnail_url,
      original_s3_key, enhanced_s3_key, thumb_s3_key, remote_original_url,
      size_bytes, content_type,
      audit_ref, trace_id,
      stage12_attempt_id, stage2_attempt_id,
      is_expired
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, FALSE)
    ON CONFLICT (job_id) DO UPDATE SET
      updated_at = NOW()
    RETURNING *`,
    [
      params.agencyId,
      params.userId,
      params.jobId,
      params.stagesCompleted,
      storageKey,
      params.publicUrl,
      params.thumbnailUrl || params.publicUrl,
      originalKey,
      enhancedKey,
      thumbKey,
      params.originalUrl || null,
      params.sizeBytes || null,
      params.contentType || 'image/jpeg',
      auditRef,
      traceId,
      params.stage12AttemptId || null,
      params.stage2AttemptId || null,
    ]
  );

  const row = result.rows[0];
  console.log(`[enhanced-images] Created record: ${row.audit_ref} for job ${params.jobId}`);

  // Enforce retention limits after insert
  await enforceRetentionLimits(params.agencyId);

  return dbRowToEnhancedImage(row);
}

/**
 * Get enhanced images for a user or agency
 * Enforces retention limits before returning results
 *
 * @param agencyId - Agency ID to filter by
 * @param userId - Optional: If provided, only return user's images (for non-admin users)
 * @param limit - Max number of results to return (default: 100)
 * @param offset - Pagination offset (default: 0)
 */
export async function listEnhancedImages(
  agencyId: string,
  userId?: string,
  limit: number = 100,
  offset: number = 0
): Promise<{ images: EnhancedImageListItem[]; total: number }> {

  // Enforce retention before listing (lazy cleanup)
  await enforceRetentionLimits(agencyId);

    const baseQuery = userId
     ? `SELECT id, public_url, thumbnail_url, stages_completed, created_at, audit_ref,
       original_s3_key, enhanced_s3_key, thumb_s3_key, remote_original_url, storage_key
       FROM enhanced_images
       WHERE agency_id = $1 AND user_id = $2 AND is_expired = FALSE
       ORDER BY created_at DESC`
     : `SELECT id, public_url, thumbnail_url, stages_completed, created_at, audit_ref,
       original_s3_key, enhanced_s3_key, thumb_s3_key, remote_original_url, storage_key
       FROM enhanced_images
       WHERE agency_id = $1 AND is_expired = FALSE
       ORDER BY created_at DESC`;

  const countQuery = userId
    ? `SELECT COUNT(*) FROM enhanced_images WHERE agency_id = $1 AND user_id = $2 AND is_expired = FALSE`
    : `SELECT COUNT(*) FROM enhanced_images WHERE agency_id = $1 AND is_expired = FALSE`;

  const params = userId ? [agencyId, userId] : [agencyId];

  const [listResult, countResult] = await Promise.all([
    pool.query(baseQuery + ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      limit,
      offset,
    ]),
    pool.query(countQuery, params),
  ]);

  const images: EnhancedImageListItem[] = [];
  for (const row of listResult.rows) {
    const enhancedKey = row.enhanced_s3_key || row.storage_key || null;
    const thumbKey = row.thumb_s3_key || row.storage_key || null;
    const originalKey = row.original_s3_key || null;

    const signedEnhanced = enhancedKey ? await safeSign(enhancedKey) : row.public_url;
    const signedThumb = thumbKey ? await safeSign(thumbKey) : row.thumbnail_url;
    const signedOriginal = originalKey ? await safeSign(originalKey) : (row.remote_original_url || null);

    images.push({
      id: row.id,
      thumbnailUrl: signedThumb || row.thumbnail_url,
      publicUrl: signedEnhanced || row.public_url,
      originalUrl: signedOriginal,
      stagesCompleted: row.stages_completed,
      createdAt: row.created_at,
      auditRef: row.audit_ref,
    });
  }

  const total = parseInt(countResult.rows[0].count, 10);

  return { images, total };
}

/**
 * Get a single enhanced image by ID
 * Enforces retention and permissions
 *
 * @param imageId - UUID of the enhanced image
 * @param agencyId - Agency ID for permission check
 * @param userId - Optional: User ID for additional permission check
 */
export async function getEnhancedImage(
  imageId: string,
  agencyId: string,
  userId?: string
): Promise<EnhancedImage | null> {

  // Enforce retention before retrieval (lazy cleanup)
  await enforceRetentionLimits(agencyId);

  const query = userId
    ? `SELECT * FROM enhanced_images
       WHERE id = $1 AND agency_id = $2 AND user_id = $3 AND is_expired = FALSE`
    : `SELECT * FROM enhanced_images
       WHERE id = $1 AND agency_id = $2 AND is_expired = FALSE`;

  const params = userId ? [imageId, agencyId, userId] : [imageId, agencyId];

  const result = await pool.query(query, params);

  if (result.rows.length === 0) {
    return null;
  }

  return await dbRowToEnhancedImage(result.rows[0]);
}

/**
 * Enforce retention limits for an agency (LAZY CLEANUP)
 *
 * Retention formula: max_retained = monthly_included_images * 3
 *
 * If current count > max_retained:
 * - Mark oldest images as expired (is_expired = TRUE)
 * - Images immediately hidden from UI
 * - Storage deletion can be done async (future enhancement)
 */
async function enforceRetentionLimits(agencyId: string): Promise<void> {

  try {
    // Get agency plan allowance
    const agencyResult = await pool.query(
      `SELECT monthly_included_images FROM agency_accounts WHERE agency_id = $1`,
      [agencyId]
    );

    if (agencyResult.rows.length === 0) {
      console.warn(`[retention] Agency ${agencyId} not found, skipping retention enforcement`);
      return;
    }

    const monthlyAllowance = agencyResult.rows[0].monthly_included_images || 0;
    const maxRetained = monthlyAllowance * 3; // 3 months of allowance

    if (maxRetained === 0) {
      console.warn(`[retention] Agency ${agencyId} has 0 allowance, skipping retention`);
      return;
    }

    // Count current non-expired images
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM enhanced_images WHERE agency_id = $1 AND is_expired = FALSE`,
      [agencyId]
    );

    const currentCount = parseInt(countResult.rows[0].count, 10);

    if (currentCount <= maxRetained) {
      // Within limits, no action needed
      return;
    }

    // Expire oldest images (FIFO)
    const excessCount = currentCount - maxRetained;

    const expireResult = await pool.query(
      `UPDATE enhanced_images
       SET is_expired = TRUE, updated_at = NOW()
       WHERE id IN (
         SELECT id FROM enhanced_images
         WHERE agency_id = $1 AND is_expired = FALSE
         ORDER BY created_at ASC
         LIMIT $2
       )
       RETURNING id, audit_ref, created_at, original_s3_key, enhanced_s3_key, thumb_s3_key`,
      [agencyId, excessCount]
    );

    if (expireResult.rows.length > 0) {
      console.log(
        `[retention] Expired ${expireResult.rows.length} images for agency ${agencyId} (max: ${maxRetained}, had: ${currentCount})`
      );

      // Log expired images for audit trail
      expireResult.rows.forEach((row) => {
        console.log(
          `[retention] Expired image ${row.audit_ref} (created: ${row.created_at})`
        );
      });

      // Best-effort storage cleanup for expired items
      for (const row of expireResult.rows) {
        const keys = [row.original_s3_key, row.enhanced_s3_key, row.thumb_s3_key].filter(Boolean) as string[];
        for (const key of keys) {
          deleteS3Object(key).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.error(`[retention] Failed to enforce retention for agency ${agencyId}:`, error);
    // Non-blocking: don't fail the request if retention enforcement fails
  }
}

/**
 * Convert database row to EnhancedImage type
 */
async function dbRowToEnhancedImage(row: any): Promise<EnhancedImage> {
  const enhancedKey = row.enhanced_s3_key || row.storage_key || null;
  const thumbKey = row.thumb_s3_key || row.storage_key || null;
  const originalKey = row.original_s3_key || null;

  const publicUrl = enhancedKey ? (await safeSign(enhancedKey)) || row.public_url : row.public_url;
  const thumbnailUrl = thumbKey ? (await safeSign(thumbKey)) || row.thumbnail_url : row.thumbnail_url;
  const originalUrl = originalKey ? await safeSign(originalKey) : (row.remote_original_url || null);

  return {
    id: row.id,
    agencyId: row.agency_id,
    userId: row.user_id,
    jobId: row.job_id,
    stagesCompleted: row.stages_completed,
    storageKey: row.storage_key,
    publicUrl,
    thumbnailUrl,
    originalUrl,
    originalS3Key: originalKey,
    enhancedS3Key: enhancedKey,
    thumbS3Key: thumbKey,
    sizeBytes: row.size_bytes,
    contentType: row.content_type,
    isExpired: row.is_expired,
    expiresAt: row.expires_at,
    auditRef: row.audit_ref,
    traceId: row.trace_id,
    stage12AttemptId: row.stage12_attempt_id,
    stage2AttemptId: row.stage2_attempt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Delete expired images from storage (OPTIONAL - for future use)
 * This can be called from a background job or cleanup script
 *
 * @param agencyId - Optional: Limit to specific agency
 * @param batchSize - Number of images to delete per batch
 */
export async function deleteExpiredImagesFromStorage(
  agencyId?: string,
  batchSize: number = 100
): Promise<number> {

  // TODO: Implement S3 deletion logic
  // 1. Query expired images with storage_key
  // 2. Delete from S3
  // 3. Delete database records (or mark as deleted)

  console.log('[cleanup] Storage deletion not yet implemented');
  return 0;
}
