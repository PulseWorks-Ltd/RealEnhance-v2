// Reproduction test for the Bedroom 11 window-walled-over regression, with
// the co-located-feature fix applied (worker/src/pipeline/anchorLockedStaging.ts).
// Calls the real runStage2GenerationAttempt() directly, same as
// tmp/test_production_integration.ts, against the actual Bedroom 11
// baseline photo the user flagged.
import path from "path";
import { runStage2GenerationAttempt } from "../worker/src/pipeline/stage2";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM11_IMAGE = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 11.jpg");

async function main() {
  process.env.STAGE2_PROMPT_VARIANT = "anchor_locked";
  console.log("=== Bedroom 11 reproduction, anchor_locked + co-located-feature fix ===");
  const outputPath = await runStage2GenerationAttempt(BEDROOM11_IMAGE, {
    roomType: "bedroom",
    sceneType: "interior",
    sourceStage: "1A",
    jobId: "tmp-bedroom11-fix-repro",
    imageId: "tmp-bedroom11-fix-repro",
    outputPath: path.join(REPO_ROOT, "tmp", "bedroom11-fix-repro.webp"),
    attempt: 1,
  });
  console.log("SUCCESS, output=", outputPath);
}

main().catch((e) => {
  console.error("test_bedroom11_fix failed:", e);
  process.exit(1);
});
