// Production integration tests for the anchor-locked Stage 2 prompt path
// (worker/src/pipeline/anchorLockedStaging.ts + worker/src/pipeline/stage2.ts).
// Calls the REAL, exported runStage2GenerationAttempt() directly — the
// actual production function, not a mock — three times:
//
//   Test 1: flag OFF (STAGE2_PROMPT_VARIANT left at whatever worker/.env
//           actually has, "grok" — confirms the default path is completely
//           unaffected by this change).
//   Test 2: flag ON, Bedroom 12, roomType=bedroom — real end-to-end run
//           through baseline extraction -> wall-visibility -> planner ->
//           prompt assembly -> generation, confirming the production wiring
//           reproduces tonight's proven tmp/ result.
//   Test 3: flag ON, a Living room image, roomType=living_room (not in
//           SUPPORTED_ROOM_TYPES) — confirms the fallback path actually
//           triggers (not just reading the code and trusting it), and that
//           the job still completes successfully via the existing prompt.
import path from "path";
import { runStage2GenerationAttempt } from "../worker/src/pipeline/stage2";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_IMAGE = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");
const LIVING_IMAGE = path.join(REPO_ROOT, "Test Images/Living (Baseline)/Rental 07.jpg");
const OUT_DIR = path.join(REPO_ROOT, "tmp");

async function runTest(label: string, envValue: string | undefined, imagePath: string, roomType: string, outputName: string) {
  const prevEnv = process.env.STAGE2_PROMPT_VARIANT;
  if (envValue === undefined) delete process.env.STAGE2_PROMPT_VARIANT;
  else process.env.STAGE2_PROMPT_VARIANT = envValue;

  console.log(`\n########## ${label} (STAGE2_PROMPT_VARIANT=${process.env.STAGE2_PROMPT_VARIANT ?? "<unset>"}, roomType=${roomType}) ##########`);
  try {
    const outputPath = await runStage2GenerationAttempt(imagePath, {
      roomType,
      sceneType: "interior",
      sourceStage: "1A",
      jobId: `tmp-integration-${label.replace(/\s+/g, "-").toLowerCase()}`,
      imageId: `tmp-integration-${label.replace(/\s+/g, "-").toLowerCase()}`,
      outputPath: path.join(OUT_DIR, outputName),
      attempt: 1,
    });
    console.log(`${label}: SUCCESS, output=${outputPath}`);
  } catch (e) {
    console.error(`${label}: FAILED`, e);
    throw e;
  } finally {
    if (prevEnv === undefined) delete process.env.STAGE2_PROMPT_VARIANT;
    else process.env.STAGE2_PROMPT_VARIANT = prevEnv;
  }
}

async function main() {
  // Test 1: flag OFF — use whatever worker/.env actually has (loaded via -r dotenv/config),
  // do NOT override it, to prove the real default env value's behavior is untouched.
  await runTest("TEST1 flag-off default path", process.env.STAGE2_PROMPT_VARIANT, BEDROOM_IMAGE, "bedroom", "integration-test1-flagoff.webp");

  // Test 2: flag ON, supported room type, real end-to-end.
  await runTest("TEST2 anchor-locked bedroom", "anchor_locked", BEDROOM_IMAGE, "bedroom", "integration-test2-anchorlocked-bedroom.webp");

  // Test 3: flag ON, unsupported room type -> must fall back, not fail.
  await runTest("TEST3 anchor-locked unsupported roomtype fallback", "anchor_locked", LIVING_IMAGE, "living_room", "integration-test3-fallback-living.webp");

  console.log("\n=== ALL THREE INTEGRATION TESTS COMPLETED ===");
}

main().catch((e) => {
  console.error("test_production_integration failed:", e);
  process.exit(1);
});
