// Standalone test for STAGE2_PROMPT_VARIANT=combined — nano's prompt text
// with anchor_locked's real per-photo planning grafted on top, generating
// on Gemini (not Grok). Bypasses the job queue; calls runStage2GenerationAttempt
// directly.
process.env.OPENING_BASELINE_SINGLE_PASS = "1";
process.env.STAGE2_PROMPT_VARIANT = "combined";
import path from "node:path";
import fs from "node:fs";
import { runStage2GenerationAttempt } from "../worker/src/pipeline/stage2";

const OUT_DIR = path.resolve(__dirname, "../Test Images/Grok Skill Prompt Test");
const TEST_IMAGES_DIR = path.resolve(__dirname, "../Test Images/Validator Testing Images");

async function main() {
  const imagePath = path.join(TEST_IMAGES_DIR, "job_828e51fd_Bedroom_14_UPLOAD.jpg");
  const outputPath = path.join(OUT_DIR, "Bedroom14-combined-output.webp");

  console.log("Running Stage 2 generation with STAGE2_PROMPT_VARIANT=combined...");
  const result = await runStage2GenerationAttempt(imagePath, {
    roomType: "bedroom",
    jobId: "test_combined_0",
    imageId: "img_Bedroom14_combined",
    outputPath,
    stagingStyle: "standard_listing",
    attempt: 1,
    promptMode: "full",
  });

  console.log("\n=== RESULT ===");
  console.log("Returned path:", result);
  console.log("File exists:", fs.existsSync(result), "size:", fs.existsSync(result) ? fs.statSync(result).size : 0);
}

main().catch((err) => {
  console.error("ERROR:", err?.message || err);
  process.exit(1);
});
