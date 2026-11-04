/**
 * Photo Adjust (free, non-destructive slider edits).
 *
 * The browser renders the adjusted photo (WebGL, the same pipeline as the live
 * preview) and uploads it as a lossless PNG. The server checks ownership, does
 * the single final JPEG encode (q95, 4:4:4 — same as worker delivery exports),
 * and stores a new enhanced_images version linked to its parent, with the
 * slider values in `adjustments` so it can be re-opened and re-edited from
 * the clean parent.
 *
 * Versions are recorded with stages_completed = ['edit'] so the existing
 * staged-label chain (isStagedImageForDownload) treats them like AI edits:
 * an adjusted staged photo still gets the "Virtually staged" label.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { pool } from '../db/index.js';
import { getJob } from './jobs.js';
import { createEnhancedImage } from './enhancedImages.js';
import { getS3ObjectBuffer, getS3SignedUrl, uploadOutputBufferToS3 } from '../utils/s3.js';
import {
  adjustedDimensionsMatch,
  isIdentityAdjustments,
  jobReferencesKey,
  sanitizeAdjustments,
  storageKeysFromUrl,
} from './photoAdjustRules.js';

export { adjustedDimensionsMatch, isIdentityAdjustments, jobReferencesKey, sanitizeAdjustments, storageKeysFromUrl };

export const ADJUST_JPEG_QUALITY = 95;
export const ADJUST_MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const ADJUST_MAX_EDGE = 8000;
const THUMB_LONG_EDGE = 800;

export class PhotoAdjustError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface AdjustUser {
  id: string;
  agencyId?: string | null;
  role?: string | null;
}

export interface AdjustSourceQuery {
  url?: string | null;
  imageId?: string | null;
  jobId?: string | null;
}

export interface ResolvedAdjustSource {
  /** S3 key of the pixels to edit (the clean parent when re-opening an Adjust version). */
  renderKey: string;
  /** The gallery row new versions hang off (null for intermediate outputs). */
  parentImageId: string | null;
  propertyId: string | null;
  reopenedFromParent: boolean;
  adjustments: Record<string, number> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Source resolution (ownership checks)
// ---------------------------------------------------------------------------

function scopedUserId(user: AdjustUser): string | undefined {
  return user.role === 'owner' || user.role === 'admin' ? undefined : user.id;
}

async function findRow(user: AdjustUser, q: AdjustSourceQuery, keys: string[]) {
  const imageId = q.imageId && UUID_RE.test(q.imageId) ? q.imageId : null;
  if (!imageId && keys.length === 0) return null;
  const userId = scopedUserId(user);
  const params: any[] = [user.agencyId, imageId, keys];
  let userClause = '';
  if (userId) {
    params.push(userId);
    userClause = `AND user_id = $${params.length}`;
  }
  const res = await pool.query(
    `SELECT id, property_id, parent_image_id, source, adjustments,
            enhanced_s3_key, storage_key, original_s3_key
       FROM enhanced_images
      WHERE agency_id = $1
        AND is_expired = FALSE AND deleted_at IS NULL
        ${userClause}
        AND (id::text = $2 OR enhanced_s3_key = ANY($3::text[]) OR storage_key = ANY($3::text[]))
      ORDER BY (id::text = $2) DESC, created_at DESC
      LIMIT 1`,
    params
  );
  return res.rows[0] || null;
}

export async function resolveAdjustSource(user: AdjustUser, q: AdjustSourceQuery): Promise<ResolvedAdjustSource> {
  if (!user?.id) throw new PhotoAdjustError(401, 'UNAUTHORIZED', 'Please sign in again.');
  if (!user.agencyId) {
    throw new PhotoAdjustError(400, 'ADJUST_NO_ACCOUNT', 'Adjust is available once your account setup is complete.');
  }
  const keys = storageKeysFromUrl(q.url);
  const row = await findRow(user, q, keys);

  if (row) {
    const ownKey: string | null = row.enhanced_s3_key || row.storage_key || null;
    // Re-opening an Adjust version: edit the clean parent pixels with the stored values.
    if (row.source === 'adjust' && row.original_s3_key) {
      return {
        renderKey: row.original_s3_key,
        parentImageId: row.parent_image_id || null,
        propertyId: row.property_id || null,
        reopenedFromParent: true,
        adjustments: row.adjustments ? sanitizeAdjustments(row.adjustments) : null,
      };
    }
    if (!ownKey) throw new PhotoAdjustError(404, 'ADJUST_SOURCE_NOT_FOUND', "This photo can't be found.");
    return {
      renderKey: ownKey,
      parentImageId: row.id,
      propertyId: row.property_id || null,
      reopenedFromParent: false,
      adjustments: null,
    };
  }

  // Intermediate outputs (Enhanced / Decluttered) have no gallery row: accept
  // them only when the caller's own job lists that exact file.
  if (q.jobId && keys.length > 0) {
    const job: any = await getJob(String(q.jobId));
    const owns =
      !!job &&
      (String(job.userId || '') === String(user.id) ||
        (!scopedUserId(user) && String(job.agencyId || '') === String(user.agencyId)));
    if (owns && jobReferencesKey(job, keys)) {
      const key = keys[0];
      return { renderKey: key, parentImageId: null, propertyId: job.propertyId || null, reopenedFromParent: false, adjustments: null };
    }
  }

  throw new PhotoAdjustError(404, 'ADJUST_SOURCE_NOT_FOUND', "This photo can't be adjusted. Refresh the page and try again.");
}

