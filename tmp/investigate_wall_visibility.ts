// PART 1 (standalone, read-only w.r.t. production code): prototype extension
// to baseline extraction — walls-first schema capturing usable wall space
// after subtracting known openings/fixtures. Does NOT touch
// openingPreservationValidator.ts. Feeds the REAL, already-captured
// extractStructuralBaseline() result for Bedroom 12 (from earlier tonight)
// as context, rather than re-detecting openings from scratch, so wall
// assignments reference the SAME D1/A1/AC1 IDs already established.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const BASELINE_PATH = path.join(OUT_DIR, "Bedroom 12.jpg");

type Point = [number, number];

// Real extractStructuralBaseline() output for Bedroom 12, captured earlier
// tonight via the actual production function (not re-run here) — reused as
// context so wall assignments reference these exact IDs, not new ones.
const KNOWN_BASELINE = {
  openings: [
    { id: "A1", type: "walkthrough", bbox: [0.631, 0.4147, 0.7408, 0.8621], wallIndex: 0, wallPosition: "near_wall", confidence: 0.95 },
    { id: "D1", type: "door", bbox: [0.1906, 0.2429, 0.4831, 0.8653], wallIndex: 3, wallPosition: "left_wall", confidence: 0.98 },
  ],
  anchorFixtures: [
    { id: "AC1", type: "ac_unit", bbox: [0.4906, 0.3402, 0.601, 0.4042], wallIndex: 3, confidence: 0.99 },
  ],
};

const SYSTEM_INSTRUCTION = `You are a structural feature extraction engine, extending an existing analysis with wall-level visibility data.

You are given a room photograph AND an existing structural baseline (openings and fixtures already
detected, with stable IDs). Your task is NOT to re-detect openings — it is to identify the distinct
WALLS visible in the frame and describe how much clear, usable space remains on each wall after
accounting for the already-known openings/fixtures.

For each distinct wall visible in the frame:
- Assign a wall id using the SAME 0-indexed wallIndex convention already used in the baseline
  (wall_0, wall_1, wall_2, wall_3 — a room typically has up to 4 walls indexed this way).
- Give the wall's total visible extent as a polygon (perspective-skewed quadrilateral, following the
  actual visible floor-to-ceiling boundary of that wall, same precision standard as tonight's
  polygon extraction: trace the true visible outline, do not pad to a rectangle).
- List which of the GIVEN opening/fixture IDs (from the baseline below) fall on this wall.
- Estimate usableWidthFraction: the fraction (0-1) of this wall's total width that is clear, usable
  wall space once the openings/fixtures on it are subtracted.
- Describe usableSegments: since usable space may be split into multiple disconnected pieces (e.g. a
  wall with an opening in the middle has usable space on both sides, which is NOT the same as one
  continuous piece of equal total size), list each contiguous usable segment as a horizontal fraction
  range [start, end] (0-1, left to right as visible in frame) along that wall, with a short plain
  description of its position (e.g. "left portion, next to the door" or "full wall, no obstruction").
- Give a confidence value (0-1).

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.

If a wall is barely visible (sliver at frame edge) or its extent is genuinely uncertain, still include
it with a lower confidence value rather than omitting it.`;

function buildUserPrompt(): string {
  return `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(KNOWN_BASELINE, null, 2)}

Analyze this room photograph and return JSON in this exact schema (all coordinates normalized 0-1):
{
  "walls": [
    {
      "id": "wall_0" | "wall_1" | "wall_2" | "wall_3",
      "wallLabel": string,
      "extent": { "polygon": [[x,y], [x,y], ...] },
      "openingIds": string[],
      "usableWidthFraction": number,
      "usableSegments": [
        { "range": [start, end], "widthFraction": number, "description": string }
      ],
      "confidence": number
    }
  ]
}`;
}

function extractJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function denormPolygon(points: Point[], width: number, height: number): string {
  return points.map(([x, y]) => `${Math.round(x * width)},${Math.round(y * height)}`).join(" ");
}

