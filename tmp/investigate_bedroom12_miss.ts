import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const REPO_ROOT = path.resolve(__dirname, "..");

async function main() {
  const jobId = "investigate-bedroom12-miss";
  const baselinePath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");
  const stagedPath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12-2.webp");

  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId, imageId: jobId });
  console.log("openings:", JSON.stringify(baseline.openings.map((o: any) => ({ id: o.id, type: o.type, bbox: o.bbox, description: o.description })), null, 2));
  console.log("anchorFixtures:", JSON.stringify((baseline.anchorFixtures || []).map((f: any) => ({ id: f.id, type: f.type, bbox: f.bbox, description: f.description })), null, 2));

  const [openingEnvelopeResult, fixtureFlooringResult] = await Promise.all([
    runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, { jobId, imageId: jobId }),
    runFixtureFlooringValidator(baselinePath, stagedPath, baseline, { jobId, imageId: jobId }),
  ]);

  console.log(`\nopening.status=${openingEnvelopeResult.opening.status} envelope.status=${openingEnvelopeResult.envelope.status}`);
  console.log(`envelope.reason=${openingEnvelopeResult.envelope.reason}`);
  console.log(`fixture.status=${fixtureFlooringResult.fixture.status}`);

  console.log("\nFULL opening itemResults:", JSON.stringify(openingEnvelopeResult.itemResults, null, 2));
  console.log("\nFULL fixture itemResults:", JSON.stringify(fixtureFlooringResult.itemResults, null, 2));

  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
