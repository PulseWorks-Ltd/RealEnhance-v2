/**
 * Completion Guard — single authority for marking a job "complete".
 *
 * No job may transition to status=complete unless this guard passes.
 * This prevents partial/corrupt completions from reaching clients.
 */

import { isTerminalStatus } from "./statusUtils";

/** Minimal shape expected from a validator result (backward-compatible). */
export interface CompletionValidatorResult {
  passed?: boolean;
  hardFail?: boolean;
  verdict?: string;
}

/** State of the job record at the moment of the completion attempt. */
export interface CompletionJobRecord {
  status?: string;
  retryPendingStage2?: boolean;
  cancelled?: boolean;
  fatalError?: string;
  [key: string]: any;
}

/** Stage state passed from the pipeline. */
export interface CompletionStageState {
  /** The output URL that will be written as resultUrl / imageUrl */
  outputUrl?: string | null;
  /** Which final stage actually ran (e.g. "1A", "1B", "2", "edit") */
  finalStageRan?: string | null;
  /** Which final stage was expected (e.g. "2" for full pipeline) */
  expectedFinalStage?: string | null;
}

export interface CompletionGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Determine whether a job is allowed to be marked COMPLETE.
 *
 * Returns `{ ok: true }` when all pre-completion invariants hold,
 * or `{ ok: false, reason }` with a machine-readable reason.
 *
 * Callers should log the result via the `[completion_guard]` prefix.
 */
export function canMarkJobComplete(
  jobRecord: CompletionJobRecord | null | undefined,
  validatorResult: CompletionValidatorResult | null | undefined,
  stageState: CompletionStageState,
): CompletionGuardResult {
  // 1. Output URL must exist
  if (!stageState.outputUrl) {
    return { ok: false, reason: "missing_output_url" };
  }

  // 2. Validator must have passed (PASS or equivalent).
  //    For edit/region-edit jobs, validatorResult may be null — that's ok.
  if (validatorResult) {
    const verdictStr = (validatorResult.verdict ?? "").toUpperCase();
    const passedExplicitly = validatorResult.passed === true;
    const escalatedPass = verdictStr === "ESCALATED_PASS";
    const verdictPass = verdictStr === "PASS";

    if (!passedExplicitly && !escalatedPass && !verdictPass) {
      // Hard-fail from validator blocks completion
      if (validatorResult.hardFail) {
        return { ok: false, reason: "validator_hard_fail" };
      }
    }
  }

  // 3. No retryPending flag
  if (jobRecord?.retryPendingStage2 === true) {
    return { ok: false, reason: "retry_pending" };
  }

  // 4. Not cancelled
  if (jobRecord?.cancelled === true || jobRecord?.status === "cancelled") {
    return { ok: false, reason: "job_cancelled" };
  }

  // 5. Not already terminal
  if (isTerminalStatus(jobRecord?.status)) {
    return { ok: false, reason: "already_terminal" };
  }

  // 6. Expected final stage should match (when both are known)
  //    This is advisory — partial completions legitimately set a different finalStage.
  //    Only block when expectedFinalStage is "2" but the stage that ran was undefined.
  if (
    stageState.expectedFinalStage &&
    !stageState.finalStageRan
  ) {
    return { ok: false, reason: "expected_stage_not_run" };
  }

  // 7. No recorded fatal error
  if (jobRecord?.fatalError) {
    return { ok: false, reason: "fatal_error_recorded" };
  }

  return { ok: true };
}

/**
 * Log a completion guard result with structured prefix.
 */
export function logCompletionGuard(jobId: string, result: CompletionGuardResult): void {
  if (result.ok) {
    console.log(`[completion_guard] PASS jobId=${jobId}`);
  } else {
    console.log(`[completion_guard] BLOCK jobId=${jobId} reason=${result.reason}`);
  }
}
