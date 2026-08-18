import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const DIR = path.join(__dirname, "prodimg");

async function main() {
  const baselinePath = path.join(DIR, "baseline_4f09191f.jpg");
  const stagedPath = path.join(DIR, "attempt1_4f09191f.webp");
  const ctx = { jobId: "calib-4f09191f-a1", imageId: "calib-4f09191f-a1" };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const envelopeResult = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`opening.status=${envelopeResult.opening.status} envelope.status=${envelopeResult.envelope.status}`);
  console.log(`envelope.reason=${envelopeResult.envelope.reason}`);
  console.log(`envelope.wallBreachDescription=${(envelopeResult.envelope as any).wallBreachDescription}`);
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
