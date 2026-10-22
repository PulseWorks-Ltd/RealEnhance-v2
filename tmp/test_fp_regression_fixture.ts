import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const DIR = path.join(__dirname, "prodimg");

async function main() {
  const which = process.argv[2];
  const baselinePath = path.join(DIR, `baseline_${which}.jpg`);
  const stagedPath = path.join(DIR, `attempt2_${which}.webp`);
  const ctx = { jobId: `fp-regress-fixture-${which}`, imageId: `fp-regress-fixture-${which}` };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const result = await runFixtureFlooringValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`fixture.status=${result.fixture.status}`);
  for (const it of result.itemResults as any[]) {
    console.log(`  ${it.id} verdict=${it.verdict} resized=${it.classification.resized.value} repositioned=${it.classification.repositioned.value}`);
    console.log(`    extentComparisonDescription: ${it.rawObservation.extentComparisonDescription}`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
