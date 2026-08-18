import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { buildAnchorLockedStage2Prompt } from "../worker/src/pipeline/anchorLockedStaging";

const REPO_ROOT = path.resolve(__dirname, "..");
const imagePath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");

async function main() {
  const jobId = "test-anchor-reuse-job";

  console.log("\n### Step 1: resolve the baseline ONCE, the way worker.ts's Stage1A-parallel trigger does ###");
  const t0 = Date.now();
  const baseline: any = await extractStructuralBaseline(imagePath, { jobId, imageId: jobId });
  console.log(`baseline resolved in ${Date.now() - t0}ms, openings=${baseline.openings.length}, graphHash=${baseline.graphMeta?.graphHash}`);

  console.log("\n### Step 2 (simulates attempt 1): buildAnchorLockedStage2Prompt WITH pre-resolved baseline ###");
  const t1 = Date.now();
  const resultAttempt1 = await buildAnchorLockedStage2Prompt({
    imagePath,
    roomType: "bedroom",
    jobId,
    imageId: jobId,
    structuralBaseline: baseline,
  });
  console.log(`attempt1 call took ${Date.now() - t1}ms (should be fast if no re-extraction of baseline; wall-visibility still runs once — first time for this jobId)`);
  console.log(`attempt1: prompt=${resultAttempt1.prompt ? "built" : "null"} fallbackReason=${resultAttempt1.fallbackReason} anchorWallId=${resultAttempt1.diagnostics.anchorWallId} baselineExtracted(diagnostic flag)=${resultAttempt1.diagnostics.baselineExtracted}`);

  console.log("\n### Step 3 (simulates attempt 2 / retry): buildAnchorLockedStage2Prompt WITH the SAME pre-resolved baseline object AND same jobId ###");
  const t2 = Date.now();
  const resultAttempt2 = await buildAnchorLockedStage2Prompt({
    imagePath,
    roomType: "bedroom",
    jobId,
    imageId: jobId,
    structuralBaseline: baseline,
  });
  console.log(`attempt2 (retry) call took ${Date.now() - t2}ms (should be MUCH faster than attempt1 — no baseline extraction AND no wall-visibility extraction, both should be cache hits)`);
  console.log(`attempt2: prompt=${resultAttempt2.prompt ? "built" : "null"} fallbackReason=${resultAttempt2.fallbackReason} anchorWallId=${resultAttempt2.diagnostics.anchorWallId} baselineExtracted(diagnostic flag)=${resultAttempt2.diagnostics.baselineExtracted}`);
  console.log(`SAME prompt text attempt1 vs attempt2: ${resultAttempt1.prompt === resultAttempt2.prompt}`);
  console.log(`SAME anchorWallId attempt1 vs attempt2: ${resultAttempt1.diagnostics.anchorWallId === resultAttempt2.diagnostics.anchorWallId}`);

  console.log("\n### Step 4 (control: old/fallback behavior): buildAnchorLockedStage2Prompt WITHOUT pre-resolved baseline (different jobId to avoid cache collision) ###");
  const t3 = Date.now();
  const resultFallback = await buildAnchorLockedStage2Prompt({
    imagePath,
    roomType: "bedroom",
    jobId: "test-anchor-reuse-job-fallback",
    imageId: "test-anchor-reuse-job-fallback",
  });
  console.log(`fallback (no pre-resolved baseline) call took ${Date.now() - t3}ms — should be SLOW again (a fresh extractStructuralBaseline + fresh wall-visibility call), proving the fallback safety net still works when no baseline is passed`);
  console.log(`fallback: prompt=${resultFallback.prompt ? "built" : "null"} fallbackReason=${resultFallback.fallbackReason} anchorWallId=${resultFallback.diagnostics.anchorWallId}`);

  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
