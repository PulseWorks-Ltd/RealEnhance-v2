// Part 2.3 (validation task): run the UPDATED extractStructuralBaseline()
// (now aware of plumbing_fixture / light_fixture) twice on the same real
// image with both plumbing and lighting visible
// (Test Images/Kitchen/Karaka - Image 02 Decluttered.jpg), disabling cache
// on both calls so they're genuinely independent extractions, not a cache
// hit on the second call. Compares: are the pre-existing categories
// (openings, ac_unit/kitchen_island/built_in_cabinet) still detected the
// same as the pre-change baseline captured in tmp/real_baseline_kitchen_*.json,
// and are the two new categories detected consistently across these two
// fresh runs?
import path from "path";
import fs from "fs/promises";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const IMAGE_PATH = path.join(REPO_ROOT, "Test Images/Kitchen/Karaka - Image 02 Decluttered.jpg");

async function main() {
  console.log("=== Run 1 (updated extractor, cache disabled) ===");
  const run1 = await extractStructuralBaseline(IMAGE_PATH, {
    jobId: "tmp-stability-check",
    imageId: "karaka-02-run1",
    disableCache: true,
  });
  console.log(JSON.stringify(run1, null, 2));

  console.log("\n=== Run 2 (updated extractor, cache disabled) ===");
  const run2 = await extractStructuralBaseline(IMAGE_PATH, {
    jobId: "tmp-stability-check",
    imageId: "karaka-02-run2",
    disableCache: true,
  });
  console.log(JSON.stringify(run2, null, 2));

  const outPath = path.join(REPO_ROOT, "tmp", `stability_check_${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify({ run1, run2 }, null, 2));
  console.log("\n=== SAVED:", outPath, "===");
}

main().catch((e) => {
  console.error("stability_check_updated_extractor failed:", e);
  process.exit(1);
});
