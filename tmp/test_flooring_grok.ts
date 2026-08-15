// Part 2a: existing floorIntegrityValidator through Grok (newly wired this
// task) against Living 07's confirmed real flooring-unification failure —
// "Living 07-staged-precisefloorcheck.webp" (NOT "-v2", which was used in
// all other tests tonight for unrelated opening/fixture checks; the
// baseline's real diagonal carpet/linoleum material boundary is visibly
// erased into one uniform material in THIS specific file, confirmed by
// direct crop comparison before writing this script). Runs BOTH models on
// the identical file/question for a fair, direct comparison, since no
// fresh Gemini data exists yet for this exact pairing either.
import path from "path";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

async function runOnce(model: "gemini" | "grok", runIdx: number, baselinePath: string, stagedPath: string) {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const ctx = { jobId: `floorgrok-${model}-r${runIdx}`, imageId: `floorgrok-${model}-r${runIdx}` };
  const result = await runFloorIntegrityValidator(baselinePath, stagedPath, ctx);
  console.log(`\n=== [${model}] run ${runIdx}: status=${result.status} hardFail=${result.hardFail} (required=fail) ===`);
  console.log("reason:", result.reason);
  console.log("confidence:", result.confidence);
  return result.status;
}

async function main() {
  const baselinePath = path.join(LIVING_DIR, "Living 07.jpg");
  const stagedPath = path.join(LIVING_DIR, "Living 07-staged-precisefloorcheck.webp");

  const results: Record<string, string[]> = { gemini: [], grok: [] };
  for (const model of ["gemini", "grok"] as const) {
    for (let r = 1; r <= 2; r++) {
      results[model].push(await runOnce(model, r, baselinePath, stagedPath));
    }
  }
  console.log(`\n\n>>> SUMMARY [living07-precisefloorcheck] required=fail | gemini=${results.gemini.join("/")} | grok=${results.grok.join("/")}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
