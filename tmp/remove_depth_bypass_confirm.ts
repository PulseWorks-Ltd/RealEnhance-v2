// Part 1: remove the depth-proxy bypass from planMultiAnchor(). When the
// sanity check fires (input looks implausible relative to the candidate
// wall's frame-height), the fallback is now the SAME as every other check
// in this pipeline: no placement, noTvReason set, sanity-check reasoning
// still logged as diagnostic context (not silently discarded, just no
// longer overriding the outcome).
//
// Reuses the SAVED zoning results from the last task
// (tmp/fix_zoning_and_depth_check_*.json) — zero new Gemini calls, per
// "confirm directly, don't assume" on data that already exists.
import fs from "fs/promises";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..");

function polygonBBox(polygon: [number, number][]) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const MIN_USABLE_FRACTION_FOR_ANCHOR = 0.35;
const TV_MIN_USABLE_FRACTION = 0.2;
const MIN_ZONE_DEPTH_FOR_TV_FACING = 0.25;
const WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO = 0.3;
const FOCAL_OPENING_TYPE_PRIORITY = ["window", "door"] as const;

// ── planMultiAnchor, corrected: sanity-check firing no longer bypasses the
// depth rejection — it only adds diagnostic reasoning to the (still
// negative) outcome. Everything else unchanged from the last task. ──
function planMultiAnchor(baseline: any, walls: any[], zones: any[]) {
  const livingZone = zones.find((z: any) => z.purpose === "living");
  const diningZone = zones.find((z: any) => z.purpose === "dining");
  const reasoning: string[] = [];

  let diningPlan: any = null;
  if (diningZone?.floorRegion?.polygon?.length >= 3) {
    const n = diningZone.floorRegion.polygon.length;
    const centroid: [number, number] = [
      diningZone.floorRegion.polygon.reduce((s: number, p: number[]) => s + p[0], 0) / n,
      diningZone.floorRegion.polygon.reduce((s: number, p: number[]) => s + p[1], 0) / n,
    ];
    const bbox = polygonBBox(diningZone.floorRegion.polygon);
    diningPlan = { center: centroid, footprint: { halfWidth: Math.min(0.12, (bbox.maxX - bbox.minX) * 0.35), halfHeight: Math.min(0.08, (bbox.maxY - bbox.minY) * 0.3) }, reasoning: `Table centered within zone_dining (centroid [${centroid[0].toFixed(3)}, ${centroid[1].toFixed(3)}]).` };
  }

  let tvPlan: any = null;
  let noTvReason: string | null = null;
  let sofaPlan: any = null;
  let sanityCheckFired = false;
  let sanityCheckNote: string | null = null;

  if (livingZone) {
    const livingWallIndices: number[] = livingZone.borderingWallIndices || [];
    const otherZonesWallIndices = new Set<number>(zones.filter((z: any) => z.id !== livingZone.id).flatMap((z: any) => z.borderingWallIndices || []));
    const exclusiveLivingWallIndices = livingWallIndices.filter((idx) => !otherZonesWallIndices.has(idx));
    const wallByIndex = (idx: number) => walls.find((w: any) => Number(String(w.id).replace("wall_", "")) === idx);

    const zoneBBox = livingZone.floorRegion?.polygon ? polygonBBox(livingZone.floorRegion.polygon) : null;
    const zoneDepthProxy = zoneBBox ? zoneBBox.maxY - zoneBBox.minY : 0;
    const depthOk = zoneDepthProxy >= MIN_ZONE_DEPTH_FOR_TV_FACING;
    reasoning.push(`Living zone floor-region depth proxy: ${zoneDepthProxy.toFixed(3)} (threshold ${MIN_ZONE_DEPTH_FOR_TV_FACING}) — ${depthOk ? "sufficient" : "insufficient"}.`);

    const tvCandidatesRaw = exclusiveLivingWallIndices
      .map((idx) => wallByIndex(idx))
      .filter(Boolean)
      .map((w: any) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
      .filter((c) => c.largestSegment >= TV_MIN_USABLE_FRACTION)
      .sort((a, b) => b.largestSegment - a.largestSegment);

    // Sanity check retained as DIAGNOSTIC ONLY — no longer overrides depthOk.
    if (!depthOk && tvCandidatesRaw[0]) {
      const wallBBoxTop = polygonBBox(tvCandidatesRaw[0].wall.extent.polygon);
      const wallHeightInFrame = wallBBoxTop.maxY - wallBBoxTop.minY;
      const implausible = zoneDepthProxy < WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO * wallHeightInFrame;
      sanityCheckNote = `Depth-proxy sanity check: candidate wall ${tvCandidatesRaw[0].wall.id} frame-height ${wallHeightInFrame.toFixed(3)}; zone depth (${zoneDepthProxy.toFixed(3)}) is ${implausible ? "BELOW" : "at/above"} ${WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO} x wall-height (${(WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO * wallHeightInFrame).toFixed(3)}) — ${implausible ? "flagged as likely-unreliable input, logged for diagnostic visibility; the check still resolves to no-TV, same as every other failed check in this pipeline" : "no anomaly detected"}.`;
      reasoning.push(sanityCheckNote);
      if (implausible) sanityCheckFired = true;
      // NOTE: depthOk is NOT set to true here anymore. This is the fix.
    }

    const tvCandidate = depthOk ? tvCandidatesRaw[0] : undefined;

    if (tvCandidate) {
      const seg = [...(tvCandidate.wall.usableSegments || [])].sort((a: any, b: any) => b.widthFraction - a.widthFraction)[0];
      tvPlan = { wallId: tvCandidate.wall.id, wallLabel: tvCandidate.wall.wallLabel, segmentDescription: seg?.description, largestSegment: tvCandidate.largestSegment, reasoning: `TV wall selected: ${tvCandidate.wall.id} (${tvCandidate.wall.wallLabel}) is zone-exclusive, clears TV width threshold (${tvCandidate.largestSegment.toFixed(3)} >= ${TV_MIN_USABLE_FRACTION}), zone depth sufficient.` };
      reasoning.push(tvPlan.reasoning);

      const sofaCandidates = livingWallIndices
        .map((idx) => wallByIndex(idx)).filter(Boolean).filter((w: any) => w.id !== tvCandidate.wall.id)
        .map((w: any) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
        .filter((c) => c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR).sort((a, b) => b.largestSegment - a.largestSegment);
      sofaPlan = sofaCandidates[0]
        ? { wallId: sofaCandidates[0].wall.id, wallLabel: sofaCandidates[0].wall.wallLabel, facingWallId: tvCandidate.wall.id, reasoning: `Sofa placed against ${sofaCandidates[0].wall.id}, facing ${tvCandidate.wall.id}.` }
        : { wallId: null, floorCentered: true, facingWallId: tvCandidate.wall.id, reasoning: `No other living-zone wall qualified; sofa floor-centered, facing ${tvCandidate.wall.id}.` };
      reasoning.push(sofaPlan.reasoning);
    } else {
      noTvReason = exclusiveLivingWallIndices.length === 0
        ? "no TV placed — no wall is exclusive to the living zone (all bordering walls are shared with another zone)"
        : tvCandidatesRaw.length === 0
        ? "no TV placed — no zone-exclusive wall clears the minimum usable-width threshold for a TV"
        : sanityCheckFired
        ? "no TV placed — living zone floor depth reading failed AND the sanity check flagged it as likely unreliable; treated as a failed check like any other, not overridden"
        : "no TV placed — living zone floor depth is insufficient for a sofa to face a TV at a plausible distance";
      reasoning.push(noTvReason);

      const sofaCandidates = livingWallIndices
        .map((idx) => wallByIndex(idx)).filter(Boolean)
        .map((w: any) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0) }))
        .filter((c) => c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR).sort((a, b) => b.largestSegment - a.largestSegment);
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

  return { diningPlan, tvPlan, noTvReason, sofaPlan, reasoning, livingZone, diningZone, sanityCheckFired };
}

async function main() {
  const dataPath = path.join(REPO_ROOT, "tmp/fix_zoning_and_depth_check_1786621860530.json");
  const results: any[] = JSON.parse(await fs.readFile(dataPath, "utf8"));

  for (const r of results) {
    console.log(`\n########## ${r.name} — re-planned with bypass REMOVED ##########`);
    const oldOutcome = r.newPlan.tvPlan ? `TV on ${r.newPlan.tvPlan.wallId}` : `NO TV (${r.newPlan.noTvReason})`;
    console.log("Previous outcome (with bypass):", oldOutcome, "| depthCheckFlaggedSuspect was:", r.newPlan.depthCheckFlaggedSuspect);

    // Need walls + baseline again; walls unchanged (from wallVis, not saved
    // in this file directly — reload from the original per-image sources).
    let baseline: any, walls: any[];
    if (r.name === "Rental 03.jpg") {
      const raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/openplan_zoning_1786613150664.json"), "utf8"));
      walls = raw.wallVis.walls;
      baseline = {
        openings: [
          { id: "A1", type: "walkthrough", wallIndex: 0 }, { id: "W2", type: "window", wallIndex: 0 },
          { id: "W3", type: "window", wallIndex: 1 }, { id: "W1", type: "window", wallIndex: 3 },
        ],
      };
    } else {
      const raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, `tmp/validate_${r.name.replace(".jpg", "")}_${r.name.includes("07") ? "1786620838800" : "1786620966268"}.json`), "utf8"));
      walls = raw.wallVis.walls;
      baseline = raw.baseline;
    }

    const newPlan = planMultiAnchor(baseline, walls, r.newZoning.zones || []);
    const newOutcome = newPlan.tvPlan ? `TV on ${newPlan.tvPlan.wallId}` : `NO TV (${newPlan.noTvReason})`;
    console.log("New outcome (bypass removed):", newOutcome, "| sanityCheckFired:", newPlan.sanityCheckFired);
    console.log("Match previous outcome (TV placed/not, same wall if placed):", oldOutcome.startsWith("TV") === newOutcome.startsWith("TV") && (!newPlan.tvPlan || newPlan.tvPlan.wallId === r.newPlan.tvPlan?.wallId) ? "YES — no-op confirmed" : "*** CHANGED ***");
  }
}

main().catch((e) => {
  console.error("remove_depth_bypass_confirm failed:", e);
  process.exit(1);
});
