// Investigates whether the current occlusion-vs-removal question set has
// any ability to detect a resize/reposition violation (as opposed to
// removal/replacement/coverage, which is all it was designed to ask
// about). Ground truth: Bedroom 09's second window is still fully present
// and unobstructed in both images, but is visibly larger/more square and
// shifted along the wall in the staged version — confirmed by direct user
// visual inspection. Full raw text is printed (not truncated) so it can
// be inspected for any size/position awareness at all.
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const STAGED_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)");

async function runOnce(model: "gemini" | "grok", runIdx: number, baselinePath: string, stagedPath: string, baseline: any) {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const ctx = { jobId: `b09resize-${model}-r${runIdx}`, imageId: `b09resize-${model}-r${runIdx}` };
  const oe = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`\n=== [${model}] run ${runIdx}: opening.status=${oe.opening.status} envelope.status=${oe.envelope.status} (required=fail) ===`);
  console.log("FULL itemResults:", JSON.stringify(oe.itemResults, null, 2));
  return oe.opening.status;
}

async function main() {
  const baselinePath = path.join(BEDROOM_DIR, "Bedroom 09.jpg");
  const stagedPath = path.join(STAGED_DIR, "Bedroom 09 (Enhanced).webp");
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId: "b09resize-baseline", imageId: "b09resize-baseline" });
  console.log("openings:", JSON.stringify(baseline.openings.map((o: any) => ({ id: o.id, type: o.type, bbox: o.bbox, description: o.description })), null, 2));

  const results: Record<string, string[]> = { gemini: [], grok: [] };
  for (const model of ["gemini", "grok"] as const) {
    for (let r = 1; r <= 2; r++) {
      results[model].push(await runOnce(model, r, baselinePath, stagedPath, baseline));
    }
  }
  console.log(`\n\n>>> SUMMARY [bedroom09-resize] required=fail | gemini=${results.gemini.join("/")} | grok=${results.grok.join("/")}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
