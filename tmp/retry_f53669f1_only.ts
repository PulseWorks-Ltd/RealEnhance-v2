import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const DIR = path.join(__dirname, "prodimg");

async function main() {
  const ctx = { jobId: "f53669f1-reverify2-a2", imageId: "f53669f1-reverify2-a2" };
  const baselinePath = path.join(DIR, "baseline_f53669f1.jpg");
  const stagedPath = path.join(DIR, "attempt2_f53669f1.webp");
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const envelopeResult = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`opening.status=${envelopeResult.opening.status}`);
  console.log(`opening.reason=${envelopeResult.opening.reason}`);
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
