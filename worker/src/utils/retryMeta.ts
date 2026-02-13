/**
 * Retry metadata — attached to job records when a retry is triggered.
 *
 * This is additive/optional metadata only. It does NOT change retry logic,
 * thresholds, or max counts. Callers can inspect retryMeta for observability
 * and debugging.
 */

export interface RetryMeta {
  /** 1-based attempt number within this retry cycle */
  attempt: number;
  /** Human-readable reason the retry was triggered */
  reason: string;
  /** Which pipeline stage triggered (or is being retried) */
  stage: "1A" | "1B" | "2" | "edit";
  /** Job ID of the parent job (for edit retries / manual retries) */
  parentJobId?: string;
}

/**
 * Build a RetryMeta object and emit a structured log line.
 */
export function buildRetryMeta(
  jobId: string,
  meta: RetryMeta,
): RetryMeta {
  console.log(
    `[retry] jobId=${jobId} attempt=${meta.attempt} stage=${meta.stage} reason=${meta.reason}` +
    (meta.parentJobId ? ` parentJobId=${meta.parentJobId}` : "")
  );
  return meta;
}
