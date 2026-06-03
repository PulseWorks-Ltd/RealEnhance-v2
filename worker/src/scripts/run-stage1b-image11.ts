import { runStage1BUnifiedGate } from "../validators/stage1BUnifiedGate.js";
import path from "node:path";

const BASE = path.resolve(
  process.cwd(),
  "../Test Images/Declutter Validator Testing/Stage 1B - Image 11 - Baseline.jpg"
);
const CAND = path.resolve(
  process.cwd(),
  "../Test Images/Declutter Validator Testing/Stage 1B - Image 11 - Decluttered.jpg"
);

const JOB_ID = "stage1b-standalone-image_11";

async function main() {
  console.log("IMAGE11_RUN_START");
  console.log(JSON.stringify({ baselinePath: BASE, declutteredPath: CAND, jobId: JOB_ID }));

  const result = await runStage1BUnifiedGate({
    baselinePath: BASE,
    candidatePath: CAND,
    sceneType: "interior",
    jobId: JOB_ID,
    imageId: "image_11",
    stage1BValidationMode: "LIGHT_DECLUTTER",
    stagingStyle: "nz_standard",
  });

  const verdict = {
    passed: result.passed,
    hardFail: result.hardFail,
    blockSource: (result.result as any)?.blockSource ?? "none",
    issueType: result.issueType ?? "none",
    violationType: (result.result as any)?.geminiVerdict?.violationType ?? "none",
    confidence: (result.result as any)?.geminiVerdict?.confidence ?? null,
    failedValidators: (result.result as any)?.failedValidators ?? [],
    geminiReasons: result.reasons ?? [],
    geminiRawText: (result.result as any)?.geminiVerdict?.rawText ?? null,
    durationMs: result.durationMs ?? null,
  };

  console.log("IMAGE11_RESULT_START");
  console.log(JSON.stringify(verdict, null, 2));
  console.log("IMAGE11_RESULT_END");
}

main().catch((err) => {
  console.error("IMAGE11_ERROR", err);
  process.exit(1);
});
