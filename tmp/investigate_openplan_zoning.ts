// Open-plan living/dining zoning + multi-anchor prototype (investigation
// phase, standalone — see tmp/openplan_zoning_design.md for the design this
// implements). Real Gemini calls for wall-visibility + a NEW zoning
// extraction; NO image generation. Test image: Rental 03.jpg.
//
// Pipeline: real baseline (already captured, hardcoded below) -> real
// wall-visibility extraction (system instruction copied verbatim from
// worker/src/pipeline/anchorLockedStaging.ts, since that function isn't
// exported and this task must not touch production code) -> NEW real zoning
// extraction (design doc's schema) -> client-side zone/wall cross-reference
// -> simple rule-based multi-anchor placement (dining table centered in its
// zone; TV wall picked first in the living zone, sofa oriented to face it)
// -> overlay render for visual QA before any generation call is considered.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const IMAGE_PATH = path.join(OUT_DIR, "Rental 03.jpg");

type Point = [number, number];

// Real extractStructuralBaseline() output for Rental 03.jpg, captured this
// task (tmp/check_rental03_baseline.log) — reused verbatim, not re-run.
const KNOWN_BASELINE = {
  room_type: "living_dining",
  openings: [
    { id: "A1", type: "walkthrough", bbox: [0.585, 0.101, 1, 0.888], wallIndex: 0, confidence: 0.9 },
    { id: "W2", type: "window", bbox: [0.627, 0.377, 0.865, 0.518], wallIndex: 0, confidence: 0.85 },
    { id: "W3", type: "window", bbox: [0.933, 0.444, 0.999, 0.729], wallIndex: 1, confidence: 0.75 },
    { id: "W1", type: "window", bbox: [0.137, 0.163, 0.583, 0.615], wallIndex: 3, confidence: 0.95 },
  ],
  anchorFixtures: [
    { id: "F2", type: "light_fixture", wallIndex: 0, confidence: 0.9 },
    { id: "F3", type: "light_fixture", wallIndex: 0, confidence: 0.9 },
    { id: "F1", type: "ac_unit", wallIndex: 3, confidence: 0.95 },
  ],
};

function extractJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}
function denormPolygon(points: Point[], width: number, height: number): string {
  return points.map(([x, y]) => `${Math.round(x * width)},${Math.round(y * height)}`).join(" ");
}

// ── Wall-visibility extraction — system instruction copied verbatim from
// worker/src/pipeline/anchorLockedStaging.ts (not exported, and this task
// must not touch production code). ──
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

function buildWallVisibilityUserPrompt(): string {
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

// ── NEW: zoning extraction — per tmp/openplan_zoning_design.md. ──
const ZONING_SYSTEM_INSTRUCTION = `You are a structural feature extraction engine, extending an existing analysis to identify functional zones within an open-plan living/dining room.

You are given a room photograph AND an existing structural baseline (openings and fixtures already detected, with stable IDs).

This room combines two functions: a LIVING zone (seating area) and a DINING zone (table + chairs area). Identify how the visible floor space divides into these two zones, based on genuine visual cues — a change in flooring material, a change in ceiling treatment, existing furniture grouping (the room may already be furnished in this photo; use furniture position only as a cue for how the space is naturally used, not as a placement instruction to preserve), sightlines, and traffic flow. Do not assume an even 50/50 split — the split should reflect the actual visible geometry and cues in this photo, and the two zones' floor regions should not overlap.

Additionally, determine whether any of the given openings appears to lead toward or provide a sightline into a KITCHEN — look for cues such as visible countertops, cabinetry, appliances, a kitchen island, pendant/track lighting typical of kitchens, or distinct kitchen-style flooring/splashback visible through or beyond the opening. This is inference from visible cues, not a labeled fact in the baseline — report your confidence honestly, and report present:false if no such cue exists anywhere in the photo.

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.`;

function buildZoningUserPrompt(): string {
  return `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(KNOWN_BASELINE, null, 2)}

Analyze this room photograph and return JSON in this exact schema (all coordinates normalized 0-1):
{
  "zones": [
    {
      "id": "zone_living" | "zone_dining",
      "purpose": "living" | "dining",
      "floorRegion": { "polygon": [[x,y], [x,y], ...] },
      "borderingWallIndices": number[],
      "reasoning": string
    }
  ],
  "kitchenSignal": {
    "present": boolean,
    "openingId": string | null,
    "confidence": number,
    "evidence": string
  }
}`;
}

async function callGemini(system: string, user: string, image: { mime: string; data: string }) {
  const ai = getGeminiClient();
  const response: any = await (ai as any).models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: system }, { text: user }, { inlineData: { mimeType: image.mime, data: image.data } }] }],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 3072, responseMimeType: "application/json" },
  });
  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error("NO TEXT RETURNED");
  return extractJson(textPart.text);
}

