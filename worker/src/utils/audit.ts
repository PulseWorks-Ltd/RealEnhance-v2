/**
 * Audit & Traceability Utilities (Worker Side)
 *
 * Generates audit_ref and trace_id for enhanced images history.
 */

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
