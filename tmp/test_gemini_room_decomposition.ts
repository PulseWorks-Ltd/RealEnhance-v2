// TEMPORARY, standalone experiment (Test 1 / "Idea A") — does NOT modify
// worker/src/validators/openingPreservationValidator.ts or any committed
// provider code. Question: does the already-proven JSON-bbox pattern (used
// in production for openings/anchorFixtures) extend reliably to floor and
// blank-wall region classification too? If so, we can deterministically
// render a full protection/editable mask ourselves, with zero dependence on
// Gemini emitting an image (the thing that has failed 3/3 times tonight).
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

// Mirrors the model choice of the proven production baseline extractor
// (openingPreservationValidator.ts:617-619) — gemini-2.5-pro, a text/reasoning
// model, NOT gemini-2.5-flash-image (the image-generation model used for all
// 3 failed mask experiments tonight). This is a deliberate, important
// difference, not an oversight.
const MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

type Bbox = [number, number, number, number]; // normalized 0-1 [x1,y1,x2,y2]

const SYSTEM_INSTRUCTION = `You are a structural feature extraction engine.

You must analyze a single interior room image and decompose it into categorized regions.

Permanent openings include:
- Windows
- Doors
- Closet doors
- Archways
- Built-in fixed openings

Fixtures include:
- AC units, fireplaces, built-in cabinets, kitchen islands, staircases, and other permanent
  built-in features.

Floor regions are the visible floor/carpet/flooring surface, excluding any area occupied by
existing furniture sitting on top of it.

Blank wall regions are contiguous wall surface not occupied by an opening, fixture, or
wall-mounted object (art, mirrors, switches, vents are NOT openings/fixtures but should NOT be
counted as blank wall either — leave them uncategorized).

Ignore: furniture, decor, lighting, reflections, curtains, temporary objects, wall art, mirrors.

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.

If you are uncertain whether something is a structural opening or fixture, include it (bias
toward over-protecting rather than under-protecting).

If uncertain whether an area is genuinely open floor or blank wall, do not include it — bias
toward leaving it uncategorized rather than guessing.`;

const USER_PROMPT = `Analyze this room image and decompose it into regions.

Return JSON in this exact schema (all bbox coordinates normalized 0-1, [x1,y1,x2,y2]):

{
  "openings": [
    { "id": string, "type": "window"|"door"|"closet_door"|"walkthrough", "bbox": [x1,y1,x2,y2], "confidence": number }
  ],
  "anchorFixtures": [
    { "id": string, "type": "ac_unit"|"fireplace"|"built_in_cabinet"|"kitchen_island"|"staircase"|"other", "bbox": [x1,y1,x2,y2], "confidence": number }
  ],
  "floorRegions": [
    { "id": string, "bbox": [x1,y1,x2,y2], "confidence": number }
  ],
  "blankWallRegions": [
    { "id": string, "bbox": [x1,y1,x2,y2], "confidence": number }
  ]
}`;

function extractJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

function denorm(bbox: Bbox, width: number, height: number) {
  const [x1, y1, x2, y2] = bbox;
  return {
    left: Math.max(0, Math.min(width - 1, Math.round(x1 * width))),
    top: Math.max(0, Math.min(height - 1, Math.round(y1 * height))),
    right: Math.max(0, Math.min(width, Math.round(x2 * width))),
    bottom: Math.max(0, Math.min(height, Math.round(y2 * height))),
  };
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const originalPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");
  const meta = await sharp(originalPath).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  console.log("=== room decomposition test starting ===", { width, height });

  const image = toBase64(originalPath);
  const ai = getGeminiClient();
  const startedAt = Date.now();
  const response = await (ai as any).models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: SYSTEM_INSTRUCTION },
          { text: USER_PROMPT },
          { inlineData: { mimeType: image.mime, data: image.data } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      topK: 1,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  });
  const durationMs = Date.now() - startedAt;

  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) {
    console.error("NO TEXT RETURNED", { durationMs, parts: parts.map((p: any) => Object.keys(p)) });
    process.exit(1);
  }

  console.log("=== RAW RESPONSE TEXT ===");
  console.log(textPart.text);

  let parsed: any;
  try {
    parsed = extractJson(textPart.text);
  } catch (e: any) {
    console.error("JSON PARSE FAILED", e.message);
    process.exit(1);
  }

  const openings = parsed.openings || [];
  const anchorFixtures = parsed.anchorFixtures || [];
  const floorRegions = parsed.floorRegions || [];
  const blankWallRegions = parsed.blankWallRegions || [];

  console.log("=== PARSED COUNTS ===", {
    openings: openings.length,
    anchorFixtures: anchorFixtures.length,
    floorRegions: floorRegions.length,
    blankWallRegions: blankWallRegions.length,
  });

  // Deterministically render the mask ourselves: WHITE = editable
  // (floor ∪ blank wall), BLACK = protected (openings ∪ fixtures), drawn on
  // top so exclusions always win regardless of overlap.
  const maskRaw = Buffer.alloc(width * height, 0);
  const fillRect = (bbox: Bbox, value: number) => {
    const { left, top, right, bottom } = denorm(bbox, width, height);
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        maskRaw[y * width + x] = value;
      }
    }
  };
  for (const r of floorRegions) if (r.bbox) fillRect(r.bbox, 255);
  for (const r of blankWallRegions) if (r.bbox) fillRect(r.bbox, 255);
  for (const r of openings) if (r.bbox) fillRect(r.bbox, 0);
  for (const r of anchorFixtures) if (r.bbox) fillRect(r.bbox, 0);

  const maskPngBuffer = await sharp(maskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const maskPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-decomp-test-mask.png");
  await fs.writeFile(maskPath, maskPngBuffer);

  // Overlay: green = editable (floor/wall), red = protected (openings/fixtures)
  const overlayRgb = Buffer.alloc(width * height * 3);
  const overlayAlpha = Buffer.alloc(width * height);
  const paintOverlay = (bboxes: any[], r: number, g: number, b: number) => {
    for (const item of bboxes) {
      if (!item.bbox) continue;
      const { left, top, right, bottom } = denorm(item.bbox, width, height);
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const idx = y * width + x;
          overlayRgb[idx * 3] = r; overlayRgb[idx * 3 + 1] = g; overlayRgb[idx * 3 + 2] = b;
          overlayAlpha[idx] = 130;
        }
      }
    }
  };
  paintOverlay(floorRegions, 40, 200, 60);
  paintOverlay(blankWallRegions, 40, 200, 60);
  paintOverlay(openings, 220, 30, 30);
  paintOverlay(anchorFixtures, 220, 140, 20);

  const overlayRgba = await sharp(overlayRgb, { raw: { width, height, channels: 3 } })
    .joinChannel(overlayAlpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  const overlayBuffer = await sharp(originalPath)
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .composite([{ input: overlayRgba, blend: "over" }])
    .png()
    .toBuffer();
  const overlayPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-decomp-test-overlay.png");
  await fs.writeFile(overlayPath, overlayBuffer);

  let whiteCount = 0;
  for (const v of maskRaw) if (v > 0) whiteCount += 1;

  console.log("\n=== RESULTS ===");
  console.log(JSON.stringify({
    durationMs,
    modelUsed: MODEL,
    maskPath,
    overlayPath,
    whitePixelRatio: whiteCount / (width * height),
    openings,
    anchorFixtures,
    floorRegions,
    blankWallRegions,
  }, null, 2));
}

main().catch((e) => {
  console.error("test_gemini_room_decomposition failed:", e);
  process.exit(1);
});
