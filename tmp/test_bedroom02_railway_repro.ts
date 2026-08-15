// Local reproduction of the production Railway job_b29d5e7d failure on
// Bedroom 02 Staged Run 1, to see D1's (the actual door) full raw
// observation and verdict — the production log only captured full detail
// for the flagged item (W1), not for D1, which wasn't flagged at all.
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const baselinePath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 02.jpg");
const staged1Path = path.join(REPO_ROOT, "Test Images/Validator Testing Images/Bedroom 02 Testing - Staged Run 1.webp");
const staged2Path = path.join(REPO_ROOT, "Test Images/Validator Testing Images/Bedroom 02 Testing - Staged Run 2.webp");

async function main() {
  process.env.STAGE2_VALIDATOR_MODEL = "gemini"; // production default
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId: "railway-repro-baseline", imageId: "railway-repro-baseline" });
  console.log("openings:", JSON.stringify(baseline.openings.map((o: any) => ({ id: o.id, type: o.type, bbox: o.bbox, description: o.description })), null, 2));

  console.log("\n\n########## STAGED RUN 1 ##########");
  const r1 = await runOpeningEnvelopeValidator(baselinePath, staged1Path, baseline, { jobId: "railway-repro-r1", imageId: "railway-repro-r1" });
  console.log("opening.status:", r1.opening.status);
  console.log("FULL itemResults:", JSON.stringify(r1.itemResults, null, 2));

  console.log("\n\n########## STAGED RUN 2 ##########");
  const r2 = await runOpeningEnvelopeValidator(baselinePath, staged2Path, baseline, { jobId: "railway-repro-r2", imageId: "railway-repro-r2" });
  console.log("opening.status:", r2.opening.status);
  console.log("FULL itemResults:", JSON.stringify(r2.itemResults, null, 2));

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
