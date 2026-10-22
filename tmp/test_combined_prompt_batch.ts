// Full-test-set run of STAGE2_PROMPT_VARIANT=combined (compacted 3-part
// structure: staging layout expectation -> structural locks -> protected
// features last), generating on Gemini. Same 6 images used for the earlier
// grok_skill batch test, so results are comparable across variants.
// Living07/Living10 use "living_dining" per user correction (these rooms
// are classified living_dining in real app usage, not living_room).
process.env.OPENING_BASELINE_SINGLE_PASS = "1";
process.env.STAGE2_PROMPT_VARIANT = "combined";
import path from "node:path";
import fs from "node:fs";
import { runStage2GenerationAttempt } from "../worker/src/pipeline/stage2";

const OUT_DIR = path.resolve(__dirname, "../Test Images/Grok Skill Prompt Test");
const TEST_IMAGES_DIR = path.resolve(__dirname, "../Test Images/Validator Testing Images");

type TestCase = { name: string; imagePath: string; roomType: string };

const CASES: TestCase[] = [
  { name: "ValentineSt01_bedroom_curtainWindow", imagePath: "2 Valentine Street - Image 01.jpg", roomType: "bedroom" },
  { name: "Bedroom02", imagePath: "job_5add1f4f_Bedroom_02_UPLOAD.jpg", roomType: "bedroom" },
  { name: "Bedroom14", imagePath: "job_828e51fd_Bedroom_14_UPLOAD.jpg", roomType: "bedroom" },
  { name: "Living07_flooringBoundary", imagePath: "job_f61d8dc1_Living_07_UPLOAD.jpg", roomType: "living_dining" },
  { name: "Living10", imagePath: "job_bb5814f4_Living_10_UPLOAD.jpg", roomType: "living_dining" },
  { name: "Kitchen06", imagePath: "job_24a3b64f_Kitchen_06_UPLOAD.jpg", roomType: "kitchen" },
];

async function runCase(tc: TestCase, index: number) {
  const imagePath = path.join(TEST_IMAGES_DIR, tc.imagePath);
  const outputPath = path.join(OUT_DIR, `${tc.name}-combined-output.webp`);
  console.log(`\n[${tc.name}] Running combined-variant Stage 2 generation (roomType=${tc.roomType})...`);
  try {
    const result = await runStage2GenerationAttempt(imagePath, {
      roomType: tc.roomType,
      jobId: `test_combined_batch_${index}`,
      imageId: `img_${tc.name}`,
      outputPath,
      stagingStyle: "standard_listing",
      attempt: 1,
      promptMode: "full",
    });
    console.log(`[${tc.name}] DONE — ${result} (${fs.existsSync(result) ? fs.statSync(result).size : 0} bytes)`);
    return { name: tc.name, ok: true, outPath: result };
  } catch (err: any) {
    console.error(`[${tc.name}] ERROR:`, err?.message || err);
    return { name: tc.name, ok: false, reason: String(err?.message || err) };
  }
}

async function main() {
  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    results.push(await runCase(CASES[i], i));
  }
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
