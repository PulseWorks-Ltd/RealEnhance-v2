// Diagnosis only: real baseline + wall-visibility extraction on Bedroom 14,
// then reconstruct planBedroomAnchor's selection against the real data to
// see exactly why the far-right (doorway) wall beat the half-height-window
// wall. No generation call, no code changes.
import path from "path";
import { toBase64 } from "../worker/src/utils/images";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { getGeminiClient } from "../worker/src/ai/gemini";

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

Pay particular attention to whether any wall segment that appears to run from one opening (e.g. a
walkthrough doorway or a mounted fixture) all the way to the edge of the frame is actually ONE
continuous wall, or whether it is actually TWO separate walls that were merged because there was no
obvious color change between them.

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
const FOCAL_OPENING_TYPE_PRIORITY = ["window", "door"];
const FRAME_EDGE_EPSILON = 0.03;

function wallBBox(polygon: [number, number][]) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

async function main() {
  const imagePath = path.join(BEDROOM_DIR, "Bedroom 14.jpg");
  console.log("=== Test image path ===", imagePath);

  console.log("\n=== Real baseline extraction call ===");
  const baseline: any = await extractStructuralBaseline(imagePath, { jobId: "diagnose-bedroom14", imageId: "diagnose-bedroom14" });
  console.log(JSON.stringify(baseline, null, 2));

  console.log("\n=== Real wall-visibility extraction call ===");
  const walls = await extractWallVisibility(imagePath, baseline);
  console.log(JSON.stringify(walls, null, 2));

  console.log("\n\n=== Reconstructing planBedroomAnchor selection logic against this real data ===");
  const wallCandidates = walls.map((wall: any) => {
    const largestSegment = (wall.usableSegments || []).reduce((max: number, s: any) => Math.max(max, s.widthFraction), 0);
    return { wall, largestSegment };
  });
  const ranked = [...wallCandidates].sort((a, b) => b.largestSegment - a.largestSegment);
  console.log("\nRanked walls by largestSegment (descending):");
  for (const c of ranked) {
    const bbox = wallBBox(c.wall.extent.polygon);
    const edgeCropped = bbox.minX <= FRAME_EDGE_EPSILON || bbox.maxX >= 1 - FRAME_EDGE_EPSILON;
    console.log(`  ${c.wall.id} (${c.wall.wallLabel}): largestSegment=${c.largestSegment.toFixed(3)}, usableWidthFraction=${c.wall.usableWidthFraction}, openingIds=[${(c.wall.openingIds || []).join(", ")}], edgeCropped=${edgeCropped}, bbox.x=[${bbox.minX.toFixed(3)},${bbox.maxX.toFixed(3)}]`);
  }
  const qualifying = ranked.filter((w) => w.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR);
  console.log(`\nQualifying walls (largestSegment >= ${MIN_USABLE_FRACTION_FOR_ANCHOR}):`, qualifying.map((q) => q.wall.id));
  const selected = qualifying[0];
  console.log("\n=== SELECTED ANCHOR WALL ===", selected ? `${selected.wall.id} (${selected.wall.wallLabel}), largestSegment=${selected.largestSegment.toFixed(3)}` : "NONE — would fall back");

  if (selected) {
    const selectedWallIndex = Number(String(selected.wall.id).replace("wall_", ""));
    console.log("\n=== Focal-feature (orientation) selection against this data ===");
    for (const focalType of FOCAL_OPENING_TYPE_PRIORITY) {
      const candidates = baseline.openings.filter((o: any) => o.type === focalType);
      const offAnchorWall = candidates.filter((o: any) => o.wallIndex !== selectedWallIndex);
      const pick = offAnchorWall[0] || candidates[0];
      console.log(`  focalType=${focalType}: candidates=[${candidates.map((o: any) => o.id).join(", ")}], offAnchorWall=[${offAnchorWall.map((o: any) => o.id).join(", ")}], picked=${pick ? pick.id : "none"}`);
      if (pick) break;
    }
  }

  console.log("\n=== Opening type/schema check: does the schema distinguish half-height vs full-height windows? ===");
  for (const o of baseline.openings) {
    console.log(`  ${o.id}: type=${o.type}, verticalBand=${o.verticalBand}, touchesFloor=${o.touchesFloor}, wallCoverageBand=${o.wallCoverageBand}, bbox=[${o.bbox.map((n: number) => n.toFixed(3)).join(", ")}], area_pct=${o.area_pct}, confidence=${o.confidence}, description=${JSON.stringify(o.description)}`);
  }

  process.exit(0);
}
main().catch((e) => {
  console.error("diagnose_bedroom14_wallselect failed:", e);
  process.exit(1);
});
