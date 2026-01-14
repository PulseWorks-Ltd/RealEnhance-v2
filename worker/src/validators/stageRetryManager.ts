/**
 * Stage Retry Manager
 *
 * Manages automatic retry logic for failed validation stages.
 * - Tracks attempt counts per stage per job
 * - Coordinates with prompt tightening
 * - Persists retry state in job metadata
 */

import {
  StageId,
  StageRetryState,
  createInitialRetryState,
  getStageAttempts,
  incrementStageAttempts,
  ValidationSummary,
  ValidationTrigger,
  loadStageAwareConfig,
} from "./stageAwareConfig";
import { getTightenLevelFromAttempt, TightenLevel } from "../ai/promptTightening";

/**
 * Result of checking whether a retry should occur
 */
export interface RetryDecision {
  /** Whether to retry the stage */
  shouldRetry: boolean;
  /** The tighten level to use for the retry */
  tightenLevel: TightenLevel;
  /** Current attempt number (0-based, after incrementing) */
  attemptNumber: number;
  /** Whether this is the final attempt allowed */
  isFinalAttempt: boolean;
  /** Human-readable reason for decision */
  reason: string;
}

/**
 * In-memory cache for retry states (keyed by jobId)
 * In production, this should be persisted to Redis or DB
 */
const retryStateCache = new Map<string, StageRetryState>();

/**
 * Get or create retry state for a job
 */
export function getRetryState(jobId: string): StageRetryState {
  let state = retryStateCache.get(jobId);
  if (!state) {
    state = createInitialRetryState();
    retryStateCache.set(jobId, state);
  }
  return state;
}

/**
 * Save retry state for a job
 */
export function saveRetryState(jobId: string, state: StageRetryState): void {
  retryStateCache.set(jobId, state);
}

/**
 * Clear retry state for a job (e.g., on job completion)
 */
export function clearRetryState(jobId: string): void {
  retryStateCache.delete(jobId);
}

/**
 * Serialize retry state for persistence (e.g., to Redis or job metadata)
 */
export function serializeRetryState(state: StageRetryState): string {
  return JSON.stringify(state);
}

/**
 * Deserialize retry state from storage
 */
export function deserializeRetryState(json: string): StageRetryState {
  try {
    const parsed = JSON.parse(json);
    return {
      stage1AAttempts: parsed.stage1AAttempts || 0,
      stage1BAttempts: parsed.stage1BAttempts || 0,
      stage2Attempts: parsed.stage2Attempts || 0,
      lastFailedStage: parsed.lastFailedStage || null,
      failedFinal: parsed.failedFinal || false,
      failureReasons: parsed.failureReasons || [],
    };
  } catch {
    return createInitialRetryState();
  }
}

/**
 * Check if a stage should be retried after validation failure
 *
 * @param jobId - Job identifier
 * @param stage - Stage that failed validation
 * @param validationResult - The validation summary from stage-aware validator
 * @returns RetryDecision with retry instructions
 */
export function shouldRetryStage(
  jobId: string,
  stage: StageId,
  validationResult: ValidationSummary
): RetryDecision {
  const config = loadStageAwareConfig();
  const maxAttempts = config.maxRetryAttempts;

  let state = getRetryState(jobId);
  const currentAttempts = getStageAttempts(state, stage);

  // If already at max attempts, no more retries
  if (currentAttempts >= maxAttempts) {
    return {
      shouldRetry: false,
      tightenLevel: 3,
      attemptNumber: currentAttempts,
      isFinalAttempt: true,
      reason: `Max attempts (${maxAttempts}) reached for ${stage}`,
    };
  }

  // If validation passed (no risk), no retry needed
  if (!validationResult.risk) {
    return {
      shouldRetry: false,
      tightenLevel: 0,
      attemptNumber: currentAttempts,
      isFinalAttempt: false,
      reason: `Validation passed for ${stage}`,
    };
  }

  // Increment attempts and determine tighten level
  state = incrementStageAttempts(state, stage);
  state.lastFailedStage = stage;
  state.failureReasons = validationResult.triggers;
  saveRetryState(jobId, state);

  const newAttemptCount = getStageAttempts(state, stage);
  const tightenLevel = getTightenLevelFromAttempt(newAttemptCount);
  const isFinalAttempt = newAttemptCount >= maxAttempts;

  return {
    shouldRetry: true,
    tightenLevel,
    attemptNumber: newAttemptCount,
    isFinalAttempt,
    reason: `Retry ${newAttemptCount}/${maxAttempts} with tighten level ${tightenLevel}`,
  };
}

