// Part 1: envelope validator through Grok (newly wired this task, via
// STAGE2_VALIDATOR_MODEL, same toggle occlusionVsRemovalCheck.ts already
// uses). Two cases: Bedroom 11 FIXED (the exact case that produced
// Gemini's known false positive — envelope_confirmed_structural_change on
// the closet-door-track-partially-visible-behind-furniture situation) and
// Bedroom 12 clean (basic regression sanity check). No confirmed real
// envelope/geometry violation exists in tonight's standing test set — every
// real violation found was an opening or fixture issue — so this can only
// test for false positives, not true-positive catch rate; noted honestly
// in the report, not silently assumed away.
import path from "path";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const STAGED_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)");

async function runOnce(label: string, model: "gemini" | "grok", runIdx: number, baselinePath: string, stagedPath: string, required: "pass" | "fail") {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const ctx = { jobId: `envgrok-${label}-${model}-r${runIdx}`, imageId: `envgrok-${label}-${model}-r${runIdx}` };
  const result = await runEnvelopeValidator(baselinePath, stagedPath, ctx);
  console.log(`\n=== [${label}][${model}] run ${runIdx}: status=${result.status} hardFail=${result.hardFail} (required=${required}) ===`);
  console.log("reason:", result.reason);
  console.log("confidence:", result.confidence);
  console.log("issueType:", result.issueType);
  return result.status;
}

async function main() {
  const bedroom11Original = path.join(BEDROOM_DIR, "Bedroom 11.jpg");
  const bedroom11Fixed = path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp");
  const bedroom12Original = path.join(BEDROOM_DIR, "Bedroom 12.jpg");
  const bedroom12Clean = path.join(STAGED_DIR, "Bedroom 12 (Enhanced).webp");

  console.log("########## CASE: Bedroom 11 FIXED (known Gemini false-positive case) ##########");
  const b11results: string[] = [];
  for (let r = 1; r <= 2; r++) {
    b11results.push(await runOnce("bedroom11-FIXED", "grok", r, bedroom11Original, bedroom11Fixed, "pass"));
  }
  console.log(`>>> SUMMARY [bedroom11-FIXED envelope via grok] required=pass | grok=${b11results.join("/")}`);

  console.log("\n\n########## CASE: Bedroom 12 clean (regression sanity check) ##########");
  const b12results: string[] = [];
  for (let r = 1; r <= 2; r++) {
    b12results.push(await runOnce("bedroom12-clean", "grok", r, bedroom12Original, bedroom12Clean, "pass"));
  }
  console.log(`>>> SUMMARY [bedroom12-clean envelope via grok] required=pass | grok=${b12results.join("/")}`);

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
