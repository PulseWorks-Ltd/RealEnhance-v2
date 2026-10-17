// Part 2 (validation task): run the REAL production baseline extractor,
// fresh, on a candidate room with category-B content (kitchen island +
// built-in cabinetry), so the anchor-only prompt's B-clause inclusion can
// be based on actual detection results rather than assumption.
import path from "path";
import fs from "fs/promises";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const IMAGE_PATH = path.join(REPO_ROOT, "Test Images/Kitchen/Karaka - Image 02 Decluttered.jpg");

async function main() {
  console.log("=== Running real extractStructuralBaseline() on:", IMAGE_PATH, "===");
  const startedAt = Date.now();
  const baseline = await extractStructuralBaseline(IMAGE_PATH, {
    jobId: "tmp-validation-kitchen",
    imageId: "karaka-02-decluttered",
  });
  const durationMs = Date.now() - startedAt;
  console.log(`=== DONE (${durationMs}ms) ===`);
  console.log(JSON.stringify(baseline, null, 2));

  const outPath = path.join(REPO_ROOT, "tmp", `real_baseline_kitchen_${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(baseline, null, 2));
  console.log("=== SAVED:", outPath, "===");
}

main().catch((e) => {
  console.error("run_real_baseline_kitchen failed:", e);
  process.exit(1);
});
