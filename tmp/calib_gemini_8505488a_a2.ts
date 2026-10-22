import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";

// Deliberately NOT setting STAGE2_VALIDATOR_MODEL=grok here, so this routes
// to the Gemini flash/pro-escalation path instead, to test whether a
// different/stronger model catches what Grok missed on the same real image.
const DIR = path.join(__dirname, "prodimg");

async function main() {
  const baselinePath = path.join(DIR, "baseline_8505488a.jpg");
  const stagedPath = path.join(DIR, "attempt2_8505488a.webp");
  const ctx = { jobId: "calib-gemini-8505488a-a2", imageId: "calib-gemini-8505488a-a2" };
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
