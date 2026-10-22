import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const PROD_DIR = path.join(__dirname, "prodimg");
const REPO_ROOT = path.resolve(__dirname, "..");

async function run3e255f88() {
  console.log("\n\n########## job_3e255f88 attempt 2 — W2 window (opening check) ##########");
  const baselinePath = path.join(PROD_DIR, "baseline_3e255f88.jpg");
  const stagedPath = path.join(PROD_DIR, "attempt2_3e255f88.webp");
  const ctx = { jobId: "investigate-3e255f88-a2", imageId: "investigate-3e255f88-a2" };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const envelopeResult = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log("opening.status=", envelopeResult.opening.status);
  console.log("FULL itemResults:", JSON.stringify((envelopeResult as any).itemResults, null, 2));
}

async function runD8329bfc() {
  console.log("\n\n########## job_d8329bfc attempt 2 — C1 closet door (opening check) ##########");
  const baselinePath = path.join(PROD_DIR, "baseline_d8329bfc.jpg");
  const stagedPath = path.join(PROD_DIR, "attempt2_d8329bfc.webp");
  const ctx = { jobId: "investigate-d8329bfc-a2", imageId: "investigate-d8329bfc-a2" };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const envelopeResult = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log("opening.status=", envelopeResult.opening.status);
  console.log("FULL itemResults:", JSON.stringify((envelopeResult as any).itemResults, null, 2));
}

async function runBedroom02() {
  console.log("\n\n########## Bedroom 02 — D1 door (opening check) ##########");
  const baselinePath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 02.jpg");
  const stagedPath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 02 - Staged 2.jpg");
  const ctx = { jobId: "investigate-bedroom02", imageId: "investigate-bedroom02" };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const envelopeResult = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log("opening.status=", envelopeResult.opening.status);
  console.log("FULL itemResults:", JSON.stringify((envelopeResult as any).itemResults, null, 2));
}

async function main() {
  const which = process.argv[2];
  if (which === "3e255f88") await run3e255f88();
  else if (which === "d8329bfc") await runD8329bfc();
  else if (which === "bedroom02") await runBedroom02();
  else {
    await run3e255f88();
    await runD8329bfc();
    await runBedroom02();
  }
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
