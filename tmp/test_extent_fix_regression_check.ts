// Quick sanity check: classifyExtent was tightened (removed the bare
// "extends past" pattern, requiring whole-region-scoped language instead).
// Confirm this didn't reduce detection power on bedroom11-UNFIXED, a known
// real violation the old pattern set correctly caught via fully_covered/
// removed verdicts. Grok-primary; Gemini logged for reference only.
import fs from "fs/promises";
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");

async function runOnce(label: string, model: "gemini" | "grok", baselinePath: string, stagedPath: string, baseline: any, required: string) {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const ctx = { jobId: `extentreg-${label}-${model}`, imageId: `extentreg-${label}-${model}` };
  const r = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`[${label}][${model}] opening.status=${r.opening.status} (required=${required})`);
  if (r.materialAlteredItems.length > 0) {
    console.log(`  altered: ${r.materialAlteredItems.map((i) => `${i.id}=${i.verdict}(extent=${i.classification.extent.value},${i.classification.extent.matchedPattern})`).join(", ")}`);
  }
  return r.opening.status;
}

async function main() {
  const bedroom11Baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/colocated_risk_snapshot_bedroom11.json"), "utf8")).baseline;
  const bedroom11Original = path.join(BEDROOM_DIR, "Bedroom 11.jpg");
  const unfixed = path.join(BEDROOM_DIR, "Bedroom 11-staged-UNFIXED-controlled.webp");
  const fixed = path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp");

  for (const model of ["grok", "gemini"] as const) {
    await runOnce("bedroom11-UNFIXED", model, bedroom11Original, unfixed, bedroom11Baseline, "fail");
  }
  for (const model of ["grok", "gemini"] as const) {
    await runOnce("bedroom11-FIXED", model, bedroom11Original, fixed, bedroom11Baseline, "pass");
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
