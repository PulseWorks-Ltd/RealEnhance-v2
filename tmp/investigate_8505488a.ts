import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const DIR = path.join(__dirname, "prodimg");

async function runAttempt(n: 1 | 2) {
  console.log(`\n\n########## job_8505488a attempt ${n} — all 4 checks ##########`);
  const baselinePath = path.join(DIR, "baseline_8505488a.jpg");
  const stagedPath = path.join(DIR, `attempt${n}_8505488a.webp`);
  const ctx = { jobId: `investigate-8505488a-a${n}`, imageId: `investigate-8505488a-a${n}` };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  console.log("openings:", JSON.stringify(baseline.openings.map((o: any) => ({ id: o.id, type: o.type, description: o.description })), null, 2));
  console.log("anchorFixtures:", JSON.stringify((baseline.anchorFixtures || []).map((f: any) => ({ id: f.id, type: f.type, description: f.description })), null, 2));
  const [envelopeResult, fixtureResult] = await Promise.all([
    runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx),
    runFixtureFlooringValidator(baselinePath, stagedPath, baseline, ctx),
  ]);
  console.log(`opening.status=${envelopeResult.opening.status} envelope.status=${envelopeResult.envelope.status} fixture.status=${fixtureResult.fixture.status} floor.status=${fixtureResult.floor.status}`);
  console.log(`opening.reason=${envelopeResult.opening.reason}`);
  console.log(`envelope.reason=${envelopeResult.envelope.reason}`);
  console.log(`envelope.wallBreachDescription=${(envelopeResult.envelope as any).wallBreachDescription}`);
  console.log(`fixture.reason=${fixtureResult.fixture.reason}`);
  console.log(`floor.reason=${fixtureResult.floor.reason}`);
  console.log("FULL opening itemResults:", JSON.stringify((envelopeResult as any).itemResults, null, 2));
  console.log("FULL fixture itemResults:", JSON.stringify(fixtureResult.itemResults, null, 2));
}

async function main() {
  const which = process.argv[2];
  if (which === "1") await runAttempt(1);
  else if (which === "2") await runAttempt(2);
  else {
    await runAttempt(1);
    await runAttempt(2);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
