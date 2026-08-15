// Part 3: Bedroom 12 clean-case instability re-check, with the classifyExtent
// fix now also in place (on top of the earlier negation fix). Full
// item-level detail for both models, 2 runs each, to identify root cause of
// any remaining flip-flop precisely.
import path from "path";
import { runFlooringBoundaryCheck, extractFlooringZones } from "../worker/src/validators/flooringBoundaryCheck";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const baseline = path.join(BEDROOM_DIR, "Bedroom 12.jpg");
const staged = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)/Bedroom 12 (Enhanced).webp");

async function main() {
  // Flooring check (this is what the original instability was in)
  const zones = await extractFlooringZones(baseline, { jobId: "b12recheck-extract", imageId: "b12recheck-extract" });
  console.log("flooring zones:", JSON.stringify(zones));

  for (const model of ["grok", "gemini"] as const) {
    process.env.STAGE2_VALIDATOR_MODEL = model;
    console.log(`\n\n========== FLOORING [${model}] ==========`);
    for (let r = 1; r <= 2; r++) {
      const result = await runFlooringBoundaryCheck(baseline, staged, { jobId: `b12recheck-floor-${model}-r${r}`, imageId: `b12recheck-floor-${model}-r${r}` }, zones);
      console.log(`run ${r}: status=${result.floor.status}`);
      console.log(JSON.stringify(result.itemResults, null, 2));
    }
  }

  // Also re-check opening/envelope + fixture for completeness (full clean-case check)
  const structBaseline: any = await extractStructuralBaseline(baseline, { jobId: "b12recheck-struct-baseline", imageId: "b12recheck-struct-baseline" });
  for (const model of ["grok", "gemini"] as const) {
    process.env.STAGE2_VALIDATOR_MODEL = model;
    console.log(`\n\n========== OPENING/ENVELOPE [${model}] ==========`);
    for (let r = 1; r <= 2; r++) {
      const result = await runOpeningEnvelopeValidator(baseline, staged, structBaseline, { jobId: `b12recheck-open-${model}-r${r}`, imageId: `b12recheck-open-${model}-r${r}` });
      console.log(`run ${r}: opening.status=${result.opening.status} envelope.status=${result.envelope.status}`);
      if (result.opening.status === "fail" || result.envelope.status === "fail") {
        console.log(JSON.stringify(result.itemResults, null, 2));
      }
    }
  }

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
