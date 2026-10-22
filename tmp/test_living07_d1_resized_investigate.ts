// Investigate Grok instability on D1 (Living 07's sliding glass door) after
// the classifyExtent fix: run 1 passed correctly (occlusion), run 2 failed
// with verdict=resized. Per the new priority rule, this IS worth digging
// into since Grok itself is unstable here, not just Gemini.
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const baselinePath = path.join(REPO_ROOT, "Test Images/Living (Baseline)/Living 07.jpg");
const stagedPath = path.join(REPO_ROOT, "Test Images/Living (Baseline)/Living 07-staged-v2.webp");

async function main() {
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId: "d1resized-baseline", imageId: "d1resized-baseline" });
  process.env.STAGE2_VALIDATOR_MODEL = "grok";
  for (let r = 1; r <= 3; r++) {
    const ctx = { jobId: `d1resized-grok-r${r}`, imageId: `d1resized-grok-r${r}` };
    const result = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
    const d1 = result.itemResults.find((i) => i.id === "D1") || result.itemResults.find((i) => i.type === "door");
    console.log(`\n--- run ${r}: opening.status=${result.opening.status} ---`);
    if (d1) console.log(JSON.stringify(d1, null, 2));
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
