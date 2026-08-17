import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const DIR = path.join(__dirname, "prodimg");

async function testCase(label: string, baseline: string, staged: string, jobId: string) {
  const ctx = { jobId, imageId: jobId };
  console.log(`\n########## ${label} ##########`);
  const baselineData: any = await extractStructuralBaseline(path.join(DIR, baseline), ctx);
  const [envelopeResult, fixtureResult] = await Promise.all([
    runOpeningEnvelopeValidator(path.join(DIR, baseline), path.join(DIR, staged), baselineData, ctx),
    runFixtureFlooringValidator(path.join(DIR, baseline), path.join(DIR, staged), baselineData, ctx),
  ]);
  console.log(`opening.status=${envelopeResult.opening.status} envelope.status=${envelopeResult.envelope.status} fixture.status=${fixtureResult.fixture.status} floor.status=${fixtureResult.floor.status}`);
  if (envelopeResult.opening.status === "fail") console.log(`opening.reason=${envelopeResult.opening.reason}`);
  if (fixtureResult.fixture.status === "fail") console.log(`fixture.reason=${fixtureResult.fixture.reason}`);
}

async function main() {
  await testCase("job_f53669f1 attempt2 RE-VERIFY (window resize, must-now-pass)", "baseline_f53669f1.jpg", "attempt2_f53669f1.webp", "f53669f1-reverify-a2");
  await testCase("job_3e255f88 attempt2 RE-VERIFY (ceiling light resize, must-now-pass)", "baseline_3e255f88.jpg", "attempt2_3e255f88.webp", "3e255f88-reverify-a2");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
