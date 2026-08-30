// Investigate a new false positive surfaced by the six-case regression
// re-run after adding two classifier vocabulary patterns (ABSENCE: "no
// visible NOUN" ordering; REPLACED: "plain" wall adjective) in response to
// the real Bedroom 14 case. bedroom11-FIXED is a confirmed ground-truth
// PASS case that started failing on C1 with verdict="removed" after those
// two additions. Need the raw model text to see which of the two new
// patterns (or something else) is responsible.
import fs from "fs/promises";
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");

async function main() {
  process.env.STAGE2_VALIDATOR_MODEL = "gemini";
  const bedroom11Baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/colocated_risk_snapshot_bedroom11.json"), "utf8")).baseline;
  const bedroom11Original = path.join(BEDROOM_DIR, "Bedroom 11.jpg");
  const stagedFixed = path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp");

  const r = await runOpeningEnvelopeValidator(bedroom11Original, stagedFixed, bedroom11Baseline, { jobId: "investigate-b11fixed", imageId: "investigate-b11fixed" });
  console.log("opening.status:", r.opening.status);
  console.log("FULL itemResults:", JSON.stringify(r.itemResults, null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
