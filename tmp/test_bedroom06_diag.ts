// Small diagnostic re-run: full raw-observation text for Bedroom06's W1
// (Gemini validator), to understand exactly why Q3 (extent) drove a
// fully_covered verdict on what direct visual inspection confirmed is a
// clean, unobstructed window.
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const STAGED2_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Staged 2)");

async function main() {
  process.env.STAGE2_VALIDATOR_MODEL = "gemini";
  const baselinePath = path.join(BEDROOM_DIR, "Bedroom 06.jpg");
  const stagedPath = path.join(STAGED2_DIR, "Bedroom 06 (Enhanced).webp");
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId: "diag-b06-baseline", imageId: "diag-b06-baseline" });
  const oe = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, { jobId: "diag-b06", imageId: "diag-b06" });
  console.log("FULL itemResults:", JSON.stringify(oe.itemResults, null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
