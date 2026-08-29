// C3 fix (RealEnhance — Full Pipeline Integrity & Anomaly Audit, targeted
// verification + remediation pass).
//
// FINDING: BullMQ's own built-in stalled-job reassignment (active by
// default; this worker's lockDuration is 300_000ms) can legitimately hand
// the same jobId to a second worker while the first worker is still alive
// — its lock-renewal simply didn't complete in time (e.g. event-loop
// congestion under concurrent jobs, which this codebase has independently
// observed via [MEMORY_PHASE_PEAK_WARNING] under load). The worker's
// existing idempotency guard (see the job processor in worker.ts) only
// skips 4 TERMINAL statuses (awaiting_payment/failed/complete/cancelled)
// and never "processing", so a genuinely-still-running job offers no
// protection against a second worker instance starting the same pipeline
// concurrently — real duplicate work (duplicate API spend, duplicate S3
// writes, a race on which attempt's result wins).
//
// This module is a distributed advisory lock, independent of BullMQ's own
// per-job lock/token, that closes that specific gap: whichever worker
// acquires it first proceeds; a second worker dispatched the same jobId
// while the lock is held skips cleanly instead of duplicating work.
//
// This is deliberately NOT a fix for a truly crashed worker —
// scanAndRecoverStuckJobs (server) and BullMQ's own stalled-job handling
// already exist for that, and remain how a genuinely-abandoned job gets
// retried. This lock expires on its own TTL (JOB_PROCESSING_LOCK_TTL_SECONDS)
// so a real crash still allows recovery; it only prevents two LIVE workers
// from running the same jobId at the same time.

// Minimal surface actually used here, kept separate from the real
// RedisClientType so this module (and its tests) don't depend on the
// `redis` package's full, overload-heavy typings — mirrors this file's own
// existing `redisAny`-style looseness elsewhere in worker.ts for the same
// reason.
export interface JobProcessingLockClient {
  set(key: string, value: string, opts: { NX: true; EX: number }): Promise<unknown>;
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

// Matches STUCK_PROCESSING_RECOVERY_MS's existing 20-minute "definitely
// stuck" threshold (server/src/services/jobs.ts) — reusing this
// codebase's existing judgment call about how long a job may legitimately
// run, rather than introducing a second, uncoordinated number.
export const JOB_PROCESSING_LOCK_TTL_SECONDS = 20 * 60;

export function jobProcessingLockKey(jobId: string): string {
  return `job-processing-lock:${jobId}`;
}

/**
 * Attempts to acquire the advisory processing lock for a jobId.
 *
 * @param token A value unique to this specific worker invocation (e.g.
 *   `${jobId}:${process.pid}:${Date.now()}:${random}`) — required so
 *   release can safely verify it still owns the lock before deleting it.
 * @returns true if the lock was acquired (caller should proceed and later
 *   call releaseJobProcessingLock with the same token), false if another
 *   worker already holds it (caller should skip processing — this is a
 *   duplicate dispatch of a job already in progress).
 */
export async function acquireJobProcessingLock(
  client: JobProcessingLockClient,
  jobId: string,
  token: string
): Promise<boolean> {
  const result = await client.set(jobProcessingLockKey(jobId), token, {
    NX: true,
    EX: JOB_PROCESSING_LOCK_TTL_SECONDS,
  });
  // node-redis v4 returns "OK" on a successful SET NX, null when the key
  // already exists. Accept a bare `true` too so a simpler test/mock client
  // isn't forced to mimic the exact string.
  return result === "OK" || result === true;
}

// Compare-and-delete: only releases the lock if it still holds the token
// this invocation acquired. Prevents the classic distributed-lock bug of
// deleting a lock a *different* holder has since legitimately acquired
// (e.g. because this invocation's own TTL had already expired before it
// got around to releasing).
const RELEASE_IF_OWNER_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

/**
 * Releases the processing lock, but only if it still holds the token this
 * invocation acquired. Best-effort: callers should swallow errors from
 * this, matching this codebase's other job-lifecycle cleanup calls
 * (fair-scheduler slot release, batch forensic finalize, wall-visibility
 * cache eviction) — a failure to release should never fail the job itself;
 * the lock's own TTL is the backstop.
 */
export async function releaseJobProcessingLock(
  client: JobProcessingLockClient,
  jobId: string,
  token: string
): Promise<void> {
  await client.eval(RELEASE_IF_OWNER_SCRIPT, {
    keys: [jobProcessingLockKey(jobId)],
    arguments: [token],
  });
}
