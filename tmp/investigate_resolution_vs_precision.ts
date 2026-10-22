// INVESTIGATION 1 (standalone, read-only, no production code touched):
// does Gemini's bbox/polygon precision degrade as input image resolution
// drops? Runs the SAME polygon-extraction prompt (adapted from tonight's
// test_gemini_polygon_regions.ts) against several resized variants of the
// same Bedroom 12 baseline image, converts all results to a common pixel
// reference frame (the original 1440x1080), and compares.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";

const MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const ORIGINAL_PATH = path.join(OUT_DIR, "Bedroom 12.jpg");

type Point = [number, number];

// Same prompt as tonight's polygon test (test_gemini_polygon_regions.ts),
// unchanged — the only variable under test here is input image resolution.
const SYSTEM_INSTRUCTION = `You are a structural feature extraction engine.

You must analyze a single interior room image and decompose it into categorized regions.

Permanent openings include: windows, doors, closet doors, archways, built-in fixed openings.
Fixtures include: AC units, fireplaces, built-in cabinets, kitchen islands, staircases, and
other permanent built-in features.

IMPORTANT — precision requirement for openings and fixtures:
Photographed at an angle, a doorway or window is NOT a rectangle in the image — it is a
skewed quadrilateral (wider/taller at the camera-near edge than the far edge due to
perspective). A bounding box that fully contains this skewed shape necessarily includes a
large amount of extra floor area that is NOT actually part of the opening. This is a known
problem we are trying to fix.

Instead of a bounding box, trace the ACTUAL VISIBLE OUTLINE of each opening/fixture as a
POLYGON: a list of (x,y) vertices, in order (clockwise or counter-clockwise), following the
true visible edges of the frame/opening as closely as possible. Use as many vertices as
needed (4-10) to hug the actual perspective-skewed shape — do not pad it out to a rectangle.
The polygon should be as TIGHT as possible around only the opening/fixture itself, not the
floor in front of it or wall beside it.

Ignore: furniture, decor, lighting, reflections, curtains, temporary objects, wall art, mirrors.

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.

If uncertain whether something is a structural opening/fixture, include it (bias toward
protecting).`;

const USER_PROMPT = `Analyze this room image and identify these specific features:
1. The sliding glass door on the left wall
2. The interior walkthrough doorway on the right side
3. The AC unit mounted on the wall

Return JSON in this exact schema (all coordinates normalized 0-1):
{
  "openings": [
    { "id": string, "type": "window"|"door"|"closet_door"|"walkthrough",
      "polygon": [[x,y], [x,y], ...], "confidence": number }
  ],
  "anchorFixtures": [
    { "id": string, "type": "ac_unit"|"fireplace"|"built_in_cabinet"|"kitchen_island"|"staircase"|"other",
      "polygon": [[x,y], [x,y], ...], "confidence": number }
  ]
}`;

function extractJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

