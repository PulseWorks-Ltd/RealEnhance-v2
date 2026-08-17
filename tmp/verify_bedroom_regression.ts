// Focused verification: is the wall_2 (vs expected wall_1) result seen in
// the Task G regression check evidence of a bug in the planBedroomAnchor
// refactor (planSingleAnchorWall), or just ordinary call-to-call variance
// in the real baseline/wall-visibility Gemini extraction calls? Run 3
// fresh, independent calls through the SAME (refactored) code and see
// whether the wall selection and protectedFeatureCount are stable or
// vary across calls with zero code change between them — if they vary
// here too, that's direct proof the variance is in the extraction data,
// not the (unchanged) selection algorithm.
import path from "path";
import { buildAnchorLockedStage2Prompt } from "../worker/src/pipeline/anchorLockedStaging";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");

async function main() {
  const runs = Number(process.argv[2] || "3");
  for (let r = 1; r <= runs; r++) {
    const result = await buildAnchorLockedStage2Prompt({
      imagePath: path.join(BEDROOM_DIR, "Bedroom 12.jpg"),
      roomType: "bedroom",
      jobId: `verify-bedroom-regression-r${r}`,
      imageId: `verify-bedroom-regression-r${r}`,
    });
    console.log(
      `run ${r}: fallbackReason=${result.fallbackReason} anchorWallId=${result.diagnostics.anchorWallId} anchorConfidence=${result.diagnostics.anchorConfidence} protectedFeatureCount=${result.diagnostics.protectedFeatureCount}`
    );
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
