import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

async function main() {
  process.env.STAGE2_VALIDATOR_MODEL = "gemini";
  const living07Original = path.join(LIVING_DIR, "Living 07.jpg");
  const living07Baseline: any = await extractStructuralBaseline(living07Original, { jobId: "investigate-living07-baseline", imageId: "investigate-living07-baseline" });
  const staged = path.join(LIVING_DIR, "Living 07-staged-v2.webp");

  const r = await runOpeningEnvelopeValidator(living07Original, staged, living07Baseline, { jobId: "investigate-living07", imageId: "investigate-living07" });
  console.log("opening.status:", r.opening.status);
  console.log("FULL itemResults:", JSON.stringify(r.itemResults, null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
