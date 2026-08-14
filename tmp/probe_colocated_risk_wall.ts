// Probe for a real anchor-wall selection that actually creates co-location
// risk: a wall with an opening/fixture on it that STILL qualifies as an
// anchor wall (largest clear segment >= 0.35) because the feature doesn't
// consume the whole wall, AND is not edge-cropped (edge-cropped walls
// already get blanket decor protection from a different mechanism,
// 4c5b1c27's noDecorAboveBedNote — that would confound a clean test of
// THIS specific fix). Runs baseline+wall-visibility only (no generation)
// repeatedly against Bedroom 11 / Bedroom 14 until a qualifying case is
// found, then saves that exact snapshot for a controlled before/after
// generation comparison.
import fs from "fs/promises";
import path from "path";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const WALL_VISIBILITY_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

const WALL_VISIBILITY_SYSTEM_INSTRUCTION = `You are a structural feature extraction engine, extending an existing analysis with wall-level visibility data.

You are given a room photograph AND an existing structural baseline (openings and fixtures already
detected, with stable IDs).

CRITICAL FIRST STEP — before describing any walls, first explicitly determine: how many distinct flat
wall planes are actually visible in this photograph? A new wall plane is indicated by a genuine visible
boundary — a corner where two surfaces meet at an angle, a change in the ceiling cornice line's slope, a
change in the skirting/baseboard line's direction, or a shadow/seam line — NOT merely by whether two
wall segments look similar in color or texture (most interior walls in a room are painted the same
color, so similarity in appearance is not evidence they are the same wall).

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
- Give a confidence value (0-1) for this wall's existence as a distinct wall.

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.`;

function buildWallVisibilityUserPrompt(baseline: any): string {
  return `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(baseline, null, 2)}

First, internally determine how many distinct walls are visible. Then analyze this room photograph
and return JSON in this exact schema (all coordinates normalized 0-1):
{
  "wallCount": number,
  "wallCountReasoning": string,
  "walls": [
    { "id": "wall_0" | "wall_1" | "wall_2" | "wall_3", "wallLabel": string, "extent": { "polygon": [[x,y], [x,y], ...] }, "openingIds": string[], "usableWidthFraction": number, "usableSegments": [{ "range": [start, end], "widthFraction": number, "description": string }], "confidence": number }
  ]
}`;
}

function extractJsonFromModelText(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function extractWallVisibility(imagePath: string, baseline: any): Promise<any[]> {
  const image = toBase64(imagePath);
  const ai = getGeminiClient();
  const response: any = await (ai as any).models.generateContent({
    model: WALL_VISIBILITY_MODEL,
    contents: [{ role: "user", parts: [{ text: WALL_VISIBILITY_SYSTEM_INSTRUCTION }, { text: buildWallVisibilityUserPrompt(baseline) }, { inlineData: { mimeType: image.mime, data: image.data } }] }],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 3072, responseMimeType: "application/json" },
  });
  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error("NO TEXT RETURNED (wall visibility)");
  return extractJsonFromModelText(textPart.text).walls;
}

const MIN_USABLE_FRACTION_FOR_ANCHOR = 0.35;
const FRAME_EDGE_EPSILON = 0.03;

function polygonBBoxX(polygon: [number, number][]) {
  const xs = polygon.map((p) => p[0]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs) };
}

function analyzeForRisk(baseline: any, walls: any[]) {
  const results: any[] = [];
  for (const wall of walls) {
    const largestSegment = (wall.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0);
    if (largestSegment < MIN_USABLE_FRACTION_FOR_ANCHOR) {
      results.push({ wallId: wall.id, qualifies: false, reason: `largestSegment ${largestSegment.toFixed(3)} < ${MIN_USABLE_FRACTION_FOR_ANCHOR}` });
      continue;
    }
    const wallIndex = Number(String(wall.id).replace("wall_", ""));
    const { minX, maxX } = polygonBBoxX(wall.extent.polygon);
    const edgeCropped = minX <= FRAME_EDGE_EPSILON || maxX >= 1 - FRAME_EDGE_EPSILON;
    const coLocated = [
      ...baseline.openings.filter((o: any) => o.wallIndex === wallIndex),
      ...(baseline.anchorFixtures || []).filter((f: any) => f.wallIndex === wallIndex),
    ];
    results.push({
      wallId: wall.id,
      qualifies: true,
      largestSegment,
      edgeCropped,
      coLocatedItems: coLocated.map((i: any) => `${i.id} (${i.description || i.type})`),
      RISK_CONDITION: coLocated.length > 0 && !edgeCropped,
    });
  }
  return results;
}

async function probe(label: string, imgFile: string, maxAttempts: number) {
  const imagePath = path.join(BEDROOM_DIR, imgFile);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n=== ${label} probe attempt ${attempt}/${maxAttempts} ===`);
    const baseline: any = await extractStructuralBaseline(imagePath, { jobId: `probe-${label}-${attempt}`, imageId: `probe-${label}-${attempt}` });
    const walls = await extractWallVisibility(imagePath, baseline);
    const analysis = analyzeForRisk(baseline, walls);
    console.log(JSON.stringify(analysis, null, 2));
    const riskyQualifying = analysis.filter((a) => a.qualifies && a.RISK_CONDITION);
    if (riskyQualifying.length > 0) {
      console.log(`\n!!! RISK CONDITION FOUND on attempt ${attempt}: ${JSON.stringify(riskyQualifying)} !!!`);
      const outPath = path.join(REPO_ROOT, `tmp/colocated_risk_snapshot_${label}.json`);
      await fs.writeFile(outPath, JSON.stringify({ baseline, walls, analysis, attempt }, null, 2));
      console.log("Saved snapshot:", outPath);
      return { baseline, walls, analysis, attempt };
    }
  }
  console.log(`\n${label}: no risk condition found in ${maxAttempts} attempts.`);
  return null;
}

async function main() {
  const bedroom11Result = await probe("bedroom11", "Bedroom 11.jpg", 4);
  const bedroom14Result = bedroom11Result ? null : await probe("bedroom14", "Bedroom 14.jpg", 4);
  console.log("\n\n=== SUMMARY ===");
  console.log("Bedroom 11 found risk condition:", !!bedroom11Result);
  console.log("Bedroom 14 found risk condition:", !!bedroom14Result);
  process.exit(0);
}
main().catch((e) => {
  console.error("probe_colocated_risk_wall failed:", e);
  process.exit(1);
});
