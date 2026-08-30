// Re-run of the job_b29d5e7d ("Bedroom 14") local reproduction using the
// CORRECT baseline image. The original repro (test_bedroom02_railway_repro.ts)
// used "Test Images/Bedroom (Baseline)/Bedroom 02.jpg" as a stand-in baseline
// — that file turned out to be a DIFFERENT physical room (dark carpet, single
// window, recessed downlights, hinged door) than the one actually depicted in
// the staged runs (beige carpet, two windows, flush-mount dome light, sliding
// closet door) — confirmed by direct visual comparison. The user has since
// added the correct baseline as "Bedroom 14.jpg" in the Validator Testing
// Images folder. This script re-runs the real validator against the correct
// baseline, with the negation-awareness fix and Q1 wording fix now applied.
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const baselinePath = path.join(REPO_ROOT, "Test Images/Validator Testing Images/Bedroom 14.jpg");
const staged1Path = path.join(REPO_ROOT, "Test Images/Validator Testing Images/Bedroom 14 Testing - Staged Run 1.webp");
const staged2Path = path.join(REPO_ROOT, "Test Images/Validator Testing Images/Bedroom 14 Testing - Staged Run 2.webp");

async function main() {
  process.env.STAGE2_VALIDATOR_MODEL = "gemini"; // production default at time of incident
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId: "railway-repro2-baseline", imageId: "railway-repro2-baseline" });
  console.log("openings:", JSON.stringify(baseline.openings.map((o: any) => ({ id: o.id, type: o.type, bbox: o.bbox, description: o.description })), null, 2));

  console.log("\n\n########## STAGED RUN 1 (correct baseline) ##########");
  const r1 = await runOpeningEnvelopeValidator(baselinePath, staged1Path, baseline, { jobId: "railway-repro2-r1", imageId: "railway-repro2-r1" });
  console.log("opening.status:", r1.opening.status, "opening.hardFail:", r1.opening.hardFail);
  console.log("materialAlteredItems:", JSON.stringify(r1.materialAlteredItems.map((i: any) => i.id)));
  console.log("FULL itemResults:", JSON.stringify(r1.itemResults, null, 2));

  console.log("\n\n########## STAGED RUN 2 (correct baseline) ##########");
  const r2 = await runOpeningEnvelopeValidator(baselinePath, staged2Path, baseline, { jobId: "railway-repro2-r2", imageId: "railway-repro2-r2" });
  console.log("opening.status:", r2.opening.status, "opening.hardFail:", r2.opening.hardFail);
  console.log("materialAlteredItems:", JSON.stringify(r2.materialAlteredItems.map((i: any) => i.id)));
  console.log("FULL itemResults:", JSON.stringify(r2.itemResults, null, 2));

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