// ── Simple multi-anchor placement rules (design doc Part "Multi-anchor coherence") ──
const MIN_USABLE_FRACTION_FOR_ANCHOR = 0.35;

function polygonBBox(polygon: Point[]) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function polygonCentroid(polygon: Point[]): Point {
  const n = polygon.length;
  const sx = polygon.reduce((s, p) => s + p[0], 0);
  const sy = polygon.reduce((s, p) => s + p[1], 0);
  return [sx / n, sy / n];
}

async function main() {
  const meta = await sharp(IMAGE_PATH).metadata();
  const width = meta.width!, height = meta.height!;
  const image = toBase64(IMAGE_PATH);

  console.log("=== 1) Wall-visibility extraction ===");
  const wallVis = await callGemini(WALL_VISIBILITY_SYSTEM_INSTRUCTION, buildWallVisibilityUserPrompt(), image);
  console.log(JSON.stringify(wallVis, null, 2));

  console.log("\n=== 2) Zoning extraction (NEW) ===");
  const zoning = await callGemini(ZONING_SYSTEM_INSTRUCTION, buildZoningUserPrompt(), image);
  console.log(JSON.stringify(zoning, null, 2));

  const walls: any[] = wallVis.walls || [];
  const zones: any[] = zoning.zones || [];
  const livingZone = zones.find((z) => z.purpose === "living");
  const diningZone = zones.find((z) => z.purpose === "dining");

  console.log("\n=== 3) Multi-anchor planning ===");
  const reasoning: string[] = [];

  // Dining table: centered within the dining zone's floor region.
  let diningPlan: any = null;
  if (diningZone?.floorRegion?.polygon?.length >= 3) {
    const centroid = polygonCentroid(diningZone.floorRegion.polygon);
    const bbox = polygonBBox(diningZone.floorRegion.polygon);
    diningPlan = {
      center: centroid,
      footprint: {
        // simple inset rectangle around the centroid, capped to a plausible table size relative to the zone
        halfWidth: Math.min(0.12, (bbox.maxX - bbox.minX) * 0.35),
        halfHeight: Math.min(0.08, (bbox.maxY - bbox.minY) * 0.3),
      },
      borderingWallIndices: diningZone.borderingWallIndices,
      reasoning: `Table centered within zone_dining's floor region (centroid [${centroid[0].toFixed(3)}, ${centroid[1].toFixed(3)}]), inset from bordering walls for chair clearance.`,
    };
    reasoning.push(diningPlan.reasoning);
  } else {
    reasoning.push("No dining zone floor region returned — dining anchor plan skipped.");
  }

  // Living zone: pick TV wall first (largest qualifying usable segment among
  // walls bordering the living zone), then orient sofa to face it.
  let tvPlan: any = null;
  let sofaPlan: any = null;
  if (livingZone) {
    const livingWallIndices = new Set<number>(livingZone.borderingWallIndices || []);
    const livingWalls = walls.filter((w) => livingWallIndices.has(Number(String(w.id).replace("wall_", ""))));
    const candidates = livingWalls
      .map((w) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
      .sort((a, b) => b.largestSegment - a.largestSegment);
    const tvCandidate = candidates.find((c) => c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR) || candidates[0] || null;

    if (tvCandidate) {
      const seg = [...(tvCandidate.wall.usableSegments || [])].sort((a: any, b: any) => b.widthFraction - a.widthFraction)[0];
      tvPlan = {
        wallId: tvCandidate.wall.id,
        wallLabel: tvCandidate.wall.wallLabel,
        segmentDescription: seg?.description,
        largestSegment: tvCandidate.largestSegment,
        reasoning: `TV wall selected first (living-zone walls only): ${tvCandidate.wall.id} has the largest qualifying usable segment (${tvCandidate.largestSegment.toFixed(3)}).`,
      };
      reasoning.push(tvPlan.reasoning);

      // Sofa: pick the next-best living-zone wall (different from TV wall) to
      // face the TV wall. If only one living-zone wall qualifies, sofa is
      // placed floor-centered in the zone, facing the TV wall directly
      // (no second wall available to anchor it to).
      const sofaCandidate = candidates.find((c) => c.wall.id !== tvCandidate.wall.id && c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR);
      if (sofaCandidate) {
        sofaPlan = {
          wallId: sofaCandidate.wall.id,
          wallLabel: sofaCandidate.wall.wallLabel,
          facingWallId: tvCandidate.wall.id,
          reasoning: `Sofa placed against ${sofaCandidate.wall.id} (a different living-zone wall from the TV), oriented to face ${tvCandidate.wall.id} directly — this is the explicit sofa-TV coherence link, not two independent placements.`,
        };
      } else {
        sofaPlan = {
          wallId: null,
          floorCentered: true,
          facingWallId: tvCandidate.wall.id,
          reasoning: `Only one living-zone wall qualified (the TV wall itself), so the sofa is floor-centered within the living zone rather than wall-anchored, still explicitly oriented to face ${tvCandidate.wall.id}.`,
        };
      }
      reasoning.push(sofaPlan.reasoning);
    } else {
      reasoning.push("No living-zone wall data available — TV/sofa plan skipped.");
    }
  } else {
    reasoning.push("No living zone returned by zoning extraction — TV/sofa plan skipped.");
  }

  const plan = {
    kitchenSignal: zoning.kitchenSignal,
    zones: zones.map((z) => ({ id: z.id, purpose: z.purpose, borderingWallIndices: z.borderingWallIndices, reasoning: z.reasoning })),
    diningPlan,
    tvPlan,
    sofaPlan,
    reasoning,
  };
  console.log(JSON.stringify(plan, null, 2));

  // ── Overlay render ──
  const svgParts: string[] = [];
  const zoneColors: Record<string, string> = { living: "rgba(0,120,255,0.25)", dining: "rgba(255,140,0,0.25)" };
  for (const z of zones) {
    if (!z.floorRegion?.polygon) continue;
    svgParts.push(`<polygon points="${denormPolygon(z.floorRegion.polygon, width, height)}" fill="${zoneColors[z.purpose] || "rgba(150,150,150,0.25)"}" stroke="black" stroke-width="3" stroke-dasharray="10,6"/>`);
    const c = polygonCentroid(z.floorRegion.polygon);
    svgParts.push(`<text x="${Math.round(c[0] * width)}" y="${Math.round(c[1] * height)}" font-size="30" font-weight="bold" fill="black" text-anchor="middle">${z.id}</text>`);
  }
  // Kitchen signal opening highlight
  if (zoning.kitchenSignal?.present && zoning.kitchenSignal.openingId) {
    const opening = KNOWN_BASELINE.openings.find((o) => o.id === zoning.kitchenSignal.openingId);
    if (opening) {
      const [x1, y1, x2, y2] = opening.bbox;
      svgParts.push(`<rect x="${x1 * width}" y="${y1 * height}" width="${(x2 - x1) * width}" height="${(y2 - y1) * height}" fill="none" stroke="red" stroke-width="6"/>`);
      svgParts.push(`<text x="${((x1 + x2) / 2) * width}" y="${y1 * height - 12}" font-size="26" font-weight="bold" fill="red" text-anchor="middle">KITCHEN SIGNAL (${opening.id}, conf ${zoning.kitchenSignal.confidence})</text>`);
    }
  }
  // Dining table footprint
  if (diningPlan) {
    const [cx, cy] = diningPlan.center;
    const { halfWidth, halfHeight } = diningPlan.footprint;
    svgParts.push(`<rect x="${(cx - halfWidth) * width}" y="${(cy - halfHeight) * height}" width="${halfWidth * 2 * width}" height="${halfHeight * 2 * height}" fill="rgba(139,69,19,0.6)" stroke="black" stroke-width="3"/>`);
    svgParts.push(`<text x="${cx * width}" y="${cy * height}" font-size="24" font-weight="bold" fill="white" text-anchor="middle">DINING TABLE</text>`);
  }
  // TV + sofa markers on their walls (approximate using wall polygon bbox + segment range)
  function segmentToFrameX(wall: any, seg: any): { x1: number; x2: number; minY: number; maxY: number } {
    const bbox = polygonBBox(wall.extent.polygon);
    const x1 = bbox.minX + (bbox.maxX - bbox.minX) * seg.range[0];
    const x2 = bbox.minX + (bbox.maxX - bbox.minX) * seg.range[1];
    return { x1, x2, minY: bbox.minY, maxY: bbox.maxY };
  }
  if (tvPlan) {
    const wall = walls.find((w) => w.id === tvPlan.wallId);
    const seg = wall?.usableSegments?.find((s: any) => s.description === tvPlan.segmentDescription) || wall?.usableSegments?.[0];
    if (wall && seg) {
      const { x1, x2, maxY } = segmentToFrameX(wall, seg);
      const tvY1 = maxY - (maxY) * 0.35, tvY2 = maxY - (maxY) * 0.15;
      svgParts.push(`<rect x="${x1 * width}" y="${tvY1 * height}" width="${(x2 - x1) * width}" height="${(tvY2 - tvY1) * height}" fill="rgba(0,0,0,0.7)" stroke="lime" stroke-width="3"/>`);
      svgParts.push(`<text x="${((x1 + x2) / 2) * width}" y="${((tvY1 + tvY2) / 2) * height}" font-size="22" font-weight="bold" fill="lime" text-anchor="middle">TV</text>`);
    }
  }
  if (sofaPlan && sofaPlan.wallId) {
    const wall = walls.find((w) => w.id === sofaPlan.wallId);
    const seg = wall?.usableSegments?.[0];
    if (wall && seg) {
      const { x1, x2, maxY } = segmentToFrameX(wall, seg);
      const sofaY1 = maxY - maxY * 0.3, sofaY2 = maxY;
      svgParts.push(`<rect x="${x1 * width}" y="${sofaY1 * height}" width="${(x2 - x1) * width}" height="${(sofaY2 - sofaY1) * height}" fill="rgba(80,40,150,0.6)" stroke="black" stroke-width="3"/>`);
      svgParts.push(`<text x="${((x1 + x2) / 2) * width}" y="${((sofaY1 + sofaY2) / 2) * height}" font-size="22" font-weight="bold" fill="white" text-anchor="middle">SOFA</text>`);
    }
  } else if (sofaPlan?.floorCentered && livingZone) {
    const c = polygonCentroid(livingZone.floorRegion.polygon);
    svgParts.push(`<rect x="${(c[0] - 0.1) * width}" y="${(c[1] - 0.05) * height}" width="${0.2 * width}" height="${0.1 * height}" fill="rgba(80,40,150,0.6)" stroke="black" stroke-width="3"/>`);
    svgParts.push(`<text x="${c[0] * width}" y="${c[1] * height}" font-size="22" font-weight="bold" fill="white" text-anchor="middle">SOFA (floor-centered)</text>`);
  }

  const overlayLayer = await sharp(Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgParts.join("\n")}</svg>`)).png().toBuffer();
  const overlayBuffer = await sharp(IMAGE_PATH).composite([{ input: overlayLayer, blend: "over" }]).png().toBuffer();
  const overlayPath = path.join(OUT_DIR, "Rental 03-openplan-zoning-overlay.png");
  await sharp(overlayBuffer).toFile(overlayPath);
  console.log("\noverlay saved:", overlayPath);

  const outPath = path.join(REPO_ROOT, "tmp", `openplan_zoning_${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify({ wallVis, zoning, plan }, null, 2));
  console.log("=== SAVED:", outPath, "===");
}

main().catch((e) => {
  console.error("investigate_openplan_zoning failed:", e);
  process.exit(1);
});
