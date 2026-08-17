// Live re-verification of the classifySeamVisible fix against the real
// production case (Living 07.jpg / Living 07-staged-v2.webp), Grok
// primary. 4 fresh runs (double the prior 2-run sample) since this is
// confirming a STABILITY fix, not a first-pass finding — a single run
// passing wouldn't distinguish "fixed" from "got lucky again."
import path from "path";
import { extractFlooringZones, runFlooringBoundaryCheck } from "../worker/src/validators/flooringBoundaryCheck";

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const BEDROOM_STAGED_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)");
const baselineImage = path.join(LIVING_DIR, "Living 07.jpg");
const stagedImage = path.join(LIVING_DIR, "Living 07-staged-v2.webp");

async function runOnce(runIdx: number) {
  console.log(`\n\n########## RUN ${runIdx} ##########`);
  process.env.STAGE2_VALIDATOR_MODEL = "grok";

  const zones = await extractFlooringZones(baselineImage, { jobId: `reverify-living07v2-r${runIdx}`, imageId: `reverify-living07v2-r${runIdx}` });
  console.log(`[RUN ${runIdx}] zone count: ${zones.length}`);
  zones.forEach((z) => console.log(`  ${z.id}: material="${z.materialDescription}"`));

  const result = await runFlooringBoundaryCheck(baselineImage, stagedImage, { jobId: `reverify-living07v2-r${runIdx}`, imageId: `reverify-living07v2-r${runIdx}` }, zones);

  console.log(`[RUN ${runIdx}] floor.status: ${result.floor.status}`);
  console.log(`[RUN ${runIdx}] floor.reason: ${result.floor.reason}`);
  console.log(`[RUN ${runIdx}] per-zone verdicts:`, JSON.stringify(result.itemResults.map((r) => ({ id: r.id, verdict: r.verdict, materialMatches: r.materialMatchesOriginalZone, seamVisible: r.seamStillVisibleAnywhere, confidence: r.confidence })), null, 2));
  return result;
}

async function runRegressionCase(label: string, baselinePath: string, stagedPath: string) {
  console.log(`\n\n########## REGRESSION: ${label} ##########`);
  process.env.STAGE2_VALIDATOR_MODEL = "grok";
  const zones = await extractFlooringZones(baselinePath, { jobId: `reverify-regression-${label}`, imageId: `reverify-regression-${label}` });
  console.log(`[${label}] zone count: ${zones.length}`);
  zones.forEach((z) => console.log(`  ${z.id}: material="${z.materialDescription}"`));
  const result = await runFlooringBoundaryCheck(baselinePath, stagedPath, { jobId: `reverify-regression-${label}`, imageId: `reverify-regression-${label}` }, zones);
  console.log(`[${label}] applicable: ${result.applicable}`);
  console.log(`[${label}] floor.status: ${result.floor.status}`);
  console.log(`[${label}] floor.reason: ${result.floor.reason}`);
  console.log(`[${label}] itemResults:`, JSON.stringify(result.itemResults, null, 2));
  return result;
}

async function main() {
  const runs = Number(process.argv[2] || "4");
  const results = [];
  for (let r = 1; r <= runs; r++) {
    results.push(await runOnce(r));
  }
  console.log("\n\n=== LIVING 07 SUMMARY ===");
  results.forEach((r, i) => console.log(`Run ${i + 1}: ${r.floor.status}`));
  const allFail = results.every((r) => r.floor.status === "fail");
  console.log(`\nAll ${runs} runs failed (correctly caught the regression): ${allFail}`);

  console.log("\n\n========== REGRESSION CHECKS — CLEAN SINGLE-MATERIAL FLOORS ==========");
  const bedroom12 = await runRegressionCase(
    "Bedroom12-clean",
    path.join(BEDROOM_DIR, "Bedroom 12.jpg"),
    path.join(BEDROOM_STAGED_DIR, "Bedroom 12 (Enhanced).webp")
  );
  const bedroom11Fixed = await runRegressionCase(
    "Bedroom11-FIXED-clean",
    path.join(BEDROOM_DIR, "Bedroom 11.jpg"),
    path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp")
  );

  console.log("\n\n=== REGRESSION SUMMARY ===");
  console.log(`Bedroom 12 clean: ${bedroom12.floor.status} (expected pass)`);
  console.log(`Bedroom 11-FIXED clean: ${bedroom11Fixed.floor.status} (expected pass)`);

  console.log("\n=== ALL DONE ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("reverify_living07_v2_flooring_fixed failed:", e);
  process.exit(1);
});