async function runOnce(runLabel: string, width: number, height: number) {
  const image = toBase64(BASELINE_PATH);
  const ai = getGeminiClient();
  const startedAt = Date.now();
  const response = await (ai as any).models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: SYSTEM_INSTRUCTION },
          { text: buildUserPrompt() },
          { inlineData: { mimeType: image.mime, data: image.data } },
        ],
      },
    ],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 3072, responseMimeType: "application/json" },
  });
  const durationMs = Date.now() - startedAt;

  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) {
    console.error(`[${runLabel}] NO TEXT RETURNED`);
    return null;
  }

  let parsed: any;
  try {
    parsed = extractJson(textPart.text);
  } catch (e: any) {
    console.error(`[${runLabel}] JSON PARSE FAILED:`, e.message, "\nraw:", textPart.text.slice(0, 500));
    return null;
  }

  console.log(`\n=== [${runLabel}] result (${durationMs}ms) ===`);
  console.log(JSON.stringify(parsed, null, 2));

  // Render overlay: usable segments in green, opening/fixture-covered portion
  // implicitly shown by the underlying photo (not re-drawn), wall outline in
  // a distinct color per wall for visual wall-boundary sanity-checking.
  const wallOutlineColors = ["rgba(255,0,0,0.15)", "rgba(0,120,255,0.15)", "rgba(255,165,0,0.15)", "rgba(160,0,220,0.15)"];
  const svgParts: string[] = [];
  for (const wall of parsed.walls || []) {
    const wallIdx = Number(String(wall.id).replace("wall_", "")) || 0;
    const outlineColor = wallOutlineColors[wallIdx % wallOutlineColors.length];
    if (wall.extent?.polygon) {
      svgParts.push(`<polygon points="${denormPolygon(wall.extent.polygon, width, height)}" fill="${outlineColor}" stroke="black" stroke-width="2" stroke-dasharray="6,4"/>`);
    }
    // Usable segments rendered as a green band along the wall's own bbox
    // (approximated from the polygon's bounding box for simplicity of overlay).
    if (wall.extent?.polygon && Array.isArray(wall.usableSegments)) {
      const xs = wall.extent.polygon.map((p: Point) => p[0]);
      const ys = wall.extent.polygon.map((p: Point) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      for (const seg of wall.usableSegments) {
        const [segStart, segEnd] = seg.range || [0, 0];
        const segMinX = minX + (maxX - minX) * segStart;
        const segMaxX = minX + (maxX - minX) * segEnd;
        svgParts.push(
          `<rect x="${Math.round(segMinX * width)}" y="${Math.round(minY * height)}" width="${Math.round((segMaxX - segMinX) * width)}" height="${Math.round((maxY - minY) * height)}" fill="rgba(30,220,60,0.35)"/>`
        );
      }
    }
  }
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgParts.join("\n")}</svg>`;
  const overlayLayer = await sharp(Buffer.from(svg)).png().toBuffer();
  const overlayBuffer = await sharp(BASELINE_PATH).composite([{ input: overlayLayer, blend: "over" }]).png().toBuffer();
  const overlayPath = path.join(OUT_DIR, `Bedroom 12-wallvis-${runLabel}-overlay.png`);
  await sharp(overlayBuffer).toFile(overlayPath);

  return { runLabel, durationMs, overlayPath, parsed };
}

async function main() {
  const meta = await sharp(BASELINE_PATH).metadata();
  const width = meta.width!, height = meta.height!;
  console.log("=== wall-visibility extraction (Part 1) starting ===", { width, height });

  const run1 = await runOnce("run1", width, height);
  const run2 = await runOnce("run2", width, height);

  const summaryPath = path.join(REPO_ROOT, "tmp", `wall_visibility_results_${Date.now()}.json`);
  await fs.writeFile(summaryPath, JSON.stringify({ run1, run2 }, null, 2));
  console.log("\n=== ALL DONE, summary:", summaryPath, "===");
}

main().catch((e) => {
  console.error("investigate_wall_visibility failed:", e);
  process.exit(1);
});
