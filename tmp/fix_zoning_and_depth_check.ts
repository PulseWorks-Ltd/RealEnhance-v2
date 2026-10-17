// Fix 1: targeted zoning prompt improvement (baseboard-line anchoring) +
// Fix 2: depth-proxy sanity check against implausible zone polygons.
// Reuses existing baseline + wall-visibility data for all three images
// (no need to re-run those — unchanged by this fix). Re-runs ONLY the
// zoning call (3 real Gemini calls total: Rental 03, Living 07, Living 10).
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");
const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

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

// ── PART 1.2: updated zoning prompt. BEFORE (previous instruction) had no
// guidance on how far back a zone's floor-region polygon should extend —
// only what determines a zone's boundary, not the polygon's spatial extent.
// Root cause on Living 10 (confirmed by direct crop inspection): the real
// baseboard/wall-floor junction sits at y~0.52 in frame coordinates; both
// the (unrelated, unchanged-here) wall-visibility extraction AND the
// zoning extraction independently placed it at y~0.85-0.94 instead — a
// plain, evenly-lit, low-texture-contrast carpet with a complex mid-room
// dividing-wall structure appears to make floor depth easy to
// underestimate. Fix: explicit instruction to anchor the polygon to the
// visible baseboard line, phrased generally (not tied to this image's
// specific numbers) so it addresses the failure class, not just this case. ──
const ZONING_SYSTEM_INSTRUCTION_V2 = `You are a structural feature extraction engine, extending an existing analysis to identify functional zones within an open-plan living/dining room.

You are given a room photograph AND an existing structural baseline (openings and fixtures already detected, with stable IDs).

This room combines two functions: a LIVING zone (seating area) and a DINING zone (table + chairs area). Identify how the visible floor space divides into these two zones, based on genuine visual cues — a change in flooring material, a change in ceiling treatment, existing furniture grouping if the room happens to be furnished (use furniture position only as a cue for how the space is naturally used, not as a placement instruction to preserve), sightlines, and traffic flow. If the room is empty, rely on architectural geometry alone (room shape, alcoves, ceiling breaks, wall offsets) — do not assume an even 50/50 split, and do not invent a furniture-based cue that isn't visible. The two zones' floor regions should not overlap.

FLOOR-REGION EXTENT — CRITICAL: each zone's floorRegion polygon must extend all the way to the actual visible baseboard / wall-to-floor junction line for every wall that borders it, not stop short of it. Locate the baseboard line at the base of each bordering wall — usually a thin, fairly straight line where the wall surface meets the floor — and trace the polygon out to that line, not to some more conservative point partway there. This is easy to get wrong in rooms with plain, evenly-lit, low-texture-contrast flooring (e.g. bare carpet with no rug or furniture to judge distance against) — in those cases it is especially important to look carefully for the actual baseboard line rather than guessing a shorter distance. A floor region that stops well short of the real baseboard line anywhere along a bordering wall is wrong, even if the general shape/cues used to divide the two zones are otherwise correct.

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

// ── PART 2: depth-proxy sanity check. Compares the zone's floor-region
// depth proxy against the CANDIDATE TV WALL's own vertical extent in frame
// (floor-to-ceiling height, from its polygon bbox) rather than the wall's
// width — a wall's own frame-height is a much more directly relevant
// reference for "how much floor could plausibly be visible in front of
// it" than its width is. General ratio check, not tied to any image's
// specific numbers. ──
const WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO = 0.3;

const MIN_USABLE_FRACTION_FOR_ANCHOR = 0.35;
const TV_MIN_USABLE_FRACTION = 0.2;
const MIN_ZONE_DEPTH_FOR_TV_FACING = 0.25;
const FOCAL_OPENING_TYPE_PRIORITY = ["window", "door"] as const;

function planMultiAnchor(baseline: any, walls: any[], zones: any[]) {
  const livingZone = zones.find((z) => z.purpose === "living");
  const diningZone = zones.find((z) => z.purpose === "dining");
  const reasoning: string[] = [];
  let depthCheckFlaggedSuspect = false;

  let diningPlan: any = null;
  if (diningZone?.floorRegion?.polygon?.length >= 3) {
    const centroid = polygonCentroid(diningZone.floorRegion.polygon);
    const bbox = polygonBBox(diningZone.floorRegion.polygon);
    diningPlan = { center: centroid, footprint: { halfWidth: Math.min(0.12, (bbox.maxX - bbox.minX) * 0.35), halfHeight: Math.min(0.08, (bbox.maxY - bbox.minY) * 0.3) }, reasoning: `Table centered within zone_dining (centroid [${centroid[0].toFixed(3)}, ${centroid[1].toFixed(3)}]).` };
  }

  let tvPlan: any = null;
  let noTvReason: string | null = null;
  let sofaPlan: any = null;

  if (livingZone) {
    const livingWallIndices: number[] = livingZone.borderingWallIndices || [];
    const otherZonesWallIndices = new Set<number>(zones.filter((z) => z.id !== livingZone.id).flatMap((z) => z.borderingWallIndices || []));
    const exclusiveLivingWallIndices = livingWallIndices.filter((idx) => !otherZonesWallIndices.has(idx));
    const wallByIndex = (idx: number) => walls.find((w: any) => Number(String(w.id).replace("wall_", "")) === idx);

    const zoneBBox = livingZone.floorRegion?.polygon ? polygonBBox(livingZone.floorRegion.polygon) : null;
    const zoneDepthProxy = zoneBBox ? zoneBBox.maxY - zoneBBox.minY : 0;
    let depthOk = zoneDepthProxy >= MIN_ZONE_DEPTH_FOR_TV_FACING;
    reasoning.push(`Living zone floor-region depth proxy: ${zoneDepthProxy.toFixed(3)} (threshold ${MIN_ZONE_DEPTH_FOR_TV_FACING}) — ${depthOk ? "sufficient" : "insufficient"}.`);

    const tvCandidatesRaw = exclusiveLivingWallIndices
      .map((idx) => wallByIndex(idx))
      .filter(Boolean)
      .map((w: any) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
      .filter((c) => c.largestSegment >= TV_MIN_USABLE_FRACTION)
      .sort((a, b) => b.largestSegment - a.largestSegment);

    // Sanity check, only meaningful when the depth check would otherwise
    // block an exclusivity+width-qualified candidate.
    if (!depthOk && tvCandidatesRaw[0]) {
      const wallBBoxTop = polygonBBox(tvCandidatesRaw[0].wall.extent.polygon);
      const wallHeightInFrame = wallBBoxTop.maxY - wallBBoxTop.minY;
      const implausible = zoneDepthProxy < WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO * wallHeightInFrame;
      reasoning.push(`Depth-proxy sanity check: candidate wall ${tvCandidatesRaw[0].wall.id} frame-height ${wallHeightInFrame.toFixed(3)}; zone depth (${zoneDepthProxy.toFixed(3)}) is ${implausible ? "BELOW" : "at/above"} ${WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO} x wall-height (${(WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO * wallHeightInFrame).toFixed(3)}) — ${implausible ? "flagging the depth reading as likely unreliable, not trusting it as a hard rejection" : "no anomaly detected"}.`);
      if (implausible) {
        depthCheckFlaggedSuspect = true;
        // Chosen behavior (Part 2.2): don't hard-reject on a flagged-suspect
        // depth signal — the wall-exclusivity and wall-usable-width checks
        // are independently robust (grounded directly in wall-visibility's
        // usableSegments), so a single fragile proxy shouldn't solely veto
        // an otherwise-qualified candidate. Proceed as if depth were OK,
        // with this explicitly logged so it's auditable, not silent.
        depthOk = true;
      }
    }

    const tvCandidate = depthOk ? tvCandidatesRaw[0] : undefined;

    if (tvCandidate) {
      const seg = [...(tvCandidate.wall.usableSegments || [])].sort((a: any, b: any) => b.widthFraction - a.widthFraction)[0];
      tvPlan = { wallId: tvCandidate.wall.id, wallLabel: tvCandidate.wall.wallLabel, segmentDescription: seg?.description, largestSegment: tvCandidate.largestSegment, depthCheckFlaggedSuspect, reasoning: `TV wall selected: ${tvCandidate.wall.id} (${tvCandidate.wall.wallLabel}) is zone-exclusive, clears TV width threshold (${tvCandidate.largestSegment.toFixed(3)} >= ${TV_MIN_USABLE_FRACTION})${depthCheckFlaggedSuspect ? ", depth check flagged suspect and bypassed (see sanity-check reasoning)" : ", zone depth sufficient"}.` };
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
      noTvReason = exclusiveLivingWallIndices.length === 0
        ? "no TV placed — no wall is exclusive to the living zone (all bordering walls are shared with another zone)"
        : tvCandidatesRaw.length === 0
        ? "no TV placed — no zone-exclusive wall clears the minimum usable-width threshold for a TV"
        : "no TV placed — living zone floor depth is insufficient for a sofa to face a TV at a plausible distance";
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
      const orientationInstruction = focalFeatureId ? `Orient the sofa to face toward ${focalFeatureId} (the ${focalFeatureType} on wall_${focalFeatureWallIndex}).` : `No focal opening identified; orient the sofa facing into the open floor area of the room.`;
      sofaPlan = sofaWall
        ? { wallId: sofaWall.id, wallLabel: sofaWall.wallLabel, facingWallId: null, orientationInstruction, reasoning: `Sofa placed against ${sofaWall.id} — no TV to face. ${orientationInstruction}` }
        : { wallId: null, floorCentered: true, facingWallId: null, orientationInstruction, reasoning: `No living-zone wall qualified; floor-centered. ${orientationInstruction}` };
      reasoning.push(sofaPlan.reasoning);
    }
  }

  return { diningPlan, tvPlan, noTvReason, sofaPlan, reasoning, livingZone, diningZone, depthCheckFlaggedSuspect };
}

async function renderZoneComparisonOverlay(imagePath: string, outPath: string, oldZones: any[], newZones: any[]) {
  const meta = await sharp(imagePath).metadata();
  const width = meta.width!, height = meta.height!;
  const svgParts: string[] = [];
  for (const z of oldZones) {
    if (!z.floorRegion?.polygon) continue;
    svgParts.push(`<polygon points="${denormPolygon(z.floorRegion.polygon, width, height)}" fill="none" stroke="red" stroke-width="4" stroke-dasharray="6,4"/>`);
  }
  for (const z of newZones) {
    if (!z.floorRegion?.polygon) continue;
    svgParts.push(`<polygon points="${denormPolygon(z.floorRegion.polygon, width, height)}" fill="rgba(0,200,80,0.25)" stroke="lime" stroke-width="4"/>`);
  }
  svgParts.push(`<text x="20" y="30" font-size="26" font-weight="bold" fill="red">OLD (dashed red outline)</text>`);
  svgParts.push(`<text x="20" y="60" font-size="26" font-weight="bold" fill="lime">NEW (solid green fill)</text>`);
  const overlayLayer = await sharp(Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgParts.join("\n")}</svg>`)).png().toBuffer();
  const overlayBuffer = await sharp(imagePath).composite([{ input: overlayLayer, blend: "over" }]).png().toBuffer();
  await sharp(overlayBuffer).toFile(outPath);
}

