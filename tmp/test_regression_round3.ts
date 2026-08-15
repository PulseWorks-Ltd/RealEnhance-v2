// Six-case standing regression set, re-run through the now-four-question
// occlusion-vs-removal check (fourth question: extentComparisonDescription,
// classified into resized/repositioned, feeding a new "resized" verdict).
// Confirms the new question doesn't introduce false positives on any of
// these well-established, trusted-ground-truth cases. Both models, 2 runs
// each, opening+envelope scope only (matches every prior round tonight).
import fs from "fs/promises";
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const STAGED_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)");

type Case = { label: string; baselineImagePath: string; stagedImagePath: string; requiredStatus: "pass" | "fail"; baseline?: any; roomType?: string };

async function runOnce(c: Case, model: "gemini" | "grok", runIdx: number) {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const ctx = { jobId: `reg4q-${c.label}-${model}-r${runIdx}`, imageId: `reg4q-${c.label}-${model}-r${runIdx}` };
  const oe = await runOpeningEnvelopeValidator(c.baselineImagePath, c.stagedImagePath, c.baseline, ctx);
  const resizedFlags = oe.itemResults.filter((i) => i.verdict === "resized").map((i) => i.id);
  console.log(
    `[${c.label}][${model}][run${runIdx}] opening.status=${oe.opening.status} required=${c.requiredStatus}${resizedFlags.length ? ` RESIZED_FLAGGED=${resizedFlags.join(",")}` : ""}`
  );
  if (oe.materialAlteredItems.length > 0) {
    console.log(`  material+altered:`, JSON.stringify(oe.materialAlteredItems.map((i) => ({ id: i.id, verdict: i.verdict }))));
  }
  return oe.opening.status;
}

async function runCase(c: Case) {
  console.log(`\n\n########## CASE: ${c.label} (required=${c.requiredStatus}) ##########`);
  const results: Record<string, string[]> = { gemini: [], grok: [] };
  for (const model of ["gemini", "grok"] as const) {
    for (let r = 1; r <= 2; r++) {
      results[model].push(await runOnce(c, model, r));
    }
  }
  console.log(`>>> SUMMARY [${c.label}] required=${c.requiredStatus} | gemini=${results.gemini.join("/")} | grok=${results.grok.join("/")}`);
}

async function main() {
  const bedroom11Baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/colocated_risk_snapshot_bedroom11.json"), "utf8")).baseline;
  const bedroom12Baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/bedroom12_baseline_withdesc.json"), "utf8"));
  const bedroom11Original = path.join(BEDROOM_DIR, "Bedroom 11.jpg");

  await runCase({ label: "bedroom11-UNFIXED", baselineImagePath: bedroom11Original, stagedImagePath: path.join(BEDROOM_DIR, "Bedroom 11-staged-UNFIXED-controlled.webp"), requiredStatus: "fail", baseline: bedroom11Baseline });
  await runCase({ label: "bedroom11-FIXED", baselineImagePath: bedroom11Original, stagedImagePath: path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp"), requiredStatus: "pass", baseline: bedroom11Baseline });

  const living10Original = path.join(LIVING_DIR, "Living 10.jpg");
  console.log("\n=== Fresh baseline extraction: Living 10 ===");
  const living10Baseline: any = await extractStructuralBaseline(living10Original, { jobId: "reg4q-living10-baseline", imageId: "reg4q-living10-baseline" });
  await runCase({ label: "living10", baselineImagePath: living10Original, stagedImagePath: path.join(LIVING_DIR, "Living 10-staged-sharedpath.webp"), requiredStatus: "fail", baseline: living10Baseline });

  const living07Original = path.join(LIVING_DIR, "Living 07.jpg");
  console.log("\n=== Fresh baseline extraction: Living 07 ===");
  const living07Baseline: any = await extractStructuralBaseline(living07Original, { jobId: "reg4q-living07-baseline", imageId: "reg4q-living07-baseline" });
  await runCase({ label: "living07-fireplace", baselineImagePath: living07Original, stagedImagePath: path.join(LIVING_DIR, "Living 07-staged-v2.webp"), requiredStatus: "pass", baseline: living07Baseline });

  const bedroom02Original = path.join(BEDROOM_DIR, "Bedroom 02.jpg");
  console.log("\n=== Fresh baseline extraction: Bedroom 02 ===");
  const bedroom02Baseline: any = await extractStructuralBaseline(bedroom02Original, { jobId: "reg4q-bedroom02-baseline", imageId: "reg4q-bedroom02-baseline" });
  await runCase({ label: "bedroom02-door-to-mirror", baselineImagePath: bedroom02Original, stagedImagePath: path.join(BEDROOM_DIR, "Bedroom 02 - Staged 2.jpg"), requiredStatus: "fail", baseline: bedroom02Baseline });

  await runCase({ label: "bedroom12-clean", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 12.jpg"), stagedImagePath: path.join(STAGED_DIR, "Bedroom 12 (Enhanced).webp"), requiredStatus: "pass", baseline: bedroom12Baseline });

  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("test_regression_round3 (4q) failed:", e);
  process.exit(1);
});
