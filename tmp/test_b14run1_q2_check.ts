import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const VDIR = path.join(REPO_ROOT, "Test Images/Validator Testing Images");

async function main() {
  process.env.STAGE2_VALIDATOR_MODEL = "grok";
  const baselinePath = path.join(VDIR, "Bedroom 14.jpg");
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId: "q2check-baseline", imageId: "q2check-baseline" });
  const run1 = path.join(VDIR, "Bedroom 14 Testing - Staged Run 1.webp");

  for (let r = 1; r <= 3; r++) {
    const ctx = { jobId: `q2check-r${r}`, imageId: `q2check-r${r}` };
    const result = await runOpeningEnvelopeValidator(baselinePath, run1, baseline, ctx);
    const c1 = result.itemResults.find((i) => i.type === "closet_door");
    console.log(`\n--- run ${r}: opening.status=${result.opening.status} ---`);
    if (c1) console.log(JSON.stringify(c1, null, 2));
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