async function main() {
  // Load existing baseline + wall-visibility data (unchanged by this fix).
  const rental03Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/openplan_zoning_1786613150664.json"), "utf8"));
  const rental03Baseline = {
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
  const living07Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 07_1786620838800.json"), "utf8"));
  const living10Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 10_1786620966268.json"), "utf8"));

  const images = [
    { name: "Rental 03.jpg", baseline: rental03Baseline, wallVis: rental03Raw.wallVis, oldZoning: rental03Raw.zoning },
    { name: "Living 07.jpg", baseline: living07Raw.baseline, wallVis: living07Raw.wallVis, oldZoning: living07Raw.zoning },
    { name: "Living 10.jpg", baseline: living10Raw.baseline, wallVis: living10Raw.wallVis, oldZoning: living10Raw.zoning },
  ];

  const results: any[] = [];
  for (const img of images) {
    console.log(`\n\n########## ${img.name} — re-running ZONING ONLY with v2 prompt ##########`);
    const imagePath = path.join(LIVING_DIR, img.name);
    const image = toBase64(imagePath);
    const newZoning = await callGemini(ZONING_SYSTEM_INSTRUCTION_V2, buildZoningUserPrompt(img.baseline), image);
    console.log("NEW ZONING:", JSON.stringify(newZoning, null, 2));

    const newPlan = planMultiAnchor(img.baseline, img.wallVis.walls || [], newZoning.zones || []);
    console.log("NEW PLAN:", JSON.stringify(newPlan, null, 2));

    const oldLivingZone = img.oldZoning.zones?.find((z: any) => z.purpose === "living");
    const newLivingZone = newZoning.zones?.find((z: any) => z.purpose === "living");
    const oldDepth = oldLivingZone?.floorRegion?.polygon ? (polygonBBox(oldLivingZone.floorRegion.polygon).maxY - polygonBBox(oldLivingZone.floorRegion.polygon).minY) : null;
    const newDepth = newLivingZone?.floorRegion?.polygon ? (polygonBBox(newLivingZone.floorRegion.polygon).maxY - polygonBBox(newLivingZone.floorRegion.polygon).minY) : null;
    console.log(`Living-zone depth proxy: OLD=${oldDepth?.toFixed(3)} NEW=${newDepth?.toFixed(3)}`);

    const compOverlayPath = path.join(LIVING_DIR, img.name.replace(/\.jpg$/i, "-zoning-before-after.png"));
    await renderZoneComparisonOverlay(imagePath, compOverlayPath, img.oldZoning.zones || [], newZoning.zones || []);
    console.log("comparison overlay saved:", compOverlayPath);

    results.push({ name: img.name, oldZoning: img.oldZoning, newZoning, oldDepth, newDepth, newPlan, compOverlayPath });
  }

  const outPath = path.join(REPO_ROOT, "tmp", `fix_zoning_and_depth_check_${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(results, null, 2));
  console.log("\n\n=== ALL DONE, saved:", outPath, "===");
}

main().catch((e) => {
  console.error("fix_zoning_and_depth_check failed:", e);
  process.exit(1);
});
