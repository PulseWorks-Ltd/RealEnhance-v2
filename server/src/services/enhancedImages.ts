/**
 * Enhanced Images Service
 *
 * Manages previously enhanced images with quota-bound retention,
 * property-folder grouping, and version lineage.
 */

import { pool } from '../db/index.js';
import type {
  EnhancedImage,
  EnhancedImageGalleryResponse,
  EnhancedImageListItem,
} from '@realenhance/shared/types';
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

interface CreateEnhancedImageParams {
  agencyId: string;
  userId: string;
  jobId: string;
  propertyId?: string | null;
  parentImageId?: string | null;
  source?: 'stage2' | 'region-edit';
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

interface Scope {
  agencyId: string;
  userId?: string;
}

/**
 * Create a new enhanced image record.
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
      property_id, parent_image_id, source,
      storage_key, public_url, thumbnail_url,
      original_s3_key, enhanced_s3_key, thumb_s3_key, remote_original_url,
      size_bytes, content_type,
      audit_ref, trace_id,
      stage12_attempt_id, stage2_attempt_id,
      is_expired
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, FALSE)
    ON CONFLICT (job_id) DO UPDATE SET
      updated_at = NOW()
    RETURNING *`,
    [
      params.agencyId,
      params.userId,
      params.jobId,
      params.stagesCompleted,
      params.propertyId || null,
      params.parentImageId || null,
      params.source || 'stage2',
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

  await enforceRetentionLimits(params.agencyId);

  return dbRowToEnhancedImage(row);
}

function scopedWhereClause(scope: Scope, startParam: number = 1): { sql: string; params: any[] } {
  const clauses = [`ei.agency_id = $${startParam}`, 'ei.is_expired = FALSE'];
  const params: any[] = [scope.agencyId];

  if (scope.userId) {
    clauses.push(`ei.user_id = $${startParam + 1}`);
    params.push(scope.userId);
  }

  return {
    sql: clauses.join(' AND '),
    params,
  };
}

/**
 * Grouped gallery payload: property folders + unassigned images.
 */
export async function listEnhancedImages(
  agencyId: string,
  userId?: string,
  limit: number = 100,
  offset: number = 0
): Promise<EnhancedImageGalleryResponse> {
  await enforceRetentionLimits(agencyId);

  const scope = { agencyId, userId };
  const scoped = scopedWhereClause(scope);

  const listSql = `
    SELECT
      ei.id,
      ei.public_url,
      ei.thumbnail_url,
      ei.stages_completed,
      ei.created_at,
      ei.audit_ref,
      ei.original_s3_key,
      ei.enhanced_s3_key,
      ei.thumb_s3_key,
      ei.remote_original_url,
      ei.storage_key,
      ei.property_id,
      ei.parent_image_id,
      ei.source,
      p.address AS property_address,
      p.normalized_address AS property_normalized_address,
      (
        SELECT COUNT(*)::int
        FROM enhanced_images c
        WHERE c.parent_image_id = ei.id
          AND c.is_expired = FALSE
          AND c.agency_id = ei.agency_id
          ${userId ? 'AND c.user_id = ei.user_id' : ''}
      ) AS version_count
    FROM enhanced_images ei
    LEFT JOIN properties p ON p.id = ei.property_id
    WHERE ${scoped.sql}
    ORDER BY ei.created_at DESC
    LIMIT $${scoped.params.length + 1}
    OFFSET $${scoped.params.length + 2}
  `;

  const countSql = `
    SELECT COUNT(*)
    FROM enhanced_images ei
    WHERE ${scoped.sql}
  `;

  const [listResult, countResult] = await Promise.all([
    pool.query(listSql, [...scoped.params, limit, offset]),
    pool.query(countSql, scoped.params),
  ]);

  const propertyMap = new Map<string, { id: string; address: string; normalizedAddress: string; images: EnhancedImageListItem[] }>();
  const unassignedImages: EnhancedImageListItem[] = [];
  const flatImages: EnhancedImageListItem[] = [];

  for (const row of listResult.rows) {
    const enhancedKey = row.enhanced_s3_key || row.storage_key || null;
    const thumbKey = row.thumb_s3_key || row.storage_key || null;
    const originalKey = row.original_s3_key || null;

    const signedEnhanced = enhancedKey ? await safeSign(enhancedKey) : row.public_url;
    const signedThumb = thumbKey ? await safeSign(thumbKey) : row.thumbnail_url;
    const signedOriginal = originalKey ? await safeSign(originalKey) : (row.remote_original_url || null);

    const image: EnhancedImageListItem = {
      id: row.id,
      thumbnailUrl: signedThumb || row.thumbnail_url,
      publicUrl: signedEnhanced || row.public_url,
      originalUrl: signedOriginal,
      stagesCompleted: row.stages_completed,
      createdAt: row.created_at,
      auditRef: row.audit_ref,
      propertyId: row.property_id,
      parentImageId: row.parent_image_id,
      source: row.source,
      versionCount: Number(row.version_count || 0),
    };

    flatImages.push(image);

    if (row.property_id) {
      if (!propertyMap.has(row.property_id)) {
        propertyMap.set(row.property_id, {
          id: row.property_id,
          address: row.property_address || 'Untitled Property',
          normalizedAddress: row.property_normalized_address || '',
          images: [],
        });
      }
      propertyMap.get(row.property_id)!.images.push(image);
    } else {
      unassignedImages.push(image);
    }
  }

  const properties = Array.from(propertyMap.values()).sort((a, b) => a.address.localeCompare(b.address));
  const total = parseInt(countResult.rows[0].count, 10);

  return {
    properties,
    unassignedImages,
    total,
    images: flatImages,
  };
}

/**
 * Get one image with scoped access checks.
 */
export async function getEnhancedImage(
  imageId: string,
  agencyId: string,
  userId?: string
): Promise<EnhancedImage | null> {
  await enforceRetentionLimits(agencyId);

  const query = userId
    ? `SELECT * FROM enhanced_images
       WHERE id = $1 AND agency_id = $2 AND user_id = $3 AND is_expired = FALSE`
    : `SELECT * FROM enhanced_images
       WHERE id = $1 AND agency_id = $2 AND is_expired = FALSE`;

  const params = userId ? [imageId, agencyId, userId] : [imageId, agencyId];
  const result = await pool.query(query, params);

  if (result.rows.length === 0) return null;
  return dbRowToEnhancedImage(result.rows[0]);
}

/**
 * Version history endpoint helper.
 */
export async function getImageVersions(
  imageId: string,
  agencyId: string,
  userId?: string
): Promise<EnhancedImageListItem[]> {
  await enforceRetentionLimits(agencyId);

  const where = userId
    ? `agency_id = $1 AND user_id = $2 AND is_expired = FALSE AND (id = $3 OR parent_image_id = $3)`
    : `agency_id = $1 AND is_expired = FALSE AND (id = $2 OR parent_image_id = $2)`;

  const params = userId ? [agencyId, userId, imageId] : [agencyId, imageId];

  const result = await pool.query(
    `SELECT id, public_url, thumbnail_url, stages_completed, created_at, audit_ref,
            original_s3_key, enhanced_s3_key, thumb_s3_key, remote_original_url, storage_key,
            property_id, parent_image_id, source
     FROM enhanced_images
     WHERE ${where}
     ORDER BY created_at ASC`,
    params
  );

  const images: EnhancedImageListItem[] = [];
  for (const row of result.rows) {
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
      propertyId: row.property_id,
      parentImageId: row.parent_image_id,
      source: row.source,
      versionCount: 0,
    });
  }

  return images;
}

