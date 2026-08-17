import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const DIR = path.join(__dirname, "prodimg");

async function main() {
  const ctx = { jobId: "3e255f88-reverify2-a2", imageId: "3e255f88-reverify2-a2" };
  const baselinePath = path.join(DIR, "baseline_3e255f88.jpg");
  const stagedPath = path.join(DIR, "attempt2_3e255f88.webp");
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const fixtureResult = await runFixtureFlooringValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`fixture.status=${fixtureResult.fixture.status}`);
  console.log(`fixture.reason=${fixtureResult.fixture.reason}`);
  console.log(`floor.status=${fixtureResult.floor.status}`);
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
