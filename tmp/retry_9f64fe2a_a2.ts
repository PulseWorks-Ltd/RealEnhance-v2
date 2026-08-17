import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const DIR = path.join(__dirname, "prodimg");

async function main() {
  const baselinePath = path.join(DIR, "baseline_9f64fe2a.jpg");
  const stagedPath = path.join(DIR, "attempt2_9f64fe2a.webp");
  const ctx = { jobId: "job_9f64fe2a-live-a2-retry", imageId: "job_9f64fe2a-live-a2-retry" };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const [envelopeResult, fixtureResult] = await Promise.all([
    runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx),
    runFixtureFlooringValidator(baselinePath, stagedPath, baseline, ctx),
  ]);
  console.log(`opening.status=${envelopeResult.opening.status} envelope.status=${envelopeResult.envelope.status}`);
  console.log(`opening.reason=${envelopeResult.opening.reason}`);
  console.log(`envelope.reason=${envelopeResult.envelope.reason}`);
  console.log(`fixture.status=${fixtureResult.fixture.status}`);
  console.log(`fixture.reason=${fixtureResult.fixture.reason}`);
  console.log(`floor.status=${fixtureResult.floor.status}`);
  console.log(`floor.reason=${fixtureResult.floor.reason}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
