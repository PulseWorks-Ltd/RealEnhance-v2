// Open-plan living/dining: CORRECTED TV-wall selection (v2 of
// tmp/investigate_openplan_zoning.ts). Targeted fix only — reuses the
// already-captured real wall-visibility + zoning extraction data verbatim
// (tmp/openplan_zoning_1786613150664.json), makes ZERO new Gemini calls.
// Only the deterministic multi-anchor planning logic changes.
//
// Bug being fixed: the v1 rule picked whichever living-zone-bordering wall
// had the largest raw usable-width number, with no check for whether that
// wall was exclusive to the living zone or shared with another zone. It
// picked wall_0 — the model's own label: "Dining area wall with
// walkthrough" — visually confirmed via overlay as a bad TV location.
//
// New rule (see tmp/openplan_zoning_design.md's "Multi-anchor coherence"
// section for the original design this refines):
//   1. TV candidate wall must be EXCLUSIVE to the living zone — excluded by
//      construction (filtered out of the candidate pool entirely) if it
//      also borders any other zone, not just penalized in scoring.
//   2. That wall must clear a TV-specific usable-width threshold (narrower
//      than the bed/sofa threshold — a TV console is narrower than a bed
//      or 3-seat sofa) AND the living zone's own floor region must have
//      enough depth (a simple bbox-extent proxy on the zone's floorRegion
//      polygon, NOT true 3D depth reasoning) for a sofa to plausibly sit
//      back and face it.
//   3. If no wall clears both checks, "no TV" is a first-class, explicit
//      output field (noTvReason), not an inferred absence.
//   4. Sofa orientation, when no TV: reuses bedroom's exact tiered
//      fallback pattern (planBedroomAnchor's determineOrientation) — face
//      a focal opening (window > door) in the living zone if one exists,
//      preferring one not on the sofa's own wall; otherwise "face into the
//      open room" as the final generic default.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";

const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const IMAGE_PATH = path.join(OUT_DIR, "Rental 03.jpg");
const EXISTING_DATA_PATH = path.join(REPO_ROOT, "tmp/openplan_zoning_1786613150664.json");

type Point = [number, number];

// Same real baseline used in the v1 prototype, unchanged.
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

// ── Thresholds ──
const MIN_USABLE_FRACTION_FOR_ANCHOR = 0.35; // sofa / bed-scale item against a wall (unchanged, proven in bedroom)
const TV_MIN_USABLE_FRACTION = 0.2; // narrower than a sofa — a TV console doesn't need as much clear wall
const MIN_ZONE_DEPTH_FOR_TV_FACING = 0.25; // simple bbox-extent proxy on the zone's floorRegion polygon, not true 3D depth
const FOCAL_OPENING_TYPE_PRIORITY = ["window", "door"] as const;

