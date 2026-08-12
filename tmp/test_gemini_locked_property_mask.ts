// TEMPORARY, standalone experiment (Experiment B) — single-image "locked
// property mask" test. Does NOT touch any committed provider code. Question:
// can Gemini reliably identify architectural/fixed elements that must be
// preserved, given ONE real photo (no staged candidate, no diffing, no
// alpha/shadow estimation) — a different and simpler task shape than the
// furniture-extraction experiment that just failed twice.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { runWithSelectedImageModel } from "../worker/src/ai/runWithImageModelFallback";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = "gemini-2.5-flash-image";

function buildLockedPropertyPrompt(): string {
  return [
    "You are given a single real estate room photograph.",
    "",
    "Task: output a PURE BLACK AND WHITE BINARY DIAGRAM, same dimensions as the input image.",
    "",
    "WHITE = LOCKED / MUST PRESERVE. This includes:",
    "windows and window frames, doors and door frames, doorways/openings, walls, ceilings,",
    "flooring/floor surface, cabinetry, countertops, islands, wardrobes, closets, built-ins,",
    "fireplaces, bathroom fixtures, plumbing, fixed appliances, stairs, railings, columns/beams,",
    "and any other permanent architectural feature.",
    "",
    "BLACK = NOT LOCKED. This includes: empty space, areas where furniture can be introduced,",
    "furniture/decor that can be replaced, staging areas.",
    "",
    "STRICT REQUIREMENTS:",
    "- Only two colors allowed: pure black (0,0,0) and pure white (255,255,255).",
    "- No greys, no gradients, no soft edges, no anti-aliasing, no shading, no shadows.",
    "- Do NOT represent the room's photographic appearance, lighting, or colors.",
    "- This is NOT a photograph. It is a binary diagram / silhouette cutout mask.",
    "- Be conservative: if uncertain whether something is a permanent architectural feature,",
    "  mark it WHITE (locked). It is much worse to mark a doorway/window/wall as editable than",
    "  to mark a small patch of empty floor as locked.",
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

function findBoundingBox(binary: Buffer, width: number, height: number, targetValue: number) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (binary[y * width + x] !== targetValue) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function countConnectedComponents(binary: Buffer, width: number, targetValue: number): number {
  const visited = new Uint8Array(binary.length);
  let count = 0;
  const offsets = [-1, 1, -width, width];
  for (let index = 0; index < binary.length; index += 1) {
    if (binary[index] !== targetValue || visited[index] === 1) continue;
    count += 1;
    const queue: number[] = [index];
    visited[index] = 1;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      const x = current % width;
      for (const offset of offsets) {
        const next = current + offset;
        if (next < 0 || next >= binary.length || visited[next] === 1 || binary[next] !== targetValue) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
  }
  return count;
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const originalPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");

  const originalMeta = await sharp(originalPath).metadata();
  const width = originalMeta.width || 0;
  const height = originalMeta.height || 0;
  console.log("=== locked-property mask test starting ===", { width, height });

  const image = toBase64(originalPath);
  const prompt = buildLockedPropertyPrompt();

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
            { inlineData: { mimeType: image.mime, data: image.data } },
          ],
        },
      ],
      generationConfig: { temperature: 0, topP: 0.1, candidateCount: 1 },
    } as any,
    context: "temp_locked_property_mask_experiment",
    meta: {
      jobId: "temp_locked_property_test",
      imageId: "temp_locked_property_test",
      stage: "2",
      reason: "temp_locked_property_mask_experiment",
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
  const rawMaskPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-locked-test-raw.png");
  await sharp(rawBuffer).resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toFile(rawMaskPath);

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
  const binaryMaskPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-locked-test-thresholded.png");
  await fs.writeFile(binaryMaskPath, binaryMaskPngBuffer);

  // Overlay: WHITE (locked) shown as translucent blue on the original, so it's
  // visually distinct from the furniture-extraction experiment's red overlay.
  const overlayAlpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) {
    overlayAlpha[i] = binarized[i] > 0 ? 140 : 0;
  }
  const blueFill = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    blueFill[i * 3] = 30; blueFill[i * 3 + 1] = 90; blueFill[i * 3 + 2] = 255;
  }
  const overlayRgba = await sharp(blueFill, { raw: { width, height, channels: 3 } })
    .joinChannel(overlayAlpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  const overlayBuffer = await sharp(originalPath)
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .composite([{ input: overlayRgba, blend: "over" }])
    .png()
    .toBuffer();
  const overlayPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-locked-test-overlay.png");
  await fs.writeFile(overlayPath, overlayBuffer);

  let whiteCount = 0;
  for (const v of binarized) if (v > 0) whiteCount += 1;
  const totalPixels = width * height;
  const whiteRatio = whiteCount / totalPixels;
  const blackRatio = 1 - whiteRatio;
  const whiteBoundingBox = findBoundingBox(binarized, width, height, 255);
  const whiteComponents = countConnectedComponents(binarized, width, 255);
  const blackComponents = countConnectedComponents(binarized, width, 0);

  console.log("\n=== RESULTS ===");
  console.log(JSON.stringify({
    durationMs,
    modelUsed: run.modelUsed,
    rawMaskPath,
    binaryMaskPath,
    overlayPath,
    diagnostics: {
      width, height,
      whitePixelCount: whiteCount,
      whitePixelRatio: whiteRatio,
      blackPixelRatio: blackRatio,
      whiteBoundingBox,
      whiteConnectedComponentCount: whiteComponents,
      blackConnectedComponentCount: blackComponents,
    },
  }, null, 2));
}

main().catch((e) => {
  console.error("test_gemini_locked_property_mask failed:", e);
  process.exit(1);
});
