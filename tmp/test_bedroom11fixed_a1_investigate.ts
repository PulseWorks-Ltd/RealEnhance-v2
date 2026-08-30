// Investigate Bedroom 11-FIXED's A1 (walkthrough opening) failure. Used
// both for the git-stash A/B comparison and for pulling multiple fresh
// Grok raw-text runs to characterize the failure.
import fs from "fs/promises";
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");

async function main() {
  process.env.STAGE2_VALIDATOR_MODEL = "grok";
  const bedroom11Baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/colocated_risk_snapshot_bedroom11.json"), "utf8")).baseline;
  const bedroom11Original = path.join(BEDROOM_DIR, "Bedroom 11.jpg");
  const stagedFixed = path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp");

  const runs = Number(process.env.A1_RUNS || "1");
  for (let r = 1; r <= runs; r++) {
    const ctx = { jobId: `a1investigate-r${r}`, imageId: `a1investigate-r${r}` };
    const result = await runOpeningEnvelopeValidator(bedroom11Original, stagedFixed, bedroom11Baseline, ctx);
    const a1 = result.itemResults.find((i) => i.id === "A1");
    console.log(`\n--- run ${r}: opening.status=${result.opening.status} ---`);
    if (a1) console.log(JSON.stringify(a1, null, 2));
    else console.log("A1 not found in itemResults:", result.itemResults.map((i) => i.id).join(","));
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