async function main() {
  const raw = JSON.parse(await fs.readFile(EXISTING_DATA_PATH, "utf8"));
  const walls: any[] = raw.wallVis.walls;
  const zones: any[] = raw.zoning.zones;
  const kitchenSignal = raw.zoning.kitchenSignal;
  const livingZone = zones.find((z) => z.purpose === "living");
  const diningZone = zones.find((z) => z.purpose === "dining");

  console.log("=== Reusing existing extraction data (zero new Gemini calls) ===");
  console.log("Source:", EXISTING_DATA_PATH);

  const reasoning: string[] = [];

  // ── Dining table (unchanged from v1 — not in scope for this fix) ──
  let diningPlan: any = null;
  if (diningZone?.floorRegion?.polygon?.length >= 3) {
    const centroid = polygonCentroid(diningZone.floorRegion.polygon);
    const bbox = polygonBBox(diningZone.floorRegion.polygon);
    diningPlan = {
      center: centroid,
      footprint: { halfWidth: Math.min(0.12, (bbox.maxX - bbox.minX) * 0.35), halfHeight: Math.min(0.08, (bbox.maxY - bbox.minY) * 0.3) },
      reasoning: `Table centered within zone_dining's floor region (centroid [${centroid[0].toFixed(3)}, ${centroid[1].toFixed(3)}]), inset from bordering walls for chair clearance.`,
    };
  }

  // ── TV-wall selection (THE FIX) ──
  let tvPlan: any = null;
  let noTvReason: string | null = null;
  let sofaPlan: any = null;

  if (livingZone) {
    const livingWallIndices: number[] = livingZone.borderingWallIndices || [];
    const otherZonesWallIndices = new Set<number>(
      zones.filter((z) => z.id !== livingZone.id).flatMap((z) => z.borderingWallIndices || [])
    );

    // Check 1: zone-exclusivity — excluded by construction, not scored.
    const exclusiveLivingWallIndices = livingWallIndices.filter((idx) => !otherZonesWallIndices.has(idx));
    const sharedLivingWallIndices = livingWallIndices.filter((idx) => otherZonesWallIndices.has(idx));
    reasoning.push(
      `Living zone borders wall indices [${livingWallIndices.join(", ")}]. Zone-exclusive: [${exclusiveLivingWallIndices.join(", ") || "none"}]. Shared with another zone (excluded from TV candidacy by construction): [${sharedLivingWallIndices.join(", ") || "none"}].`
    );

    const wallByIndex = (idx: number) => walls.find((w: any) => Number(String(w.id).replace("wall_", "")) === idx);

    // Check 2: TV-specific usable-width threshold + zone-depth proxy, only
    // evaluated against the zone-exclusive pool from Check 1.
    const zoneDepthProxy = livingZone.floorRegion?.polygon
      ? polygonBBox(livingZone.floorRegion.polygon).maxY - polygonBBox(livingZone.floorRegion.polygon).minY
      : 0;
    const depthOk = zoneDepthProxy >= MIN_ZONE_DEPTH_FOR_TV_FACING;
    reasoning.push(`Living zone floor-region depth proxy (bbox y-extent): ${zoneDepthProxy.toFixed(3)} (threshold ${MIN_ZONE_DEPTH_FOR_TV_FACING}) — ${depthOk ? "sufficient" : "insufficient"} for a sofa to sit back and face a TV.`);

    const tvCandidates = exclusiveLivingWallIndices
      .map((idx) => wallByIndex(idx))
      .filter(Boolean)
      .map((w: any) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
      .filter((c) => c.largestSegment >= TV_MIN_USABLE_FRACTION)
      .sort((a, b) => b.largestSegment - a.largestSegment);

    const tvCandidate = depthOk ? tvCandidates[0] : undefined;

    if (tvCandidate) {
      const seg = [...(tvCandidate.wall.usableSegments || [])].sort((a: any, b: any) => b.widthFraction - a.widthFraction)[0];
      tvPlan = {
        wallId: tvCandidate.wall.id,
        wallLabel: tvCandidate.wall.wallLabel,
        segmentDescription: seg?.description,
        largestSegment: tvCandidate.largestSegment,
        reasoning: `TV wall selected: ${tvCandidate.wall.id} (${tvCandidate.wall.wallLabel}) is zone-exclusive to living (not shared with dining), clears the TV usable-width threshold (${tvCandidate.largestSegment.toFixed(3)} >= ${TV_MIN_USABLE_FRACTION}), and the zone has sufficient floor depth for a facing sofa.`,
      };
      reasoning.push(tvPlan.reasoning);

      // Sofa: a different living-zone wall (exclusivity not required for the
      // sofa itself, only for the TV) with the standard anchor threshold.
      const sofaCandidates = livingWallIndices
        .map((idx) => wallByIndex(idx))
        .filter(Boolean)
        .filter((w: any) => w.id !== tvCandidate.wall.id)
        .map((w: any) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
        .filter((c) => c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR)
        .sort((a, b) => b.largestSegment - a.largestSegment);

      if (sofaCandidates[0]) {
        sofaPlan = {
          wallId: sofaCandidates[0].wall.id,
          wallLabel: sofaCandidates[0].wall.wallLabel,
          facingWallId: tvCandidate.wall.id,
          reasoning: `Sofa placed against ${sofaCandidates[0].wall.id} (${sofaCandidates[0].wall.wallLabel}), a different living-zone wall from the TV, oriented to face ${tvCandidate.wall.id} directly.`,
        };
      } else {
        sofaPlan = {
          wallId: null,
          floorCentered: true,
          facingWallId: tvCandidate.wall.id,
          reasoning: `No other living-zone wall cleared the sofa anchor threshold, so the sofa is floor-centered within the living zone, still oriented to face ${tvCandidate.wall.id}.`,
        };
      }
      reasoning.push(sofaPlan.reasoning);
    } else {
      noTvReason = !depthOk
        ? "no TV placed — living zone floor depth is insufficient for a sofa to face a TV at a plausible distance"
        : exclusiveLivingWallIndices.length === 0
        ? "no TV placed — no wall is exclusive to the living zone (all bordering walls are shared with another zone)"
        : "no TV placed — no zone-exclusive wall clears the minimum usable-width threshold for a TV";
      reasoning.push(noTvReason);
      console.log(`\nNO TV: ${noTvReason}`);

      // Sofa orientation fallback, tiered exactly like bedroom's
      // determineOrientation: focal opening (window > door) in the living
      // zone, preferring one not on the sofa's own wall; else generic.
      const sofaCandidates = livingWallIndices
        .map((idx) => wallByIndex(idx))
        .filter(Boolean)
        .map((w: any) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
        .filter((c) => c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR)
        .sort((a, b) => b.largestSegment - a.largestSegment);

      const sofaWall = sofaCandidates[0]?.wall || null;
      const sofaWallIndex = sofaWall ? Number(String(sofaWall.id).replace("wall_", "")) : null;

      let focalFeatureId: string | null = null;
      let focalFeatureType: string | null = null;
      let focalFeatureWallIndex: number | null = null;
      for (const focalType of FOCAL_OPENING_TYPE_PRIORITY) {
        const candidates = KNOWN_BASELINE.openings.filter((o) => o.type === focalType && livingWallIndices.includes(o.wallIndex));
        const offSofaWall = candidates.filter((o) => o.wallIndex !== sofaWallIndex);
        const pick = offSofaWall[0] || candidates[0];
        if (pick) {
          focalFeatureId = pick.id;
          focalFeatureType = pick.type;
          focalFeatureWallIndex = pick.wallIndex;
          break;
        }
      }
      const orientationInstruction = focalFeatureId
        ? `Orient the sofa to face toward ${focalFeatureId} (the ${focalFeatureType} on wall_${focalFeatureWallIndex}) — the living zone's focal opening.`
        : `No focal opening identified in the living zone; orient the sofa facing into the open floor area of the room.`;

      sofaPlan = sofaWall
        ? { wallId: sofaWall.id, wallLabel: sofaWall.wallLabel, facingWallId: null, orientationInstruction, reasoning: `Sofa placed against ${sofaWall.id} (${sofaWall.wallLabel}) — no TV to face, so orientation falls back to the tiered focal-opening rule. ${orientationInstruction}` }
        : { wallId: null, floorCentered: true, facingWallId: null, orientationInstruction, reasoning: `No living-zone wall cleared the sofa anchor threshold either; sofa is floor-centered. ${orientationInstruction}` };
      reasoning.push(sofaPlan.reasoning);
    }
  } else {
    reasoning.push("No living zone returned by zoning extraction — TV/sofa plan skipped.");
  }

  const plan = { kitchenSignal, zones: zones.map((z: any) => ({ id: z.id, purpose: z.purpose, borderingWallIndices: z.borderingWallIndices })), diningPlan, tvPlan, noTvReason, sofaPlan, reasoning };
  console.log("\n=== CORRECTED PLAN ===");
  console.log(JSON.stringify(plan, null, 2));

  // ── Overlay (same style as v1) ──
  const meta = await sharp(IMAGE_PATH).metadata();
  const width = meta.width!, height = meta.height!;
  const svgParts: string[] = [];
  const zoneColors: Record<string, string> = { living: "rgba(0,120,255,0.25)", dining: "rgba(255,140,0,0.25)" };
  for (const z of zones) {
    if (!z.floorRegion?.polygon) continue;
    svgParts.push(`<polygon points="${denormPolygon(z.floorRegion.polygon, width, height)}" fill="${zoneColors[z.purpose] || "rgba(150,150,150,0.25)"}" stroke="black" stroke-width="3" stroke-dasharray="10,6"/>`);
    const c = polygonCentroid(z.floorRegion.polygon);
    svgParts.push(`<text x="${Math.round(c[0] * width)}" y="${Math.round(c[1] * height)}" font-size="30" font-weight="bold" fill="black" text-anchor="middle">${z.id}</text>`);
  }
  if (kitchenSignal?.present && kitchenSignal.openingId) {
    const opening = KNOWN_BASELINE.openings.find((o) => o.id === kitchenSignal.openingId);
    if (opening) {
      const [x1, y1, x2, y2] = opening.bbox;
      svgParts.push(`<rect x="${x1 * width}" y="${y1 * height}" width="${(x2 - x1) * width}" height="${(y2 - y1) * height}" fill="none" stroke="red" stroke-width="6"/>`);
      svgParts.push(`<text x="${((x1 + x2) / 2) * width}" y="${y1 * height - 12}" font-size="26" font-weight="bold" fill="red" text-anchor="middle">KITCHEN SIGNAL (${opening.id}, conf ${kitchenSignal.confidence})</text>`);
    }
  }
  if (diningPlan) {
    const [cx, cy] = diningPlan.center;
    const { halfWidth, halfHeight } = diningPlan.footprint;
    svgParts.push(`<rect x="${(cx - halfWidth) * width}" y="${(cy - halfHeight) * height}" width="${halfWidth * 2 * width}" height="${halfHeight * 2 * height}" fill="rgba(139,69,19,0.6)" stroke="black" stroke-width="3"/>`);
    svgParts.push(`<text x="${cx * width}" y="${cy * height}" font-size="24" font-weight="bold" fill="white" text-anchor="middle">DINING TABLE</text>`);
  }
  function segmentToFrameX(wall: any, seg: any) {
    const bbox = polygonBBox(wall.extent.polygon);
    return { x1: bbox.minX + (bbox.maxX - bbox.minX) * seg.range[0], x2: bbox.minX + (bbox.maxX - bbox.minX) * seg.range[1], minY: bbox.minY, maxY: bbox.maxY };
  }
  if (tvPlan) {
    const wall = walls.find((w: any) => w.id === tvPlan.wallId);
    const seg = wall?.usableSegments?.find((s: any) => s.description === tvPlan.segmentDescription) || wall?.usableSegments?.[0];
    if (wall && seg) {
      const { x1, x2, maxY } = segmentToFrameX(wall, seg);
      const tvY1 = maxY * 0.65, tvY2 = maxY * 0.85;
      svgParts.push(`<rect x="${x1 * width}" y="${tvY1 * height}" width="${(x2 - x1) * width}" height="${(tvY2 - tvY1) * height}" fill="rgba(0,0,0,0.7)" stroke="lime" stroke-width="3"/>`);
      svgParts.push(`<text x="${((x1 + x2) / 2) * width}" y="${((tvY1 + tvY2) / 2) * height}" font-size="22" font-weight="bold" fill="lime" text-anchor="middle">TV</text>`);
    }
  } else if (noTvReason) {
    svgParts.push(`<text x="${width * 0.02}" y="${height * 0.06}" font-size="26" font-weight="bold" fill="red">NO TV PLACED: ${noTvReason}</text>`);
  }
  if (sofaPlan?.wallId) {
    const wall = walls.find((w: any) => w.id === sofaPlan.wallId);
    const seg = wall?.usableSegments?.[0];
    if (wall && seg) {
      const { x1, x2, maxY } = segmentToFrameX(wall, seg);
      const sofaY1 = maxY * 0.7, sofaY2 = maxY;
      svgParts.push(`<rect x="${x1 * width}" y="${sofaY1 * height}" width="${(x2 - x1) * width}" height="${(sofaY2 - sofaY1) * height}" fill="rgba(80,40,150,0.6)" stroke="black" stroke-width="3"/>`);
      svgParts.push(`<text x="${((x1 + x2) / 2) * width}" y="${((sofaY1 + sofaY2) / 2) * height}" font-size="22" font-weight="bold" fill="white" text-anchor="middle">SOFA</text>`);
    }
  } else if (sofaPlan?.floorCentered && livingZone) {
    const c = polygonCentroid(livingZone.floorRegion.polygon);
    svgParts.push(`<rect x="${(c[0] - 0.1) * width}" y="${(c[1] - 0.05) * height}" width="${0.2 * width}" height="${0.1 * height}" fill="rgba(80,40,150,0.6)" stroke="black" stroke-width="3"/>`);
    svgParts.push(`<text x="${c[0] * width}" y="${c[1] * height}" font-size="22" font-weight="bold" fill="white" text-anchor="middle">SOFA (floor-centered)</text>`);
  }
  // Facing-direction arrow, when there's a wall-to-wall facing relationship.
  if (sofaPlan?.wallId && sofaPlan.facingWallId) {
    const sofaWall = walls.find((w: any) => w.id === sofaPlan.wallId);
    const facingWall = walls.find((w: any) => w.id === sofaPlan.facingWallId);
    if (sofaWall && facingWall) {
      const c1 = polygonCentroid(sofaWall.extent.polygon);
      const c2 = polygonCentroid(facingWall.extent.polygon);
      svgParts.push(`<line x1="${c1[0] * width}" y1="${c1[1] * height}" x2="${c2[0] * width}" y2="${c2[1] * height}" stroke="yellow" stroke-width="4" stroke-dasharray="12,8" marker-end="url(#arrow)"/>`);
    }
  }

  const overlayLayer = await sharp(Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgParts.join("\n")}</svg>`)).png().toBuffer();
  const overlayBuffer = await sharp(IMAGE_PATH).composite([{ input: overlayLayer, blend: "over" }]).png().toBuffer();
  const overlayPath = path.join(OUT_DIR, "Rental 03-openplan-zoning-overlay-v2.png");
  await sharp(overlayBuffer).toFile(overlayPath);
  console.log("\noverlay saved:", overlayPath);

  const outPath = path.join(REPO_ROOT, "tmp", `openplan_zoning_v2_${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(plan, null, 2));
  console.log("=== SAVED:", outPath, "===");
}

main().catch((e) => {
  console.error("investigate_openplan_zoning_v2 failed:", e);
  process.exit(1);
});
