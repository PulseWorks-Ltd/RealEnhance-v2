// Part 2 (validation task): wall-visibility extraction + deterministic
// planner for the kitchen/living room, reusing the exact proven methodology
// from tonight (same wall-visibility prompt style as
// investigate_wall_visibility.ts, same planner logic as
// build_deterministic_layout_plan_v3.ts with orientation + framing rules)
// — unmodified, just pointed at a new room and a new real baseline.
// Single run (not a repeat-run consistency pair) since Part 2 doesn't
// require that check — only Part 1 (Bedroom 12) does.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import type { Stage2LayoutPlan, AnchorItem, AnchorOrientation } from "../worker/src/pipeline/layoutPlanner";
import type { StructuralOpeningType } from "../worker/src/validators/openingPreservationValidator";

const MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Kitchen");
const IMAGE_PATH = path.join(OUT_DIR, "Karaka - Image 02 Decluttered.jpg");

type Point = [number, number];

// Real extractStructuralBaseline() output, captured this task
// (tmp/real_baseline_kitchen_1786602038537.json) — reused verbatim.
const KNOWN_BASELINE = {
  room_type: "kitchen_living", // open-plan: kitchen fixtures + partial sofa in frame
  openings: [
    { id: "W1", type: "window", bbox: [0.962, 0.1426, 1, 0.95], wallIndex: 1, wallPosition: "right_wall", confidence: 0.9 },
    { id: "D1", type: "door", bbox: [0, 0.2833, 0.1104, 0.9435], wallIndex: 3, wallPosition: "left_wall", confidence: 0.98 },
    { id: "A1", type: "walkthrough", bbox: [0.1203, 0.2315, 0.201, 0.9444], wallIndex: 3, wallPosition: "left_wall", confidence: 0.95 },
  ] as { id: string; type: StructuralOpeningType; bbox: number[]; wallIndex: number; wallPosition: string; confidence: number }[],
  anchorFixtures: [
    { id: "F2", type: "built_in_cabinet", wallIndex: 0, confidence: 0.98 },
    { id: "F1", type: "kitchen_island", wallIndex: 0, confidence: 0.99 },
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
  actual visible floor-to-ceiling boundary of that wall, tracing the true visible outline, not padded
  to a rectangle).
- List which of the GIVEN opening/fixture IDs (from the baseline below) fall on this wall.
- Estimate usableWidthFraction: the fraction (0-1) of this wall's total width that is clear, usable
  wall space once the openings/fixtures on it are subtracted.
- Describe usableSegments: horizontal fraction ranges [start, end] (0-1, left to right as visible in
  frame) along that wall, each a contiguous usable segment, with a short plain description.
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

// ── Planner (verbatim logic from build_deterministic_layout_plan_v3.ts) ──
type UsableSegment = { range: [number, number]; widthFraction: number; description: string };
type Wall = {
  id: string;
  wallLabel: string;
  extent: { polygon: Point[] };
  openingIds: string[];
  usableWidthFraction: number;
  usableSegments: UsableSegment[];
  confidence: number;
};

const MIN_USABLE_FRACTION_FOR_ANCHOR = 0.35;
const MIN_USABLE_FRACTION_FOR_ACCENT = 0.08;
const FOCAL_OPENING_TYPE_PRIORITY: StructuralOpeningType[] = ["window", "door"];
const FRAME_EDGE_EPSILON = 0.03;

function wallBBox(wall: Wall) {
  const xs = wall.extent.polygon.map((p) => p[0]);
  const ys = wall.extent.polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function determineOrientation(baseline: typeof KNOWN_BASELINE, anchorWallIndex: number | null) {
  for (const focalType of FOCAL_OPENING_TYPE_PRIORITY) {
    const candidates = baseline.openings.filter((o) => o.type === focalType);
    const offAnchorWall = candidates.filter((o) => o.wallIndex !== anchorWallIndex);
    const pick = offAnchorWall[0] || candidates[0];
    if (pick) {
      return {
        focalFeatureId: pick.id,
        focalFeatureType: pick.type,
        focalFeatureWallIndex: pick.wallIndex,
        rule: `Selected ${pick.id} (type="${pick.type}") as the orientation focal feature: highest-priority focal type (${FOCAL_OPENING_TYPE_PRIORITY.join(" > ")}) ${offAnchorWall.length > 0 ? "not on the anchor item's own wall" : "(only available on the anchor's own wall — lower-confidence fallback)"}.`,
      };
    }
  }
  return { focalFeatureId: null, focalFeatureType: null, focalFeatureWallIndex: null, rule: "No focal opening found — default to facing into the room." };
}

function determineFraming(wall: Wall) {
  const { minX, maxX } = wallBBox(wall);
  const touchesLeft = minX <= FRAME_EDGE_EPSILON;
  const touchesRight = maxX >= 1 - FRAME_EDGE_EPSILON;
  if (touchesLeft || touchesRight) {
    const edgeSide: "left" | "right" = touchesRight ? "right" : "left";
    return { wallTouchesFrameEdge: true, edgeSide, rule: `${wall.id} touches the ${edgeSide} image boundary — edge-cropped placement permitted.` };
  }
  return { wallTouchesFrameEdge: false, edgeSide: null as null, rule: `${wall.id} is fully visible — center within the widest usable segment.` };
}

function planStagingDeterministic(baseline: typeof KNOWN_BASELINE, walls: Wall[]) {
  const anchorItem: AnchorItem = baseline.room_type === "bedroom" ? "bed" : "sofa_group";

  const wallCandidates = walls.map((wall) => {
    const largestSegment = wall.usableSegments.reduce((max, s) => Math.max(max, s.widthFraction), 0);
    return {
      wallId: wall.id,
      wallLabel: wall.wallLabel,
      usableWidthFraction: wall.usableWidthFraction,
      largestContiguousSegmentFraction: largestSegment,
      openingIds: wall.openingIds,
      meetsMinThreshold: largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR,
    };
  });

  const ranked = [...wallCandidates].sort((a, b) => b.largestContiguousSegmentFraction - a.largestContiguousSegmentFraction);
  const qualifying = ranked.filter((w) => w.meetsMinThreshold);
  const selected = qualifying[0] || ranked[0];
  const usedFallback = qualifying.length === 0;

  const selectedWall = walls.find((w) => w.id === selected.wallId)!;
  const bestSegment = [...selectedWall.usableSegments].sort((a, b) => b.widthFraction - a.widthFraction)[0];
  const selectedWallIndex = Number(String(selectedWall.id).replace("wall_", ""));

  const orientation = determineOrientation(baseline, selectedWallIndex);
  const anchorOrientation: AnchorOrientation | "foot_toward_focal_feature" = orientation.focalFeatureId ? "foot_toward_focal_feature" : "facing_anchor_wall";
  const itemLabel = anchorItem === "bed" ? "bed" : "sofa";
  const anchorOrientationInstruction = orientation.focalFeatureId
    ? `Orient the ${itemLabel} so it faces toward ${orientation.focalFeatureId} (the ${orientation.focalFeatureType} on wall_${orientation.focalFeatureWallIndex}) — NOT facing the camera directly.`
    : `No focal opening identified; orient the ${itemLabel} facing into the open floor area of the room.`;

  const framing = determineFraming(selectedWall);
  const anchorFramingInstruction = framing.wallTouchesFrameEdge
    ? `${selectedWall.id} is only partially visible in the frame (truncated at the ${framing.edgeSide} edge). Edge-cropped placement is acceptable.`
    : `${selectedWall.id} is fully visible in the frame. Center the ${itemLabel} within the widest usable segment.`;

  const selectionReason = usedFallback
    ? `No wall met the ${MIN_USABLE_FRACTION_FOR_ANCHOR} threshold; selected ${selected.wallId} as best available (${selected.largestContiguousSegmentFraction.toFixed(3)}), flagged as fallback.`
    : `${selected.wallId} (${selected.wallLabel}) selected: largest contiguous usable segment ${selected.largestContiguousSegmentFraction.toFixed(3)} ("${bestSegment.description}"), exceeds all others (${ranked.slice(1).map((w) => `${w.wallId}=${w.largestContiguousSegmentFraction.toFixed(3)}`).join(", ") || "none"}).`;

  return {
    room_type: baseline.room_type,
    anchorItem,
    anchorWall: selectedWall.wallLabel,
    anchorWallId: selectedWall.id,
    anchorOrientation,
    anchorOrientationInstruction,
    anchorFramingInstruction,
    anchorConfidence: usedFallback ? 0.3 : Math.min(selectedWall.confidence, 0.9),
    reasoning: { wallCandidates, selectedWallId: selected.wallId, selectionReason, orientation, framing },
  };
}
// ── end planner ──

async function main() {
  const meta = await sharp(IMAGE_PATH).metadata();
  const width = meta.width!, height = meta.height!;
  console.log("=== Kitchen wall-visibility extraction starting ===", { width, height });

  const image = toBase64(IMAGE_PATH);
  const ai = getGeminiClient();
  const startedAt = Date.now();
  const response = await (ai as any).models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: SYSTEM_INSTRUCTION }, { text: buildUserPrompt() }, { inlineData: { mimeType: image.mime, data: image.data } }] }],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 3072, responseMimeType: "application/json" },
  });
  const durationMs = Date.now() - startedAt;

  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error("NO TEXT RETURNED");
  const parsed = extractJson(textPart.text);
  console.log(`=== wall-visibility result (${durationMs}ms) ===`);
  console.log(JSON.stringify(parsed, null, 2));

  // Overlay render for visual sanity check.
  const wallColors = ["rgba(255,0,0,0.3)", "rgba(0,150,255,0.3)", "rgba(0,200,80,0.3)", "rgba(255,165,0,0.3)"];
  const svgParts: string[] = [];
  for (const wall of parsed.walls || []) {
    const wallIdx = Number(String(wall.id).replace("wall_", "")) || 0;
    if (wall.extent?.polygon) {
      svgParts.push(`<polygon points="${denormPolygon(wall.extent.polygon, width, height)}" fill="${wallColors[wallIdx % wallColors.length]}" stroke="black" stroke-width="3"/>`);
      const xs = wall.extent.polygon.map((p: Point) => p[0]);
      const ys = wall.extent.polygon.map((p: Point) => p[1]);
      const labelX = Math.round(((Math.min(...xs) + Math.max(...xs)) / 2) * width);
      const labelY = Math.round(Math.min(...ys) * height) + 30;
      svgParts.push(`<text x="${labelX}" y="${labelY}" font-size="26" font-weight="bold" fill="black" text-anchor="middle">${wall.id}</text>`);
    }
  }
  const overlayLayer = await sharp(Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgParts.join("\n")}</svg>`)).png().toBuffer();
  const overlayBuffer = await sharp(IMAGE_PATH).composite([{ input: overlayLayer, blend: "over" }]).png().toBuffer();
  const overlayPath = path.join(OUT_DIR, "Karaka 02-wallvis-overlay.png");
  await sharp(overlayBuffer).toFile(overlayPath);
  console.log("overlay saved:", overlayPath);

  const plan = planStagingDeterministic(KNOWN_BASELINE, parsed.walls);
  console.log("\n=== DETERMINISTIC PLAN (kitchen/living) ===");
  console.log(JSON.stringify(plan, null, 2));

  const outPath = path.join(REPO_ROOT, "tmp", `kitchen_wallvis_and_plan_${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify({ walls: parsed, plan }, null, 2));
  console.log("\n=== SAVED:", outPath, "===");
}

main().catch((e) => {
  console.error("kitchen_wallvis_and_plan failed:", e);
  process.exit(1);
});
