/**
 * Audit & Traceability Utilities (Worker Side)
 *
 * Generates audit_ref and trace_id for enhanced images history.
 */

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
 */
export function generateTraceId(jobId?: string): string {
  if (jobId) {
    return jobId; // Reuse jobId for consistency with worker logs
  }

  // Generate new trace ID if no jobId available
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `trace-${timestamp}-${random}`;
}
