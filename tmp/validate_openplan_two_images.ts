// Validation run: full pipeline (real baseline extraction -> real
// wall-visibility -> real zoning -> corrected multi-anchor planning from
// tmp/investigate_openplan_zoning_v2.ts) on two new real images,
// independently. No hardcoded baseline this time — these are new images,
// baseline is extracted for real. No generation calls.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

type Point = [number, number];

function extractJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}
function denormPolygon(points: Point[], width: number, height: number): string {
  return points.map(([x, y]) => `${Math.round(x * width)},${Math.round(y * height)}`).join(" ");
}
function polygonBBox(polygon: Point[]) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function polygonCentroid(polygon: Point[]): Point {
  const n = polygon.length;
  return [polygon.reduce((s, p) => s + p[0], 0) / n, polygon.reduce((s, p) => s + p[1], 0) / n];
}

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

const ZONING_SYSTEM_INSTRUCTION = `You are a structural feature extraction engine, extending an existing analysis to identify functional zones within an open-plan living/dining room.

You are given a room photograph AND an existing structural baseline (openings and fixtures already detected, with stable IDs).

This room combines two functions: a LIVING zone (seating area) and a DINING zone (table + chairs area). Identify how the visible floor space divides into these two zones, based on genuine visual cues — a change in flooring material, a change in ceiling treatment, existing furniture grouping if the room happens to be furnished (use furniture position only as a cue for how the space is naturally used, not as a placement instruction to preserve), sightlines, and traffic flow. If the room is empty, rely on architectural geometry alone (room shape, alcoves, ceiling breaks, wall offsets) — do not assume an even 50/50 split, and do not invent a furniture-based cue that isn't visible. The two zones' floor regions should not overlap.

Additionally, determine whether any of the given openings appears to lead toward or provide a sightline into a KITCHEN — look for cues such as visible countertops, cabinetry, appliances, a kitchen island, pendant/track lighting typical of kitchens, or distinct kitchen-style flooring/splashback visible through or beyond the opening. This is inference from visible cues, not a labeled fact in the baseline — report your confidence honestly, and report present:false if no such cue exists anywhere in the photo.

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.`;

