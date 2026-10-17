// TEMPORARY, standalone experiment (Test 2 / "Idea B") — does not touch any
// committed provider code. Question: will Gemini comply with "generate only
// new furniture/decor, do not render the room at all," or will it default to
// rendering a full room again (the pattern seen 3/3 times tonight on the
// mask-format experiments)? This uses the image-generation model
// (gemini-2.5-flash-image), since the deliverable here genuinely is an image,
// unlike Test 1's JSON extraction task.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { runWithSelectedImageModel } from "../worker/src/ai/runWithImageModelFallback";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = "gemini-2.5-flash-image";

function buildFurnitureOnlyPrompt(roomType: string, stagingStyle: string): string {
  return [
    `You are given a single photograph of an empty ${roomType}.`,
    "",
    "Task: generate ONLY the new furniture and decor objects that would be added to stage this",
    "room, appropriate for a real estate listing in a " + stagingStyle + " style.",
    "",
    "CRITICAL REQUIREMENT: Do NOT render the room itself. Do not render the walls, ceiling,",
    "floor, windows, doors, or any existing room content. The output must show ONLY the new",
    "furniture and decor objects, on a plain flat magenta (255,0,255) background, positioned,",
    "scaled, and lit as if they were about to be inserted into the room shown in the reference",
    "photo (use the reference photo only to judge correct scale, perspective, and lighting",
    "direction — do not reproduce any of its content).",
    "",
    "Output IMAGE ONLY. No text, no explanation.",
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
  const meta = await sharp(originalPath).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  console.log("=== furniture-only generation test starting ===", { width, height });

  const image = toBase64(originalPath);
  const prompt = buildFurnitureOnlyPrompt("bedroom", "standard_listing");

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
      generationConfig: { temperature: 0.4, topP: 0.9, candidateCount: 1 },
    } as any,
    context: "temp_furniture_only_experiment",
    meta: {
      jobId: "temp_furniture_only_test",
      imageId: "temp_furniture_only_test",
      stage: "2",
      reason: "temp_furniture_only_experiment",
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
  const outPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-furniture-only-raw.png");
  await sharp(rawBuffer).png().toFile(outPath);
  const outMeta = await sharp(rawBuffer).metadata();

  console.log("\n=== RESULTS ===");
  console.log(JSON.stringify({
    durationMs,
    modelUsed: run.modelUsed,
    outPath,
    outputDimensions: { width: outMeta.width, height: outMeta.height },
  }, null, 2));
}

main().catch((e) => {
  console.error("test_gemini_furniture_only failed:", e);
  process.exit(1);
});
