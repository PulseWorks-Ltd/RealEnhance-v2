/**
 * Audit & Traceability Utilities
 *
 * Generates audit_ref and trace_id for enhanced images history.
 * Provides full traceability from stored images back to logs and validator decisions.
 */

import { randomBytes } from 'crypto';

type AuditPrimitive = string | number | boolean | null;
type AuditMetadata = Record<string, AuditPrimitive | AuditPrimitive[] | Record<string, AuditPrimitive>>;

export interface AuditLogEvent {
  jobId?: string;
  imageId?: string;
  stage?: string;
  event: string;
  metadata?: AuditMetadata;
}

export function isProductionLogMode(): boolean {
  return String(process.env.PRODUCTION_LOG_MODE || '').toLowerCase() === '1'
    || String(process.env.PRODUCTION_LOG_MODE || '').toLowerCase() === 'true';
}

function sanitizeMetadataValue(value: unknown): AuditPrimitive | AuditPrimitive[] | Record<string, AuditPrimitive> | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) as AuditPrimitive[];
  }
  if (typeof value === 'object') {
    const out: Record<string, AuditPrimitive> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        out[k] = v as AuditPrimitive;
      }
    }
    return out;
  }
  return undefined;
}

export function auditLog(event: AuditLogEvent): void {
  const sanitizedMetadata: AuditMetadata = {};
  for (const [k, v] of Object.entries(event.metadata || {})) {
    const cleaned = sanitizeMetadataValue(v);
    if (cleaned !== undefined) {
      sanitizedMetadata[k] = cleaned as any;
    }
  }

  console.log(JSON.stringify({
    type: 'AUDIT_EVENT',
    timestamp: new Date().toISOString(),
    jobId: event.jobId,
    imageId: event.imageId,
    stage: event.stage,
    event: event.event,
    metadata: sanitizedMetadata,
  }));
}

/**
 * Generate a short, human-friendly audit reference
 * Format: RE-XXXXXX (6 alphanumeric characters, uppercase)
 * Example: RE-7F3K9Q
 *
 * This may be shown to users as a generic "Support reference" but
 * NEVER expose validator details or internal metrics.
 */
export function generateAuditRef(): string {
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Removed confusing chars (I, O)
  const length = 6;
  let result = 'RE-';

  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * chars.length);
    result += chars[randomIndex];
  }

  return result;
}

/**
 * Generate a trace ID for correlating logs across services
 * Uses jobId as the base trace ID for consistency with existing logs
 *
 * If jobId is not available, generates a new UUID-like trace ID
 * Format: trace-{timestamp}-{random}
 */
export function generateTraceId(jobId?: string): string {
  if (jobId) {
    return jobId; // Reuse jobId for consistency with worker logs
  }

  // Generate new trace ID if no jobId available
  const timestamp = Date.now().toString(36);
  const random = randomBytes(8).toString('hex');
  return `trace-${timestamp}-${random}`;
}

/**
 * Parse S3 URL to extract storage key
 * Handles both direct S3 URLs and CDN URLs
 *
 * @param url - Full S3 or CDN URL
 * @returns Storage key (path after bucket name)
 */
export function extractStorageKey(url: string): string {
  try {
    const urlObj = new URL(url);

    // Handle S3 direct URLs: https://bucket.s3.region.amazonaws.com/key
    if (urlObj.hostname.includes('.s3.') || urlObj.hostname.includes('.s3-')) {
      return urlObj.pathname.slice(1); // Remove leading /
    }

    // Handle CDN URLs: pathname is the key
    return urlObj.pathname.slice(1); // Remove leading /
  } catch (error) {
    console.error('[audit] Failed to parse S3 URL:', url, error);
    // Fallback: return URL as-is if parsing fails
    return url;
  }
}

/**
 * Estimate file size from URL (requires HEAD request)
 * This is a placeholder - actual implementation should fetch Content-Length header
 *
 * @param url - Full URL to the file
 * @returns Estimated size in bytes (0 if unavailable)
 */
export async function estimateFileSize(url: string): Promise<number> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const contentLength = response.headers.get('content-length');
    return contentLength ? parseInt(contentLength, 10) : 0;
  } catch (error) {
    console.error('[audit] Failed to estimate file size:', url, error);
    return 0;
  }
}