function buildZoningUserPrompt(baseline: any): string {
  return `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(baseline, null, 2)}

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

// ── Corrected multi-anchor logic, ported verbatim from
// tmp/investigate_openplan_zoning_v2.ts (same thresholds, same rule order). ──
const MIN_USABLE_FRACTION_FOR_ANCHOR = 0.35;
const TV_MIN_USABLE_FRACTION = 0.2;
const MIN_ZONE_DEPTH_FOR_TV_FACING = 0.25;
const FOCAL_OPENING_TYPE_PRIORITY = ["window", "door"] as const;

function planMultiAnchor(baseline: any, walls: any[], zones: any[]) {
  const livingZone = zones.find((z) => z.purpose === "living");
  const diningZone = zones.find((z) => z.purpose === "dining");
  const reasoning: string[] = [];

  let diningPlan: any = null;
  if (diningZone?.floorRegion?.polygon?.length >= 3) {
    const centroid = polygonCentroid(diningZone.floorRegion.polygon);
    const bbox = polygonBBox(diningZone.floorRegion.polygon);
    diningPlan = {
      center: centroid,
      footprint: { halfWidth: Math.min(0.12, (bbox.maxX - bbox.minX) * 0.35), halfHeight: Math.min(0.08, (bbox.maxY - bbox.minY) * 0.3) },
      reasoning: `Table centered within zone_dining's floor region (centroid [${centroid[0].toFixed(3)}, ${centroid[1].toFixed(3)}]), inset from bordering walls for chair clearance.`,
    };
  } else {
    reasoning.push("No dining zone floor region returned — dining anchor plan skipped.");
  }

  let tvPlan: any = null;
  let noTvReason: string | null = null;
  let sofaPlan: any = null;

  if (livingZone) {
    const livingWallIndices: number[] = livingZone.borderingWallIndices || [];
    const otherZonesWallIndices = new Set<number>(zones.filter((z) => z.id !== livingZone.id).flatMap((z) => z.borderingWallIndices || []));
    const exclusiveLivingWallIndices = livingWallIndices.filter((idx) => !otherZonesWallIndices.has(idx));
    const sharedLivingWallIndices = livingWallIndices.filter((idx) => otherZonesWallIndices.has(idx));
    reasoning.push(`Living zone borders wall indices [${livingWallIndices.join(", ")}]. Zone-exclusive: [${exclusiveLivingWallIndices.join(", ") || "none"}]. Shared (excluded from TV candidacy): [${sharedLivingWallIndices.join(", ") || "none"}].`);

    const wallByIndex = (idx: number) => walls.find((w: any) => Number(String(w.id).replace("wall_", "")) === idx);
    const zoneDepthProxy = livingZone.floorRegion?.polygon ? polygonBBox(livingZone.floorRegion.polygon).maxY - polygonBBox(livingZone.floorRegion.polygon).minY : 0;
    const depthOk = zoneDepthProxy >= MIN_ZONE_DEPTH_FOR_TV_FACING;
    reasoning.push(`Living zone floor-region depth proxy: ${zoneDepthProxy.toFixed(3)} (threshold ${MIN_ZONE_DEPTH_FOR_TV_FACING}) — ${depthOk ? "sufficient" : "insufficient"}.`);

    const tvCandidates = exclusiveLivingWallIndices
      .map((idx) => wallByIndex(idx))
      .filter(Boolean)
      .map((w: any) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
      .filter((c) => c.largestSegment >= TV_MIN_USABLE_FRACTION)
      .sort((a, b) => b.largestSegment - a.largestSegment);
    const tvCandidate = depthOk ? tvCandidates[0] : undefined;

    if (tvCandidate) {
      const seg = [...(tvCandidate.wall.usableSegments || [])].sort((a: any, b: any) => b.widthFraction - a.widthFraction)[0];
      tvPlan = { wallId: tvCandidate.wall.id, wallLabel: tvCandidate.wall.wallLabel, segmentDescription: seg?.description, largestSegment: tvCandidate.largestSegment, reasoning: `TV wall selected: ${tvCandidate.wall.id} (${tvCandidate.wall.wallLabel}) is zone-exclusive, clears TV width threshold (${tvCandidate.largestSegment.toFixed(3)} >= ${TV_MIN_USABLE_FRACTION}), zone depth sufficient.` };
      reasoning.push(tvPlan.reasoning);

      const sofaCandidates = livingWallIndices
        .map((idx) => wallByIndex(idx))
        .filter(Boolean)
        .filter((w: any) => w.id !== tvCandidate.wall.id)
        .map((w: any) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
        .filter((c) => c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR)
        .sort((a, b) => b.largestSegment - a.largestSegment);

      sofaPlan = sofaCandidates[0]
        ? { wallId: sofaCandidates[0].wall.id, wallLabel: sofaCandidates[0].wall.wallLabel, facingWallId: tvCandidate.wall.id, reasoning: `Sofa placed against ${sofaCandidates[0].wall.id}, facing ${tvCandidate.wall.id}.` }
        : { wallId: null, floorCentered: true, facingWallId: tvCandidate.wall.id, reasoning: `No other living-zone wall qualified; sofa floor-centered, facing ${tvCandidate.wall.id}.` };
      reasoning.push(sofaPlan.reasoning);
    } else {
      noTvReason = !depthOk
        ? "no TV placed — living zone floor depth is insufficient for a sofa to face a TV at a plausible distance"
        : exclusiveLivingWallIndices.length === 0
        ? "no TV placed — no wall is exclusive to the living zone (all bordering walls are shared with another zone)"
        : "no TV placed — no zone-exclusive wall clears the minimum usable-width threshold for a TV";
      reasoning.push(noTvReason);

      const sofaCandidates = livingWallIndices
        .map((idx) => wallByIndex(idx))
        .filter(Boolean)
        .map((w: any) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
        .filter((c) => c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR)
        .sort((a, b) => b.largestSegment - a.largestSegment);
      const sofaWall = sofaCandidates[0]?.wall || null;
      const sofaWallIndex = sofaWall ? Number(String(sofaWall.id).replace("wall_", "")) : null;

      let focalFeatureId: string | null = null, focalFeatureType: string | null = null, focalFeatureWallIndex: number | null = null;
      for (const focalType of FOCAL_OPENING_TYPE_PRIORITY) {
        const candidates = baseline.openings.filter((o: any) => o.type === focalType && livingWallIndices.includes(o.wallIndex));
        const offSofaWall = candidates.filter((o: any) => o.wallIndex !== sofaWallIndex);
        const pick = offSofaWall[0] || candidates[0];
        if (pick) { focalFeatureId = pick.id; focalFeatureType = pick.type; focalFeatureWallIndex = pick.wallIndex; break; }
      }
      const orientationInstruction = focalFeatureId
        ? `Orient the sofa to face toward ${focalFeatureId} (the ${focalFeatureType} on wall_${focalFeatureWallIndex}).`
        : `No focal opening identified in the living zone; orient the sofa facing into the open floor area of the room.`;

      sofaPlan = sofaWall
        ? { wallId: sofaWall.id, wallLabel: sofaWall.wallLabel, facingWallId: null, orientationInstruction, reasoning: `Sofa placed against ${sofaWall.id} — no TV to face. ${orientationInstruction}` }
        : { wallId: null, floorCentered: true, facingWallId: null, orientationInstruction, reasoning: `No living-zone wall cleared the sofa threshold; floor-centered. ${orientationInstruction}` };
      reasoning.push(sofaPlan.reasoning);
    }
  } else {
    reasoning.push("No living zone returned — TV/sofa plan skipped.");
  }

  return { diningPlan, tvPlan, noTvReason, sofaPlan, reasoning, livingZone, diningZone };
}

async function renderOverlay(imagePath: string, outPath: string, baseline: any, walls: any[], zoning: any, plan: any) {
  const meta = await sharp(imagePath).metadata();
  const width = meta.width!, height = meta.height!;
  const svgParts: string[] = [];
  const zoneColors: Record<string, string> = { living: "rgba(0,120,255,0.25)", dining: "rgba(255,140,0,0.25)" };
  for (const z of zoning.zones || []) {
    if (!z.floorRegion?.polygon) continue;
    svgParts.push(`<polygon points="${denormPolygon(z.floorRegion.polygon, width, height)}" fill="${zoneColors[z.purpose] || "rgba(150,150,150,0.25)"}" stroke="black" stroke-width="3" stroke-dasharray="10,6"/>`);
    const c = polygonCentroid(z.floorRegion.polygon);
    svgParts.push(`<text x="${Math.round(c[0] * width)}" y="${Math.round(c[1] * height)}" font-size="28" font-weight="bold" fill="black" text-anchor="middle">${z.id}</text>`);
  }
  if (zoning.kitchenSignal?.present && zoning.kitchenSignal.openingId) {
    const opening = baseline.openings.find((o: any) => o.id === zoning.kitchenSignal.openingId);
    if (opening) {
      const [x1, y1, x2, y2] = opening.bbox;
      svgParts.push(`<rect x="${x1 * width}" y="${y1 * height}" width="${(x2 - x1) * width}" height="${(y2 - y1) * height}" fill="none" stroke="red" stroke-width="6"/>`);
      svgParts.push(`<text x="${((x1 + x2) / 2) * width}" y="${Math.max(24, y1 * height - 12)}" font-size="24" font-weight="bold" fill="red" text-anchor="middle">KITCHEN SIGNAL (${opening.id}, conf ${zoning.kitchenSignal.confidence})</text>`);
    }
  }
  if (plan.diningPlan) {
    const [cx, cy] = plan.diningPlan.center;
    const { halfWidth, halfHeight } = plan.diningPlan.footprint;
    svgParts.push(`<rect x="${(cx - halfWidth) * width}" y="${(cy - halfHeight) * height}" width="${halfWidth * 2 * width}" height="${halfHeight * 2 * height}" fill="rgba(139,69,19,0.6)" stroke="black" stroke-width="3"/>`);
    svgParts.push(`<text x="${cx * width}" y="${cy * height}" font-size="22" font-weight="bold" fill="white" text-anchor="middle">DINING TABLE</text>`);
  }
  function segmentToFrameX(wall: any, seg: any) {
    const bbox = polygonBBox(wall.extent.polygon);
    return { x1: bbox.minX + (bbox.maxX - bbox.minX) * seg.range[0], x2: bbox.minX + (bbox.maxX - bbox.minX) * seg.range[1], minY: bbox.minY, maxY: bbox.maxY };
  }
  if (plan.tvPlan) {
    const wall = walls.find((w: any) => w.id === plan.tvPlan.wallId);
    const seg = wall?.usableSegments?.find((s: any) => s.description === plan.tvPlan.segmentDescription) || wall?.usableSegments?.[0];
    if (wall && seg) {
      const { x1, x2, maxY } = segmentToFrameX(wall, seg);
      const tvY1 = maxY * 0.65, tvY2 = maxY * 0.85;
      svgParts.push(`<rect x="${x1 * width}" y="${tvY1 * height}" width="${(x2 - x1) * width}" height="${(tvY2 - tvY1) * height}" fill="rgba(0,0,0,0.7)" stroke="lime" stroke-width="3"/>`);
      svgParts.push(`<text x="${((x1 + x2) / 2) * width}" y="${((tvY1 + tvY2) / 2) * height}" font-size="20" font-weight="bold" fill="lime" text-anchor="middle">TV</text>`);
    }
  } else if (plan.noTvReason) {
    svgParts.push(`<text x="${width * 0.02}" y="${height * 0.06}" font-size="24" font-weight="bold" fill="red">NO TV: ${plan.noTvReason}</text>`);
  }
  if (plan.sofaPlan?.wallId) {
    const wall = walls.find((w: any) => w.id === plan.sofaPlan.wallId);
    const seg = wall?.usableSegments?.[0];
    if (wall && seg) {
      const { x1, x2, maxY } = segmentToFrameX(wall, seg);
      const sofaY1 = maxY * 0.7, sofaY2 = maxY;
      svgParts.push(`<rect x="${x1 * width}" y="${sofaY1 * height}" width="${(x2 - x1) * width}" height="${(sofaY2 - sofaY1) * height}" fill="rgba(80,40,150,0.6)" stroke="black" stroke-width="3"/>`);
      svgParts.push(`<text x="${((x1 + x2) / 2) * width}" y="${((sofaY1 + sofaY2) / 2) * height}" font-size="20" font-weight="bold" fill="white" text-anchor="middle">SOFA</text>`);
    }
  } else if (plan.sofaPlan?.floorCentered && plan.livingZone) {
    const c = polygonCentroid(plan.livingZone.floorRegion.polygon);
    svgParts.push(`<rect x="${(c[0] - 0.1) * width}" y="${(c[1] - 0.05) * height}" width="${0.2 * width}" height="${0.1 * height}" fill="rgba(80,40,150,0.6)" stroke="black" stroke-width="3"/>`);
    svgParts.push(`<text x="${c[0] * width}" y="${c[1] * height}" font-size="20" font-weight="bold" fill="white" text-anchor="middle">SOFA (floor-centered)</text>`);
  }
  if (plan.sofaPlan?.wallId && plan.sofaPlan.facingWallId) {
    const sofaWall = walls.find((w: any) => w.id === plan.sofaPlan.wallId);
    const facingWall = walls.find((w: any) => w.id === plan.sofaPlan.facingWallId);
    if (sofaWall && facingWall) {
      const c1 = polygonCentroid(sofaWall.extent.polygon);
      const c2 = polygonCentroid(facingWall.extent.polygon);
      svgParts.push(`<line x1="${c1[0] * width}" y1="${c1[1] * height}" x2="${c2[0] * width}" y2="${c2[1] * height}" stroke="yellow" stroke-width="4" stroke-dasharray="12,8"/>`);
    }
  }
  const overlayLayer = await sharp(Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgParts.join("\n")}</svg>`)).png().toBuffer();
  const overlayBuffer = await sharp(imagePath).composite([{ input: overlayLayer, blend: "over" }]).png().toBuffer();
  await sharp(overlayBuffer).toFile(outPath);
}

async function processImage(imageName: string) {
  const imagePath = path.join(OUT_DIR, imageName);
  console.log(`\n\n########## ${imageName} ##########`);

  console.log("--- 1) Real baseline extraction ---");
  const baseline: any = await extractStructuralBaseline(imagePath, { jobId: `tmp-validate-${imageName}`, imageId: `tmp-validate-${imageName}` });
  console.log(JSON.stringify(baseline, null, 2));

  const image = toBase64(imagePath);

  console.log("--- 2) Real wall-visibility extraction ---");
  const wallVis = await callGemini(WALL_VISIBILITY_SYSTEM_INSTRUCTION, buildWallVisibilityUserPrompt(baseline), image);
  console.log(JSON.stringify(wallVis, null, 2));

  console.log("--- 3) Real zoning extraction ---");
  const zoning = await callGemini(ZONING_SYSTEM_INSTRUCTION, buildZoningUserPrompt(baseline), image);
  console.log(JSON.stringify(zoning, null, 2));

  console.log("--- 4) Multi-anchor planning (corrected TV-wall rule) ---");
  const plan = planMultiAnchor(baseline, wallVis.walls || [], zoning.zones || []);
  console.log(JSON.stringify(plan, null, 2));

  const overlayName = imageName.replace(/\.jpg$/i, "-openplan-zoning-overlay.png");
  const overlayPath = path.join(OUT_DIR, overlayName);
  await renderOverlay(imagePath, overlayPath, baseline, wallVis.walls || [], zoning, plan);
  console.log("overlay saved:", overlayPath);

  const outPath = path.join(REPO_ROOT, "tmp", `validate_${imageName.replace(/\.jpg$/i, "")}_${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify({ baseline, wallVis, zoning, plan }, null, 2));
  console.log("saved:", outPath);

  return { imageName, baseline, wallVis, zoning, plan, overlayPath };
}

async function main() {
  const results = [];
  results.push(await processImage("Living 07.jpg"));
  results.push(await processImage("Living 10.jpg"));
  console.log("\n\n=== ALL DONE ===");
}

main().catch((e) => {
  console.error("validate_openplan_two_images failed:", e);
  process.exit(1);
});