export async function loadAdjustSourceImage(source: ResolvedAdjustSource): Promise<{ buffer: Buffer; contentType: string }> {
  const { buffer, contentType } = await getS3ObjectBuffer(source.renderKey);
  return { buffer, contentType: contentType || 'image/jpeg' };
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export interface SaveAdjustedResult {
  imageId: string;
  imageUrl: string;
  thumbnailUrl: string | null;
  parentImageId: string | null;
  adjustments: Record<string, number>;
}

export async function saveAdjustedVersion(params: {
  user: AdjustUser;
  query: AdjustSourceQuery;
  png: Buffer;
  adjustments: unknown;
}): Promise<SaveAdjustedResult> {
  const adjustments = sanitizeAdjustments(params.adjustments);
  if (isIdentityAdjustments(adjustments)) {
    throw new PhotoAdjustError(400, 'ADJUST_NO_CHANGES', 'Move a slider before saving.');
  }
  const source = await resolveAdjustSource(params.user, params.query);

  let outMeta: sharp.Metadata;
  try {
    outMeta = await sharp(params.png).metadata();
  } catch {
    throw new PhotoAdjustError(400, 'ADJUST_BAD_IMAGE', "The adjusted image couldn't be read.");
  }
  if (outMeta.format !== 'png' || !outMeta.width || !outMeta.height || outMeta.width > ADJUST_MAX_EDGE || outMeta.height > ADJUST_MAX_EDGE) {
    throw new PhotoAdjustError(400, 'ADJUST_BAD_IMAGE', "The adjusted image couldn't be read.");
  }

  const original = await loadAdjustSourceImage(source);
  // The browser decodes with EXIF orientation applied; do the same here.
  const srcMeta = await sharp(original.buffer).metadata();
  const quarterTurned = (srcMeta.orientation || 1) >= 5;
  const srcW = (quarterTurned ? srcMeta.height : srcMeta.width) || 0;
  const srcH = (quarterTurned ? srcMeta.width : srcMeta.height) || 0;
  if (!adjustedDimensionsMatch({ width: srcW, height: srcH }, { width: outMeta.width, height: outMeta.height }, adjustments.rotate)) {
    throw new PhotoAdjustError(400, 'ADJUST_SIZE_MISMATCH', 'The adjusted image does not match the original photo.');
  }

  // One final JPEG generation, matching the worker's delivery export.
  const jpeg = await sharp(params.png)
    .removeAlpha()
    .withIccProfile('srgb')
    .jpeg({ quality: ADJUST_JPEG_QUALITY, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();
  const thumb = await sharp(jpeg)
    .resize(THUMB_LONG_EDGE, THUMB_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  const id = randomUUID();
  const full = await uploadOutputBufferToS3({ buffer: jpeg, filename: `adjusted-${id}.jpg`, contentType: 'image/jpeg' });
  const small = await uploadOutputBufferToS3({ buffer: thumb, filename: `adjusted-${id}-thumb.jpg`, contentType: 'image/jpeg' });

  const record = await createEnhancedImage({
    agencyId: String(params.user.agencyId),
    userId: params.user.id,
    jobId: `adjust_${id}`,
    propertyId: source.propertyId,
    parentImageId: source.parentImageId,
    source: 'adjust',
    stagesCompleted: ['edit'],
    completionType: 'full_success',
    publicUrl: full.url,
    thumbnailUrl: small.url,
    originalS3Key: source.renderKey,
    enhancedS3Key: full.key,
    thumbS3Key: small.key,
    sizeBytes: jpeg.length,
    contentType: 'image/jpeg',
  });
  await pool.query(`UPDATE enhanced_images SET adjustments = $1::jsonb WHERE id = $2`, [JSON.stringify(adjustments), record.id]);

  console.log('[photo-adjust] saved', {
    imageId: record.id,
    parentImageId: source.parentImageId,
    reopenedFromParent: source.reopenedFromParent,
    width: outMeta.width,
    height: outMeta.height,
    bytes: jpeg.length,
  });

  let thumbnailUrl: string | null = small.url;
  try {
    thumbnailUrl = await getS3SignedUrl(small.key, 900);
  } catch {
    /* fall back to the public URL */
  }

  return {
    imageId: record.id,
    imageUrl: full.url,
    thumbnailUrl,
    parentImageId: source.parentImageId,
    adjustments,
  };
}