/**
 * Mark a stage as finally failed (after all retries exhausted)
 */
export function markStageFailed(
  jobId: string,
  stage: StageId,
  triggers: ValidationTrigger[]
): void {
  const state = getRetryState(jobId);
  state.failedFinal = true;
  state.lastFailedStage = stage;
  state.failureReasons = triggers;
  saveRetryState(jobId, state);

  console.error(`[stageRetry] FAILED_FINAL: Stage ${stage} failed after all retry attempts`);
  console.error(`[stageRetry] Failure reasons:`);
  triggers.forEach((t, i) => {
    console.error(`[stageRetry]   ${i + 1}. ${t.id}: ${t.message}`);
  });
}

/**
 * Check if a job has reached final failure state
 */
export function isJobFailedFinal(jobId: string): boolean {
  const state = getRetryState(jobId);
  return state.failedFinal;
}

/**
 * Get retry summary for a job (for logging/UI)
 */
export function getRetrySummary(jobId: string): {
  stage1AAttempts: number;
  stage1BAttempts: number;
  stage2Attempts: number;
  failedFinal: boolean;
  lastFailedStage: StageId | null;
  failureCount: number;
} {
  const state = getRetryState(jobId);
  return {
    stage1AAttempts: state.stage1AAttempts,
    stage1BAttempts: state.stage1BAttempts,
    stage2Attempts: state.stage2Attempts,
    failedFinal: state.failedFinal,
    lastFailedStage: state.lastFailedStage,
    failureCount: state.failureReasons.length,
  };
}

/**
 * Log retry state for debugging
 */
export function logRetryState(jobId: string): void {
  const state = getRetryState(jobId);
  console.log(`[stageRetry] Job ${jobId} retry state:`);
  console.log(`[stageRetry]   Stage1A attempts: ${state.stage1AAttempts}`);
  console.log(`[stageRetry]   Stage1B attempts: ${state.stage1BAttempts}`);
  console.log(`[stageRetry]   Stage2 attempts: ${state.stage2Attempts}`);
  console.log(`[stageRetry]   Last failed: ${state.lastFailedStage || "none"}`);
  console.log(`[stageRetry]   Failed final: ${state.failedFinal}`);
  if (state.failureReasons.length > 0) {
    console.log(`[stageRetry]   Failure reasons:`);
    state.failureReasons.forEach((t, i) => {
      console.log(`[stageRetry]     ${i + 1}. ${t.id}: ${t.message}`);
    });
  }
}

/**
 * Extend job metadata with retry information
 * This should be called when updating job metadata in Redis/DB
 */
export function getRetryMetadataForJob(jobId: string): Record<string, any> {
  const state = getRetryState(jobId);
  return {
    retryState: {
      stage1AAttempts: state.stage1AAttempts,
      stage1BAttempts: state.stage1BAttempts,
      stage2Attempts: state.stage2Attempts,
      failedFinal: state.failedFinal,
      lastFailedStage: state.lastFailedStage,
      failureReasons: state.failureReasons.map(t => ({
        id: t.id,
        message: t.message,
        value: t.value,
        threshold: t.threshold,
        stage: t.stage,
      })),
    },
  };
}

/**
 * Restore retry state from job metadata (on job resume)
 */
export function restoreRetryStateFromMetadata(
  jobId: string,
  metadata: Record<string, any>
): void {
  if (metadata?.retryState) {
    const rs = metadata.retryState;
    const state: StageRetryState = {
      stage1AAttempts: rs.stage1AAttempts || 0,
      stage1BAttempts: rs.stage1BAttempts || 0,
      stage2Attempts: rs.stage2Attempts || 0,
      lastFailedStage: rs.lastFailedStage || null,
      failedFinal: rs.failedFinal || false,
      failureReasons: rs.failureReasons || [],
    };
    saveRetryState(jobId, state);
    console.log(`[stageRetry] Restored retry state for job ${jobId}`);
  }
}
