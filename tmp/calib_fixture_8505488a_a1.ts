import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const DIR = path.join(__dirname, "prodimg");

async function main() {
  const baselinePath = path.join(DIR, "baseline_8505488a.jpg");
  const stagedPath = path.join(DIR, "attempt1_8505488a.webp");
  const ctx = { jobId: `calib-fixture-8505488a-a1-${Date.now()}`, imageId: "calib-fixture-8505488a-a1" };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const fixtureResult = await runFixtureFlooringValidator(baselinePath, stagedPath, baseline, ctx);
  console.log("fixture.status=", fixtureResult.fixture.status);
  console.log("fixture.reason=", fixtureResult.fixture.reason);
  const f1 = fixtureResult.itemResults.find((r: any) => r.id === "F1");
  console.log("F1 full result:", JSON.stringify(f1, null, 2));
  console.log("ALL itemResults ids/verdicts:", fixtureResult.itemResults.map((r: any) => `${r.id}:${r.verdict}`).join(", "));
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