function polygonPixelAreaOnOriginal(points: Point[], origWidth: number, origHeight: number): number {
  // points are already normalized 0-1 (resolution-independent) — area on the
  // common reference frame (original image) is what we compare across variants.
  const px = points.map(([x, y]) => [x * origWidth, y * origHeight]);
  let area = 0;
  for (let i = 0; i < px.length; i += 1) {
    const [x1, y1] = px[i];
    const [x2, y2] = px[(i + 1) % px.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

function denormPolygon(points: Point[], width: number, height: number): string {
  return points.map(([x, y]) => `${Math.round(x * width)},${Math.round(y * height)}`).join(" ");
}

async function runVariant(label: string, imagePath: string, actualWidth: number, actualHeight: number) {
  const buf = await fs.readFile(imagePath);
  const base64 = buf.toString("base64");
  const meta = await sharp(imagePath).metadata();

  console.log(`\n=== variant "${label}" starting (actual sent dimensions: ${meta.width}x${meta.height}) ===`);
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
          { inlineData: { mimeType: "image/jpeg", data: base64 } },
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
    console.error(`variant "${label}": NO TEXT RETURNED`);
    return null;
  }

  let parsed: any;
  try {
    parsed = extractJson(textPart.text);
  } catch (e: any) {
    console.error(`variant "${label}": JSON PARSE FAILED`, e.message);
    return null;
  }

  const openings = parsed.openings || [];
  const anchorFixtures = parsed.anchorFixtures || [];
  const allRegions = [...openings, ...anchorFixtures].filter((r) => Array.isArray(r.polygon) && r.polygon.length >= 3);

  // Render overlay on the ORIGINAL full-resolution image for visual comparison,
  // regardless of what resolution was actually sent to Gemini.
  const overlayColors: Record<string, string> = { door: "rgba(220,30,30,0.5)", walkthrough: "rgba(30,100,220,0.5)", ac_unit: "rgba(220,140,20,0.5)" };
  const svgParts = allRegions.map((r) => {
    const color = overlayColors[r.type] || "rgba(150,30,220,0.5)";
    return `<polygon points="${denormPolygon(r.polygon, actualWidth, actualHeight)}" fill="${color}" stroke="black" stroke-width="2"/>`;
  });
  const svg = `<svg width="${actualWidth}" height="${actualHeight}" xmlns="http://www.w3.org/2000/svg">${svgParts.join("\n")}</svg>`;
  const overlayLayer = await sharp(Buffer.from(svg)).png().toBuffer();
  const overlayBuffer = await sharp(ORIGINAL_PATH)
    .composite([{ input: overlayLayer, blend: "over" }])
    .png()
    .toBuffer();
  const overlayPath = path.join(OUT_DIR, `Bedroom 12-resvariant-${label}-overlay.png`);
  await sharp(overlayBuffer).toFile(overlayPath);

  const regionSummary = allRegions.map((r) => ({
    id: r.id,
    type: r.type,
    confidence: r.confidence,
    vertexCount: r.polygon.length,
    pixelAreaOnOriginal: Math.round(polygonPixelAreaOnOriginal(r.polygon, actualWidth, actualHeight)),
    normalizedPolygon: r.polygon,
  }));

  console.log(`variant "${label}" (${durationMs}ms):`, JSON.stringify(regionSummary, null, 2));

  return { label, sentDimensions: { width: meta.width, height: meta.height }, durationMs, overlayPath, regions: regionSummary };
}

async function main() {
  const origMeta = await sharp(ORIGINAL_PATH).metadata();
  const origWidth = origMeta.width!;
  const origHeight = origMeta.height!;
  console.log("=== resolution vs precision investigation starting ===", { origWidth, origHeight });

  // Build resized variants (all saved as JPEG to keep encoding consistent
  // with the original and avoid PNG-vs-JPEG being a confounding variable).
  const variantSpecs = [
    { label: "100pct", scale: 1.0 },
    { label: "50pct", scale: 0.5 },
    { label: "25pct", scale: 0.25 },
    { label: "150pct-upscale", scale: 1.5 },
  ];

  const results = [];
  for (const spec of variantSpecs) {
    const w = Math.round(origWidth * spec.scale);
    const h = Math.round(origHeight * spec.scale);
    const variantPath = path.join(OUT_DIR, `Bedroom 12-resvariant-${spec.label}.jpg`);
    await sharp(ORIGINAL_PATH).resize(w, h, { fit: "fill" }).jpeg({ quality: 92 }).toFile(variantPath);
    // NOTE: results are reported against the actual original image's pixel
    // frame (origWidth x origHeight) regardless of what size was sent, since
    // coordinates are normalized 0-1 by the model.
    const result = await runVariant(spec.label, variantPath, origWidth, origHeight);
    results.push(result);
  }

  const summaryPath = path.join(REPO_ROOT, "tmp", `resolution_vs_precision_results_${Date.now()}.json`);
  await fs.writeFile(summaryPath, JSON.stringify(results, null, 2));
  console.log("\n=== ALL DONE, summary:", summaryPath, "===");
}

main().catch((e) => {
  console.error("investigate_resolution_vs_precision failed:", e);
  process.exit(1);
});