/**
 * Resolve an enhanced_images row by URL in scoped access context.
 * Used by region-edit to set parentImageId/propertyId lineage.
 */
export async function findScopedEnhancedImageByUrl(params: {
  agencyId: string;
  userId?: string;
  publicUrl: string;
}): Promise<{ id: string; propertyId: string | null; userId: string; agencyId: string } | null> {
  const query = params.userId
    ? `SELECT id, property_id, user_id, agency_id
       FROM enhanced_images
       WHERE agency_id = $1
         AND user_id = $2
         AND is_expired = FALSE
         AND (
           split_part(public_url, '?', 1) = split_part($3, '?', 1)
           OR split_part(thumbnail_url, '?', 1) = split_part($3, '?', 1)
         )
       ORDER BY created_at DESC
       LIMIT 1`
    : `SELECT id, property_id, user_id, agency_id
       FROM enhanced_images
       WHERE agency_id = $1
         AND is_expired = FALSE
         AND (
           split_part(public_url, '?', 1) = split_part($2, '?', 1)
           OR split_part(thumbnail_url, '?', 1) = split_part($2, '?', 1)
         )
       ORDER BY created_at DESC
       LIMIT 1`;

  const args = params.userId
    ? [params.agencyId, params.userId, params.publicUrl]
    : [params.agencyId, params.publicUrl];

  const result = await pool.query(query, args);
  if (result.rows.length === 0) return null;

  return {
    id: result.rows[0].id,
    propertyId: result.rows[0].property_id,
    userId: result.rows[0].user_id,
    agencyId: result.rows[0].agency_id,
  };
}

async function enforceRetentionLimits(agencyId: string): Promise<void> {
  try {
    const agencyResult = await pool.query(
      `SELECT monthly_included_images FROM agency_accounts WHERE agency_id = $1`,
      [agencyId]
    );

    if (agencyResult.rows.length === 0) {
      console.warn(`[retention] Agency ${agencyId} not found, skipping retention enforcement`);
      return;
    }

    const monthlyAllowance = agencyResult.rows[0].monthly_included_images || 0;
    const maxRetained = monthlyAllowance * 3;

    if (maxRetained === 0) {
      console.warn(`[retention] Agency ${agencyId} has 0 allowance, skipping retention`);
      return;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM enhanced_images WHERE agency_id = $1 AND is_expired = FALSE`,
      [agencyId]
    );

    const currentCount = parseInt(countResult.rows[0].count, 10);

    if (currentCount <= maxRetained) {
      return;
    }

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

      for (const row of expireResult.rows) {
        const keys = [row.original_s3_key, row.enhanced_s3_key, row.thumb_s3_key].filter(Boolean) as string[];
        for (const key of keys) {
          deleteS3Object(key).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.error(`[retention] Failed to enforce retention for agency ${agencyId}:`, error);
  }
}

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
    propertyId: row.property_id,
    parentImageId: row.parent_image_id,
    source: row.source,
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

export async function deleteExpiredImagesFromStorage(
  _agencyId?: string,
  _batchSize: number = 100
): Promise<number> {
  console.log('[cleanup] Storage deletion not yet implemented');
  return 0;
}
