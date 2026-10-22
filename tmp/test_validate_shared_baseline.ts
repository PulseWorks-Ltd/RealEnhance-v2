import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const REPO_ROOT = path.resolve(__dirname, "..");

async function main() {
  const jobId = "test-validate-shared-baseline";
  const baselinePath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");
  const stagedPath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12-2.webp");

  console.log("### Resolving the SAME baseline used by generation (should reuse the extractStructuralBaseline result, not fresh) ###");
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId, imageId: jobId });
  console.log(`baseline graphHash=${baseline.graphMeta?.graphHash}`);

  const [openingEnvelopeResult, fixtureFlooringResult] = await Promise.all([
    runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, { jobId, imageId: jobId }),
    runFixtureFlooringValidator(baselinePath, stagedPath, baseline, { jobId, imageId: jobId }),
  ]);
  console.log(`opening.status=${openingEnvelopeResult.opening.status} envelope.status=${openingEnvelopeResult.envelope.status}`);
  console.log(`fixture.status=${fixtureFlooringResult.fixture.status} floor.status=${fixtureFlooringResult.floor.status}`);
  if (openingEnvelopeResult.opening.status === "fail") console.log(`opening.reason=${openingEnvelopeResult.opening.reason}`);
  if (openingEnvelopeResult.envelope.status === "fail") console.log(`envelope.reason=${openingEnvelopeResult.envelope.reason}`);
  if (fixtureFlooringResult.fixture.status === "fail") console.log(`fixture.reason=${fixtureFlooringResult.fixture.reason}`);
  if (fixtureFlooringResult.floor.status === "fail") console.log(`floor.reason=${fixtureFlooringResult.floor.reason}`);
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
