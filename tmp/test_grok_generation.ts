// Real test of STAGE2_PROMPT_VARIANT=grok's generation path: build the
// SAME anchor-locked prompt the Gemini path uses (buildAnchorLockedStage2Prompt,
// unmodified — exactly what stage2.ts now calls for both "anchor_locked"
// and "grok" variants), then send it to Grok's image-edit API instead of
// Gemini's. One real call per case, compared directly against the existing
// Gemini-generated result for the same image already on disk.
import fs from "fs/promises";
import path from "path";
import { toBase64 } from "../worker/src/utils/images";
import { grokImageEdit } from "../worker/src/ai/grok";
import { buildAnchorLockedStage2Prompt } from "../worker/src/pipeline/anchorLockedStaging";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

async function runCase(label: string, imagePath: string, roomType: string, outPath: string) {
  console.log(`\n\n########## GENERATION CASE: ${label} ##########`);
  const promptStart = Date.now();
  const promptResult = await buildAnchorLockedStage2Prompt({
    imagePath,
    roomType,
    jobId: `grok-gen-${label}`,
    imageId: `grok-gen-${label}`,
  });
  console.log("prompt build ms:", Date.now() - promptStart);
  console.log("diagnostics:", JSON.stringify(promptResult.diagnostics, null, 2));
  if (!promptResult.prompt) {
    console.log("FALLBACK — no anchor-locked prompt produced:", promptResult.fallbackReason);
    return;
  }
  console.log("prompt length (chars):", promptResult.prompt.length);
  console.log("prompt excerpt (first 600 chars):", promptResult.prompt.slice(0, 600));

  const { data, mime } = toBase64(imagePath);
  const genStart = Date.now();
  const result = await grokImageEdit({
    imageBuffer: Buffer.from(data, "base64"),
    mimeType: mime,
    prompt: promptResult.prompt,
    jobId: `grok-gen-${label}`,
    imageId: `grok-gen-${label}`,
    reason: `grok_generation_test_${label}`,
  });
  console.log("generation ms:", Date.now() - genStart, "output bytes:", result.buffer.length);
  await fs.writeFile(outPath, result.buffer);
  console.log("saved to:", outPath);
}

async function main() {
  try {
    await runCase(
      "bedroom11",
      path.join(BEDROOM_DIR, "Bedroom 11.jpg"),
      "bedroom",
      "/tmp/grok_gen_bedroom11.png"
    );
  } catch (e) {
    console.error("CASE bedroom11 FAILED (continuing to next case):", e);
  }

  try {
    await runCase(
      "living10",
      path.join(LIVING_DIR, "Living 10.jpg"),
      "living_dining",
      "/tmp/grok_gen_living10.png"
    );
  } catch (e) {
    console.error("CASE living10 FAILED:", e);
  }

  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("test_grok_generation failed:", e);
  process.exit(1);
});
