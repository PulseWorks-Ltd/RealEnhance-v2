// New confirmed-failure case found via re-inspection: "Bedroom (Staged)/Bedroom 14 (Enhanced).webp"
// has a large framed painting hung directly in front of / over the left
// window's own glass and blind area, substantially covering it — visually
// confirmed via crop, distinct from "Bedroom (Staged 2)/Bedroom 14 (Enhanced).webp"
// (already tested, confirmed clean).
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const STAGED_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)");

async function runOnce(model: "gemini" | "grok", runIdx: number, baselinePath: string, stagedPath: string, baseline: any) {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const ctx = { jobId: `b14staged-${model}-r${runIdx}`, imageId: `b14staged-${model}-r${runIdx}` };
  const oe = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`[bedroom14-Staged-Enhanced][${model}][run${runIdx}] opening.status=${oe.opening.status} envelope.status=${oe.envelope.status} required=fail`);
  if (oe.materialAlteredItems.length > 0) {
    console.log(`  material+altered:`, JSON.stringify(oe.materialAlteredItems.map((i) => ({ id: i.id, verdict: i.verdict, desc: i.description, trace: i.rawObservation.currentStateDescription }))));
  } else {
    console.log("  material+altered: (none) -- FALSE NEGATIVE if required=fail");
  }
  return oe.opening.status;
}

async function main() {
  const baselinePath = path.join(BEDROOM_DIR, "Bedroom 14.jpg");
  const stagedPath = path.join(STAGED_DIR, "Bedroom 14 (Enhanced).webp");
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId: "b14staged-baseline", imageId: "b14staged-baseline" });
  console.log("openings:", baseline.openings.map((o: any) => `${o.id}(${o.type})`).join(", "));

  const results: Record<string, string[]> = { gemini: [], grok: [] };
  for (const model of ["gemini", "grok"] as const) {
    for (let r = 1; r <= 2; r++) {
      results[model].push(await runOnce(model, r, baselinePath, stagedPath, baseline));
    }
  }
  console.log(`>>> SUMMARY [bedroom14-Staged-Enhanced] required=fail | gemini=${results.gemini.join("/")} | grok=${results.grok.join("/")}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
