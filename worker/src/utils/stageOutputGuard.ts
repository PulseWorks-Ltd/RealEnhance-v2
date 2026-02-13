/**
 * Phase H: Stage Result Consistency Check
 *
 * Before a validator runs, verify the stage output file exists and is readable.
 * If missing → caller should mark FAILED with reason "missing_stage_output",
 * skip the validator, and skip completion.
 *
 * This is a guard only — no stage logic changes.
 */

import fs from "fs";

export interface StageOutputCheckResult {
  exists: boolean;
  readable: boolean;
  reason?: string;
}

/**
 * Verify a stage output file exists and is readable before running validators.
 * Returns { exists, readable } and logs a structured message on failure.
 */
export function checkStageOutput(
  filePath: string,
  stage: string,
  jobId: string
): StageOutputCheckResult {
  if (!filePath) {
    console.log(
      `[stage_output_guard] MISSING path_empty=true stage=${stage} jobId=${jobId}`
    );
    return { exists: false, readable: false, reason: "missing_stage_output" };
  }

  if (!fs.existsSync(filePath)) {
    console.log(
      `[stage_output_guard] MISSING path=${filePath} stage=${stage} jobId=${jobId}`
    );
    return { exists: false, readable: false, reason: "missing_stage_output" };
  }

  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    console.log(
      `[stage_output_guard] UNREADABLE path=${filePath} stage=${stage} jobId=${jobId}`
    );
    return { exists: true, readable: false, reason: "missing_stage_output" };
  }

  return { exists: true, readable: true };
}
