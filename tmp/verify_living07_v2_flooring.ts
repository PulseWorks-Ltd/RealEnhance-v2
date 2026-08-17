// Direct verification: does the real flooringBoundaryCheck.ts mechanism
// (Grok-primary, per STAGE2_VALIDATOR_MODEL=grok) catch the flooring
// alteration already directly confirmed by visual crop-and-compare
// between Living 07.jpg (baseline) and Living 07-staged-v2.webp (staged)?
// Two fresh runs, same stability discipline as every validator test
// tonight. Real production functions only — extractFlooringZones +
// runFlooringBoundaryCheck, no reimplementation.
import path from "path";
import { extractFlooringZones, runFlooringBoundaryCheck } from "../worker/src/validators/flooringBoundaryCheck";

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const baselineImage = path.join(LIVING_DIR, "Living 07.jpg");
const stagedImage = path.join(LIVING_DIR, "Living 07-staged-v2.webp");

async function runOnce(runIdx: number) {
  console.log(`\n\n########## RUN ${runIdx} ##########`);
  process.env.STAGE2_VALIDATOR_MODEL = "grok";

  console.log(`\n=== extractFlooringZones (baseline, always Gemini) — run ${runIdx} ===`);
  const zones = await extractFlooringZones(baselineImage, { jobId: `verify-living07v2-flooring-r${runIdx}`, imageId: `verify-living07v2-flooring-r${runIdx}` });
  console.log(`Zone count: ${zones.length}`);
  zones.forEach((z) => console.log(`  ${z.id}: bbox=[${z.bbox.map((n) => n.toFixed(3)).join(", ")}] material="${z.materialDescription}"`));

  console.log(`\n=== runFlooringBoundaryCheck (observation, Grok per STAGE2_VALIDATOR_MODEL) — run ${runIdx} ===`);
  const result = await runFlooringBoundaryCheck(baselineImage, stagedImage, { jobId: `verify-living07v2-flooring-r${runIdx}`, imageId: `verify-living07v2-flooring-r${runIdx}` }, zones);

  console.log(`\n[RUN ${runIdx}] applicable: ${result.applicable}`);
  console.log(`[RUN ${runIdx}] floor.status: ${result.floor.status}`);
  console.log(`[RUN ${runIdx}] floor.reason: ${result.floor.reason}`);
  console.log(`[RUN ${runIdx}] itemResults (full raw observations):`);
  console.log(JSON.stringify(result.itemResults, null, 2));

  return result;
}

async function main() {
  const runs = Number(process.argv[2] || "2");
  for (let r = 1; r <= runs; r++) {
    await runOnce(r);
  }
  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("verify_living07_v2_flooring failed:", e);
  process.exit(1);
});
