// Standalone test harness for feature/grok-skill-prompt-test — bypasses
// the full job queue (Redis/BullMQ/S3) entirely. For each test image:
// 1. Runs the real layout-planner pipeline (buildGrokSkillStage2Prompt ->
//    extractStructuralBaseline + extractWallVisibility + real per-image
//    anchor-wall selection), producing a prompt with SKILL_STRUCTURAL_LOCKS
//    swapped in for CATEGORY_A_LOCKS.
// 2. Sends that prompt + the source image to Grok's /images/edits via the
//    existing grokImageEdit adapter.
// 3. Saves the output image and the exact prompt used, for manual review.
process.env.OPENING_BASELINE_SINGLE_PASS = "1";
import fs from "node:fs";
import path from "node:path";
import { buildGrokSkillStage2Prompt } from "../worker/src/pipeline/anchorLockedStaging";
import { grokImageEdit } from "../worker/src/ai/grok";
import { toBase64 } from "../worker/src/utils/images";

const OUT_DIR = path.resolve(__dirname, "../Test Images/Grok Skill Prompt Test");

type TestCase = { name: string; imagePath: string; roomType: string };

// v2 re-run: strengthened GEOMETRIC ENVELOPE LOCK wording (NON-NEGOTIABLE /
// ZERO TOLERANCE framing to match CATEGORY_A_LOCKS's severity, plus an
// explicit "moving a window/door to a different wall" prohibition). Output
// filenames suffixed "-v2" so the originals are kept for before/after
// comparison, not overwritten.
const CASES: TestCase[] = [
  { name: "Bedroom14-v2", imagePath: "job_828e51fd_Bedroom_14_UPLOAD.jpg", roomType: "bedroom" },
];

const TEST_IMAGES_DIR = path.resolve(__dirname, "../Test Images/Validator Testing Images");

async function runCase(tc: TestCase, index: number) {
  const imagePath = path.join(TEST_IMAGES_DIR, tc.imagePath);
  const jobId = `test_grok_skill_${index}`;
  const imageId = `img_${tc.name}`;
  console.log(`\n[${tc.name}] Building skill-based prompt (roomType=${tc.roomType})...`);

  const result = await buildGrokSkillStage2Prompt({ imagePath, roomType: tc.roomType, jobId, imageId });
  if (!result.prompt) {
    console.log(`[${tc.name}] FAILED to build prompt: ${result.fallbackReason}`);
    return { name: tc.name, ok: false, reason: result.fallbackReason };
  }

  const promptPath = path.join(OUT_DIR, `${tc.name}-prompt.txt`);
  fs.writeFileSync(promptPath, result.prompt);
  console.log(`[${tc.name}] Prompt built (${result.prompt.length} chars), anchorWallId=${result.diagnostics.anchorWallId}, protectedFeatures=${result.diagnostics.protectedFeatureCount}`);

  const { data, mime } = toBase64(imagePath);
  console.log(`[${tc.name}] Sending to Grok image edit...`);
  const grokResult = await grokImageEdit({
    imageBuffer: Buffer.from(data, "base64"),
    mimeType: mime,
    prompt: result.prompt,
    jobId,
    imageId,
    reason: "test_grok_skill_prompt_batch",
  });

  const outPath = path.join(OUT_DIR, `${tc.name}-output.png`);
  fs.writeFileSync(outPath, grokResult.buffer);
  console.log(`[${tc.name}] DONE — saved to ${outPath} (${grokResult.buffer.length} bytes)`);
  return { name: tc.name, ok: true, outPath, promptPath, diagnostics: result.diagnostics };
}

async function main() {
  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    try {
      const r = await runCase(CASES[i], i);
      results.push(r);
    } catch (err: any) {
      console.error(`[${CASES[i].name}] ERROR:`, err?.message || err);
      results.push({ name: CASES[i].name, ok: false, reason: String(err?.message || err) });
    }
  }
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
