// TEMPORARY, standalone experiment (Test 3) — does not modify
// worker/src/validators/openingPreservationValidator.ts or any committed
// provider code. Question: does asking for a POLYGON outline (still JSON
// text output, same proven gemini-2.5-pro mechanism as Test 1) instead of a
// 4-corner bbox produce a meaningfully tighter protected region for
// perspective-skewed doorways? Test 1's bboxes were confirmed to over-protect
// (interior doorway bbox spanned 48% of frame height, sliding-door bbox ate a
// wide strip of adjacent floor) — this test finds out whether a polygon fixes
// that, or whether the imprecision persists in a different shape.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

type Bbox = [number, number, number, number];
type Point = [number, number];

const SYSTEM_INSTRUCTION = `You are a structural feature extraction engine.

You must analyze a single interior room image and decompose it into categorized regions.

Permanent openings include: windows, doors, closet doors, archways, built-in fixed openings.
Fixtures include: AC units, fireplaces, built-in cabinets, kitchen islands, staircases, and
other permanent built-in features.
Floor regions are the visible floor/carpet surface, excluding furniture sitting on it.
Blank wall regions are contiguous wall surface not occupied by an opening, fixture, or
wall-mounted object.

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
protecting). If uncertain whether an area is genuinely open floor or blank wall, exclude it
(bias toward not guessing).`;

const USER_PROMPT = `Analyze this room image and decompose it into regions.

Return JSON in this exact schema (all coordinates normalized 0-1):

{
  "openings": [
    { "id": string, "type": "window"|"door"|"closet_door"|"walkthrough",
      "polygon": [[x,y], [x,y], ...], "confidence": number }
  ],
  "anchorFixtures": [
    { "id": string, "type": "ac_unit"|"fireplace"|"built_in_cabinet"|"kitchen_island"|"staircase"|"other",
      "polygon": [[x,y], [x,y], ...], "confidence": number }
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

function denormBbox(bbox: Bbox, width: number, height: number) {
  const [x1, y1, x2, y2] = bbox;
  return {
    left: Math.max(0, Math.min(width - 1, Math.round(x1 * width))),
    top: Math.max(0, Math.min(height - 1, Math.round(y1 * height))),
    right: Math.max(0, Math.min(width, Math.round(x2 * width))),
    bottom: Math.max(0, Math.min(height, Math.round(y2 * height))),
  };
}

function denormPolygon(points: Point[], width: number, height: number): string {
  return points
    .map(([x, y]) => `${Math.round(x * width)},${Math.round(y * height)}`)
    .join(" ");
}

function polygonPixelArea(points: Point[], width: number, height: number): number {
  // Shoelace formula in pixel space
  const px = points.map(([x, y]) => [x * width, y * height]);
  let area = 0;
  for (let i = 0; i < px.length; i += 1) {
    const [x1, y1] = px[i];
    const [x2, y2] = px[(i + 1) % px.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

function bboxPixelArea(bbox: Bbox, width: number, height: number): number {
  const { left, top, right, bottom } = denormBbox(bbox, width, height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const originalPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");
  const meta = await sharp(originalPath).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  console.log("=== polygon region extraction test starting ===", { width, height });

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
    console.error("NO TEXT RETURNED", { durationMs });
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

  // Base mask: white for floor/blank-wall bboxes (same as Test 1), then punch
  // black holes for opening/fixture POLYGONS via a rasterized SVG, so
  // exclusions still always win regardless of overlap.
  const maskRaw = Buffer.alloc(width * height, 0);
  const fillBboxWhite = (bbox: Bbox) => {
    const { left, top, right, bottom } = denormBbox(bbox, width, height);
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        maskRaw[y * width + x] = 255;
      }
    }
  };
  for (const r of floorRegions) if (r.bbox) fillBboxWhite(r.bbox);
  for (const r of blankWallRegions) if (r.bbox) fillBboxWhite(r.bbox);

  const exclusionPolygons = [...openings, ...anchorFixtures].filter((r) => Array.isArray(r.polygon) && r.polygon.length >= 3);
  const svgPolygons = exclusionPolygons
    .map((r) => `<polygon points="${denormPolygon(r.polygon, width, height)}" fill="white"/>`)
    .join("\n");
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="black"/>${svgPolygons}</svg>`;
  const exclusionRaster = await sharp(Buffer.from(svg))
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .grayscale()
    .raw()
    .toBuffer();
  for (let i = 0; i < maskRaw.length; i += 1) {
    if ((exclusionRaster[i] ?? 0) > 127) maskRaw[i] = 0;
  }

  const maskPngBuffer = await sharp(maskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const maskPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-polygon-test-mask.png");
  await fs.writeFile(maskPath, maskPngBuffer);

  // Overlay: green = editable, red = protected polygon (openings), orange = protected polygon (fixtures)
  const overlaySvgParts: string[] = [];
  for (const r of floorRegions) if (r.bbox) {
    const { left, top, right, bottom } = denormBbox(r.bbox, width, height);
    overlaySvgParts.push(`<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" fill="rgba(40,200,60,0.45)"/>`);
  }
  for (const r of blankWallRegions) if (r.bbox) {
    const { left, top, right, bottom } = denormBbox(r.bbox, width, height);
    overlaySvgParts.push(`<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" fill="rgba(40,200,60,0.45)"/>`);
  }
  for (const r of openings) if (r.polygon) {
    overlaySvgParts.push(`<polygon points="${denormPolygon(r.polygon, width, height)}" fill="rgba(220,30,30,0.55)"/>`);
  }
  for (const r of anchorFixtures) if (r.polygon) {
    overlaySvgParts.push(`<polygon points="${denormPolygon(r.polygon, width, height)}" fill="rgba(220,140,20,0.55)"/>`);
  }
  const overlaySvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${overlaySvgParts.join("\n")}</svg>`;
  const overlayLayer = await sharp(Buffer.from(overlaySvg)).resize(width, height, { fit: "fill" }).png().toBuffer();
  const overlayBuffer = await sharp(originalPath)
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .composite([{ input: overlayLayer, blend: "over" }])
    .png()
    .toBuffer();
  const overlayPath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12-polygon-test-overlay.png");
  await fs.writeFile(overlayPath, overlayBuffer);

  // Quantitative comparison vs. Test 1's bbox areas for the same two openings
  // (matched by type, in extraction order) — best-effort area comparison.
  const polygonAreas = exclusionPolygons.map((r) => ({
    id: r.id, type: r.type, pixelArea: Math.round(polygonPixelArea(r.polygon, width, height)),
  }));

  let whiteCount = 0;
  for (const v of maskRaw) if (v > 0) whiteCount += 1;

  console.log("\n=== RESULTS ===");
  console.log(JSON.stringify({
    durationMs,
    modelUsed: MODEL,
    maskPath,
    overlayPath,
    whitePixelRatio: whiteCount / (width * height),
    polygonAreas,
    openings,
    anchorFixtures,
    floorRegions,
    blankWallRegions,
  }, null, 2));
}

main().catch((e) => {
  console.error("test_gemini_polygon_regions failed:", e);
  process.exit(1);
});
