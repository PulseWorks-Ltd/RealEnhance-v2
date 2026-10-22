// PART 1 RE-TEST (standalone, read-only w.r.t. production code): checks
// whether tonight's original 2-wall extraction merged two visually distinct
// walls into one. Explicitly asks the extractor to COUNT distinct walls
// first (looking for corners/seams/perspective-angle changes as the actual
// test for a wall boundary, not just texture/color similarity) before
// describing them — deliberately does NOT hard-code "there's a blank third
// wall" as a leading answer, only describes wall categories in general terms
// per the task's instruction.
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
detected, with stable IDs).

CRITICAL FIRST STEP — a previous analysis of a similar task may have UNDER-COUNTED the number of
distinct walls in a room by merging two visually different wall segments into one when it should not
have. Before describing any walls, first explicitly determine: how many distinct flat wall planes are
actually visible in this photograph? A new wall plane is indicated by a genuine visible boundary —
a corner where two surfaces meet at an angle, a change in the ceiling cornice line's slope, a change
in the skirting/baseboard line's direction, or a shadow/seam line — NOT merely by whether two wall
segments look similar in color or texture (most interior walls in a room are painted the same color,
so similarity in appearance is not evidence they are the same wall).

Pay particular attention to whether any wall segment that appears to run from one opening (e.g. a
walkthrough doorway or a mounted fixture) all the way to the edge of the frame is actually ONE
continuous wall, or whether it is actually TWO separate walls that were merged because there was no
obvious color change between them. Look specifically for a corner or ceiling-line angle change
somewhere along that span.

Wall categories you may find (this is not necessarily an exhaustive or exact list — determine the
actual count from the photograph itself):
- A wall containing a sliding or glass door
- A wall containing a walkthrough opening and/or a wall-mounted fixture
- Any additional wall segment(s) with different content or no content at all

For each distinct wall you identify:
- Assign a wall id using the SAME 0-indexed wallIndex convention already used in the baseline
  (wall_0, wall_1, wall_2, wall_3).
- Give the wall's total visible extent as a polygon (perspective-skewed quadrilateral, following the
  actual visible floor-to-ceiling boundary of that wall).
- List which of the GIVEN opening/fixture IDs (from the baseline below) fall on this wall, if any.
- Estimate usableWidthFraction: the fraction (0-1) of this wall's total width that is clear, usable
  wall space once the openings/fixtures on it are subtracted.
- Describe usableSegments as horizontal fraction ranges [start, end] along that wall, each with a
  short plain description.
- Give a confidence value (0-1) for this wall's existence as a distinct wall (not just for its extent).

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.`;

function buildUserPrompt(): string {
  return `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(KNOWN_BASELINE, null, 2)}

First, internally determine how many distinct walls are visible. Then analyze this room photograph
and return JSON in this exact schema (all coordinates normalized 0-1):
{
  "wallCount": number,
  "wallCountReasoning": string,
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
      { role: "user", parts: [{ text: SYSTEM_INSTRUCTION }, { text: buildUserPrompt() }, { inlineData: { mimeType: image.mime, data: image.data } }] },
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
    console.error(`[${runLabel}] JSON PARSE FAILED:`, e.message, "\nraw:", textPart.text.slice(0, 800));
    return null;
  }

  console.log(`\n=== [${runLabel}] result (${durationMs}ms) ===`);
  console.log(JSON.stringify(parsed, null, 2));

  const wallColors = ["rgba(255,0,0,0.3)", "rgba(0,150,255,0.3)", "rgba(0,200,80,0.3)", "rgba(255,165,0,0.3)", "rgba(160,0,220,0.3)"];
  const segmentColor = "rgba(30,220,60,0.4)";
  const svgParts: string[] = [];
  for (const wall of parsed.walls || []) {
    const wallIdx = Number(String(wall.id).replace("wall_", "")) || 0;
    const outlineColor = wallColors[wallIdx % wallColors.length];
    if (wall.extent?.polygon) {
      svgParts.push(`<polygon points="${denormPolygon(wall.extent.polygon, width, height)}" fill="${outlineColor}" stroke="black" stroke-width="3"/>`);
      const xs = wall.extent.polygon.map((p: Point) => p[0]);
      const ys = wall.extent.polygon.map((p: Point) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const labelX = Math.round(((minX + maxX) / 2) * width);
      const labelY = Math.round(minY * height) + 30;
      svgParts.push(`<text x="${labelX}" y="${labelY}" font-size="28" font-weight="bold" fill="black" text-anchor="middle">${wall.id}</text>`);
      for (const seg of wall.usableSegments || []) {
        const [segStart, segEnd] = seg.range || [0, 0];
        const segMinX = minX + (maxX - minX) * segStart;
        const segMaxX = minX + (maxX - minX) * segEnd;
        svgParts.push(`<rect x="${Math.round(segMinX * width)}" y="${Math.round(minY * height)}" width="${Math.round((segMaxX - segMinX) * width)}" height="${Math.round((maxY - minY) * height)}" fill="${segmentColor}"/>`);
      }
    }
  }
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgParts.join("\n")}</svg>`;
  const overlayLayer = await sharp(Buffer.from(svg)).png().toBuffer();
  const overlayBuffer = await sharp(BASELINE_PATH).composite([{ input: overlayLayer, blend: "over" }]).png().toBuffer();
  const overlayPath = path.join(OUT_DIR, `Bedroom 12-wallvis-v2-${runLabel}-overlay.png`);
  await sharp(overlayBuffer).toFile(overlayPath);

  return { runLabel, durationMs, overlayPath, parsed };
}

async function main() {
  const meta = await sharp(BASELINE_PATH).metadata();
  const width = meta.width!, height = meta.height!;
  console.log("=== wall-visibility RE-TEST (v2, 3-wall check) starting ===", { width, height });

  const run1 = await runOnce("run1", width, height);
  const run2 = await runOnce("run2", width, height);

  const summaryPath = path.join(REPO_ROOT, "tmp", `wall_visibility_v2_results_${Date.now()}.json`);
  await fs.writeFile(summaryPath, JSON.stringify({ run1, run2 }, null, 2));
  console.log("\n=== ALL DONE, summary:", summaryPath, "===");
}

main().catch((e) => {
  console.error("investigate_wall_visibility_v2 failed:", e);
  process.exit(1);
});
