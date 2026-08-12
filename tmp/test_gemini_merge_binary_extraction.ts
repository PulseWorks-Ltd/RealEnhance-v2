// TEMPORARY, standalone experiment — does NOT touch the committed
// worker/src/providers/geminiMerge/extraction.ts prompt/logic.
//
// Question: does Gemini reliably produce a strict BINARY (no greys, no photo,
// no shading) staging-vs-original segmentation, as opposed to the alpha/shadow
// mask prompt that just returned a grayscale photo instead of a mask?
//
// Reuses the original + already-generated staged candidate from the prior
// real test run (no restaging, no extra generation cost) and reuses the
// existing (format-agnostic) mask validator + compositor modules for
// diagnostics/overlay/composite.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { runWithSelectedImageModel } from "../worker/src/ai/runWithImageModelFallback";
import { toBase64 } from "../worker/src/utils/images";
import { validateExtractionMask } from "../worker/src/providers/geminiMerge/maskValidator";
import { compositeStagingLayer, buildMaskOverlayDebugImage } from "../worker/src/providers/geminiMerge/compositor";

const MODEL = "gemini-2.5-flash-image";

function buildStrictBinaryPrompt(): string {
  return [
    "You are given two photographs of the exact same room, taken from the exact same camera position.",
    "IMAGE_A is the ORIGINAL photograph. IMAGE_B is a STAGED version with furniture and decor added.",
    "",
    "Task: output a PURE BLACK AND WHITE BINARY DIAGRAM, same dimensions as the input images.",
    "",
    "BLACK = pixels that belong to the original room (walls, ceiling, floor, windows, doors, existing",
    "  content — anything present in IMAGE_A).",
    "WHITE = pixels belonging to newly added furniture/decor in IMAGE_B that was not present in IMAGE_A.",
    "",
    "STRICT REQUIREMENTS:",
    "- Only two colors allowed: pure black (0,0,0) and pure white (255,255,255).",
    "- No greys. No gradients. No soft edges. No anti-aliasing.",
    "- No shading, no shadows, no photographic content, no texture.",
    "- Do NOT represent the room, its lighting, or its colors in any way.",
    "- This is NOT a photograph. It is a binary diagram / silhouette cutout mask.",
    "- The output must look like a flat black-and-white stencil, similar to:",
    "  BLACK BLACK BLACK",
    "  BLACK WHITE WHITE",
    "  BLACK WHITE WHITE",
    "  BLACK BLACK BLACK",
    "- Output IMAGE ONLY. No text, no JSON, no explanation.",
  ].join("\n");
}

function findFirstInlineImagePart(parts: any[]): { mimeType: string; data: string } | null {
  for (const part of parts || []) {
    const inlineData = part?.inlineData;
    if (!inlineData?.data) continue;
    const mimeType = String(inlineData.mimeType || "image/png").toLowerCase();
    if (!mimeType.startsWith("image/")) continue;
    return { mimeType, data: String(inlineData.data) };
  }
  return null;
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const originalPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");
  const stagedPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-2.webp");

  const originalMeta = await sharp(originalPath).metadata();
  const width = originalMeta.width || 0;
  const height = originalMeta.height || 0;
  console.log("=== binary extraction test starting ===", { width, height });

  const imageA = toBase64(originalPath);
  const imageB = toBase64(stagedPath);
  const prompt = buildStrictBinaryPrompt();

  const ai = getGeminiClient();
  const startedAt = Date.now();
  const run = await runWithSelectedImageModel({
    stageLabel: "2",
    ai,
    model: MODEL,
    baseRequest: {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { text: "IMAGE_A (original):" },
            { inlineData: { mimeType: imageA.mime, data: imageA.data } },
            { text: "IMAGE_B (staged):" },
            { inlineData: { mimeType: imageB.mime, data: imageB.data } },
          ],
        },
      ],
      generationConfig: { temperature: 0, topP: 0.1, candidateCount: 1 },
    } as any,
    context: "temp_binary_extraction_experiment",
    meta: {
      jobId: "temp_binary_test",
      imageId: "temp_binary_test",
      stage: "2",
      reason: "temp_binary_extraction_experiment",
      callType: "image_generation",
    },
  });
  const durationMs = Date.now() - startedAt;

  const parts: any[] = run.resp?.candidates?.[0]?.content?.parts || [];
  const imagePart = findFirstInlineImagePart(parts);
  if (!imagePart) {
    console.error("NO IMAGE RETURNED", { durationMs });
    process.exit(1);
  }

  const rawBuffer = Buffer.from(imagePart.data, "base64");
  const rawMaskPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-binary-test-raw.png");
  await sharp(rawBuffer).resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toFile(rawMaskPath);

  // Binary-threshold at 127 (deterministic, local — our own code doing the
  // black/white decision, not trusting Gemini's raw pixel values directly).
  const grayscaleRaw = await sharp(rawBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .raw()
    .toBuffer();
  const binarized = Buffer.alloc(grayscaleRaw.length);
  for (let i = 0; i < grayscaleRaw.length; i += 1) {
    binarized[i] = (grayscaleRaw[i] ?? 0) >= 127 ? 255 : 0;
  }
  const binaryMaskPngBuffer = await sharp(binarized, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const binaryMaskPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-binary-test-thresholded.png");
  await fs.writeFile(binaryMaskPath, binaryMaskPngBuffer);

  const validation = await validateExtractionMask({ sourceImagePath: originalPath, maskPngBuffer: binaryMaskPngBuffer });

  const overlayBuffer = await buildMaskOverlayDebugImage({ originalImagePath: originalPath, maskPngBuffer: binaryMaskPngBuffer });
  const overlayPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-binary-test-overlay.png");
  await fs.writeFile(overlayPath, overlayBuffer);

  let compositePath: string | null = null;
  if (validation.valid) {
    const compositedBuffer = await compositeStagingLayer({
      originalImagePath: originalPath,
      stagedImagePath: stagedPath,
      maskPngBuffer: binaryMaskPngBuffer,
    });
    compositePath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-binary-test-composite.webp");
    await sharp(compositedBuffer).webp({ quality: 95 }).toFile(compositePath);
  }

  console.log("\n=== RESULTS ===");
  console.log(JSON.stringify({
    durationMs,
    modelUsed: run.modelUsed,
    rawMaskPath,
    binaryMaskPath,
    overlayPath,
    compositePath,
    validation,
  }, null, 2));
}

main().catch((e) => {
  console.error("test_gemini_merge_binary_extraction failed:", e);
  process.exit(1);
});
