// Validator cross-model test: run the existing openingEnvelopeValidator +
// fixtureFlooringValidator (locate-and-describe design) with
// STAGE2_VALIDATOR_MODEL=grok against the two priority cases from tonight's
// standing regression set, reusing EXISTING Gemini-generated staged images
// already on disk (no new generation needed) — Living 10 (window fully
// replaced by a painting; Gemini's own validator sometimes hallucinated a
// pass here) and Bedroom 11 UNFIXED (window infilled; Gemini's validator
// was stable-correct here after its classifier bugs were fixed). 2 runs
// each, per the task's testing plan. STAGE2_VALIDATOR_MODEL must be set to
// "grok" in the environment before running this script.
import fs from "fs/promises";
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { resolveValidatorModel } from "../worker/src/validators/occlusionVsRemovalCheck";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

async function runOnce(label: string, runIdx: number, baselineImagePath: string, stagedImagePath: string, baseline: any) {
  console.log(`\n\n########## CASE: ${label} — RUN ${runIdx} (validatorModel=${resolveValidatorModel()}) ##########`);
  const ctx = { jobId: `grokval-${label}-r${runIdx}`, imageId: `grokval-${label}-r${runIdx}` };
  const oe = await runOpeningEnvelopeValidator(baselineImagePath, stagedImagePath, baseline, ctx);
  console.log("opening.status:", oe.opening.status, "| envelope.status:", oe.envelope.status);
  console.log("OPENING itemResults:", JSON.stringify(oe.itemResults, null, 2));
  console.log("OPENING material+altered:", oe.materialAlteredItems.length === 0 ? "(none)" : JSON.stringify(oe.materialAlteredItems.map((i) => ({ id: i.id, verdict: i.verdict })), null, 2));
  return oe;
}

async function runCaseTwice(label: string, baselineImagePath: string, stagedImagePath: string, baseline: any) {
  const r1 = await runOnce(label, 1, baselineImagePath, stagedImagePath, baseline);
  const r2 = await runOnce(label, 2, baselineImagePath, stagedImagePath, baseline);
  const stable = r1.opening.status === r2.opening.status;
  console.log(`\n>>> STABILITY [${label}]: ${stable ? "STABLE" : "UNSTABLE"} (run1=${r1.opening.status}, run2=${r2.opening.status})`);
}

async function main() {
  console.log("resolveValidatorModel() =", resolveValidatorModel());
  if (resolveValidatorModel() !== "grok") {
    console.error("STAGE2_VALIDATOR_MODEL is not set to grok — aborting to avoid a misleading test run.");
    process.exit(1);
  }

  const snapshot = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/colocated_risk_snapshot_bedroom11.json"), "utf8"));
  const bedroom11Baseline = snapshot.baseline;
  const bedroom11Original = path.join(BEDROOM_DIR, "Bedroom 11.jpg");
  await runCaseTwice("bedroom11-UNFIXED", bedroom11Original, path.join(BEDROOM_DIR, "Bedroom 11-staged-UNFIXED-controlled.webp"), bedroom11Baseline);

  const living10Original = path.join(LIVING_DIR, "Living 10.jpg");
  console.log("\n\n=== Fresh baseline extraction (Gemini, unrelated to STAGE2_VALIDATOR_MODEL): Living 10 ===");
  const living10Baseline: any = await extractStructuralBaseline(living10Original, { jobId: "grokval-living10-baseline", imageId: "grokval-living10-baseline" });
  console.log("openings:", living10Baseline.openings.map((o: any) => `${o.id}(${o.type})`).join(", "));
  await runCaseTwice("living10", living10Original, path.join(LIVING_DIR, "Living 10-staged-sharedpath.webp"), living10Baseline);

  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("test_grok_validator failed:", e);
  process.exit(1);
});
