import * as path from "path";
import { config } from "dotenv";
import { extractStructuralBaseline, validateOpeningPreservation } from "../src/validators/openingPreservationValidator";
import {
  computeStage1BOpeningClosureSignal,
  buildStage1BRetryCorrectionPrompt,
} from "../src/validators/stage1BOpeningClosureSignal";

config({ path: path.join(process.cwd(), ".env") });

// Real images pulled from the debug-attempts S3 bucket for job_45a10097-121b-4d80-8540-65e75375f90e
// (the opening-walled-over-twice job from logs.1784248028443.log).
const REPLAY_DIR = "/tmp/claude-1000/-workspaces-RealEnhance-v2/51f1677b-7a08-46c5-acb8-5a59d2e8a4ad/scratchpad/replay";
const BASELINE_PATH = `${REPLAY_DIR}/job_45a10097_1A.jpg`;
const ATTEMPT1_PATH = `${REPLAY_DIR}/job_45a10097_1B_attempt1.webp`;
const ATTEMPT2_PATH = `${REPLAY_DIR}/job_45a10097_1B_attempt2.webp`;

async function main() {
  console.log("=".repeat(80));
  console.log("STEP 1: extractStructuralBaseline on the real baseline (1A) image");
  console.log("=".repeat(80));

  const baseline = await extractStructuralBaseline(BASELINE_PATH, {
    jobId: "replay_opening_closure_verification",
    imageId: "job_45a10097_baseline",
    attempt: 1,
  });
  console.log(`Baseline openings: ${baseline.openings.length}`);
  baseline.openings.forEach((o) => console.log(`  - ${o.id}: ${o.type} on wall ${o.wallIndex}, ${o.horizontalBand}/${o.verticalBand}, coverage=${o.wallCoverageBand}`));

  console.log("\n" + "=".repeat(80));
  console.log("STEP 2: validateOpeningPreservation(baseline, attempt1) — real reconciliation");
  console.log("=".repeat(80));

  const attempt1Validation = await validateOpeningPreservation(baseline, ATTEMPT1_PATH, {
    jobId: "replay_opening_closure_verification",
    imageId: "job_45a10097_attempt1",
    attempt: 1,
  });
  console.log("attempt1 summary:", JSON.stringify(attempt1Validation.summary, null, 2));
  console.log("attempt1 findings:", JSON.stringify(attempt1Validation.findings, null, 2));

  const attempt1Signal = computeStage1BOpeningClosureSignal({
    summary: attempt1Validation.summary,
    findings: attempt1Validation.findings,
  });
  console.log("\nattempt1 computeStage1BOpeningClosureSignal:", JSON.stringify(attempt1Signal, null, 2));

  if (!attempt1Signal.openingClosureDetail) {
    console.log("\n⚠️  No closure detected on attempt 1 with these real images — cannot demonstrate the retry-prompt correction from this attempt.");
  } else {
    console.log("\n" + "=".repeat(80));
    console.log("STEP 3: the ACTUAL retry-prompt text that would be appended for attempt 2");
    console.log("(this is the exact function stage1B.ts calls — not a reimplementation)");
    console.log("=".repeat(80));
    console.log(buildStage1BRetryCorrectionPrompt(attempt1Signal.openingClosureDetail));
  }

  console.log("\n" + "=".repeat(80));
  console.log("STEP 4: validateOpeningPreservation(baseline, attempt2) — did the real retry actually fix it?");
  console.log("=".repeat(80));

  const attempt2Validation = await validateOpeningPreservation(baseline, ATTEMPT2_PATH, {
    jobId: "replay_opening_closure_verification",
    imageId: "job_45a10097_attempt2",
    attempt: 2,
  });
  console.log("attempt2 summary:", JSON.stringify(attempt2Validation.summary, null, 2));
  console.log("attempt2 findings:", JSON.stringify(attempt2Validation.findings, null, 2));

  const attempt2Signal = computeStage1BOpeningClosureSignal({
    summary: attempt2Validation.summary,
    findings: attempt2Validation.findings,
  });
  console.log("\nattempt2 computeStage1BOpeningClosureSignal:", JSON.stringify(attempt2Signal, null, 2));
  console.log("\nattempt2 fail-fast eligible:", Boolean(attempt2Signal.failFastFinding));
}

main().catch((err) => {
  console.error("REPLAY_FAILED:", err);
  process.exit(1);
});
