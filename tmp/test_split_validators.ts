// Focused diagnostic re-run: Living 07 fireplace case only, full raw
// itemResults logged, to inspect the new "resized" false-positive
// candidate found in the six-case regression run (Grok run 2 flagged W1
// as resized; need the actual extentComparisonDescription text to judge
// whether this is a genuine new false positive from the fourth question).
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

async function runOnce(model: "gemini" | "grok", runIdx: number, baselinePath: string, stagedPath: string, baseline: any) {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const ctx = { jobId: `l07diag-${model}-r${runIdx}`, imageId: `l07diag-${model}-r${runIdx}` };
  const oe = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`\n=== [${model}] run ${runIdx}: opening.status=${oe.opening.status} (required=pass) ===`);
  console.log("FULL itemResults:", JSON.stringify(oe.itemResults, null, 2));
  return oe.opening.status;
}

async function main() {
  const baselinePath = path.join(LIVING_DIR, "Living 07.jpg");
  const stagedPath = path.join(LIVING_DIR, "Living 07-staged-v2.webp");
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId: "l07diag-baseline", imageId: "l07diag-baseline" });
  console.log("openings:", baseline.openings.map((o: any) => `${o.id}(${o.type})`).join(", "));

  const results: Record<string, string[]> = { gemini: [], grok: [] };
  for (const model of ["gemini", "grok"] as const) {
    for (let r = 1; r <= 2; r++) {
      results[model].push(await runOnce(model, r, baselinePath, stagedPath, baseline));
    }
  }
  console.log(`\n\n>>> SUMMARY [living07-fireplace-diag] required=pass | gemini=${results.gemini.join("/")} | grok=${results.grok.join("/")}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
