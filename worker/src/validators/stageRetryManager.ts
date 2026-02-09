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
import { getJob, updateJob } from "../utils/persist";
import { isTerminalStatus } from "../utils/statusUtils";

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
 * Get or create retry state for a job from persisted job metadata
 * NOTE: Now reads from job record to prevent cross-job contamination
 */
export async function getRetryState(jobId: string): Promise<StageRetryState> {
  const job = await getJob(jobId);
  const retryStateJson = (job as any)?.retryState;
  
  if (retryStateJson) {
    try {
      return deserializeRetryState(typeof retryStateJson === 'string' ? retryStateJson : JSON.stringify(retryStateJson));
    } catch (e) {
      console.warn(`[stageRetry] Failed to deserialize retry state for ${jobId}, creating new`);
    }
  }
  
  return createInitialRetryState();
}

/**
 * Save retry state for a job to persisted job metadata
 * NOTE: Now writes to job record to prevent cross-job contamination
 */
export async function saveRetryState(jobId: string, state: StageRetryState): Promise<void> {
  try {
    await updateJob(jobId, { retryState: serializeRetryState(state) });
  } catch (e) {
    console.error(`[stageRetry] Failed to save retry state for ${jobId}:`, e);
  }
}

/**
 * Clear retry state for a job (e.g., on job completion)
 * NOTE: Now clears from job record
 */
export async function clearRetryState(jobId: string): Promise<void> {
  try {
    await updateJob(jobId, { retryState: null });
  } catch (e) {
    console.error(`[stageRetry] Failed to clear retry state for ${jobId}:`, e);
  }
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
export async function shouldRetryStage(
  jobId: string,
  stage: StageId,
  validationResult: ValidationSummary
): Promise<RetryDecision> {
  const currentJob = await getJob(jobId);
  let state = await getRetryState(jobId);
  const currentAttempts = getStageAttempts(state, stage);
  const currentStatus = currentJob?.status as string | undefined;
  if (isTerminalStatus(currentStatus)) {
    return {
      shouldRetry: false,
      tightenLevel: 3,
      attemptNumber: currentAttempts,
      isFinalAttempt: true,
      reason: `Terminal status (${currentStatus}) blocks retry for ${stage}`,
    };
  }

  if (stage === "stage2" && (currentJob as any)?.retryPendingStage2) {
    return {
      shouldRetry: false,
      tightenLevel: 3,
      attemptNumber: currentAttempts,
      isFinalAttempt: false,
      reason: `retryPendingStage2 already true for ${stage}`,
    };
  }
  const config = loadStageAwareConfig();
  const maxAttempts = config.maxRetryAttempts;

  if (state.failedFinal) {
    return {
      shouldRetry: false,
      tightenLevel: 3,
      attemptNumber: currentAttempts,
      isFinalAttempt: true,
      reason: `FAILED_FINAL already set for ${stage}`,
    };
  }

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
  await saveRetryState(jobId, state);

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
export async function markStageFailed(
  jobId: string,
  stage: StageId,
  triggers: ValidationTrigger[]
): Promise<void> {
  const state = await getRetryState(jobId);
  state.failedFinal = true;
  state.lastFailedStage = stage;
  state.failureReasons = triggers;
  await saveRetryState(jobId, state);

  console.error(`[stageRetry] FAILED_FINAL: Stage ${stage} failed after all retry attempts`);
  console.error(`[stageRetry] Failure reasons:`);
  triggers.forEach((t, i) => {
    console.error(`[stageRetry]   ${i + 1}. ${t.id}: ${t.message}`);
  });
}

/**
 * Check if a job has reached final failure state
 */
export async function isJobFailedFinal(jobId: string): Promise<boolean> {
  const state = await getRetryState(jobId);
  return state.failedFinal;
}

/**
 * Get retry summary for a job (for logging/UI)
 */
export async function getRetrySummary(jobId: string): Promise<{
  stage1AAttempts: number;
  stage1BAttempts: number;
  stage2Attempts: number;
  failedFinal: boolean;
  lastFailedStage: StageId | null;
  failureCount: number;
}> {
  const state = await getRetryState(jobId);
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
export async function logRetryState(jobId: string): Promise<void> {
  const state = await getRetryState(jobId);
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
export async function getRetryMetadataForJob(jobId: string): Promise<Record<string, any>> {
  const state = await getRetryState(jobId);
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
 * NOTE: Now unnecessary as state is read directly from job record
 */
export async function restoreRetryStateFromMetadata(
  jobId: string,
  metadata: Record<string, any>
): Promise<void> {
  // No-op: State is now persisted in job record automatically
  console.log(`[stageRetry] Retry state for job ${jobId} is persisted in job record`);
}
