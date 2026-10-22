// PART 2 (standalone, no Gemini call): deterministic, rule-based staging
// layout planner. Consumes the real baseline extraction (openings/fixtures,
// captured earlier tonight) + Part 1's wall-visibility output, and produces
// a Stage2LayoutPlan-shaped object (reusing the real type from
// worker/src/pipeline/layoutPlanner.ts), extended with an inspectable
// `reasoning` block so the "why" is visible, not just the conclusion.
//
// Run twice — once against Part 1's run1 wall data, once against run2 — to
// check whether the FINAL decision is robust to the input instability found
// in Part 1, even though the underlying numbers are not.
import path from "path";
import fs from "fs/promises";
import type { Stage2LayoutPlan, AnchorItem } from "../worker/src/pipeline/layoutPlanner";

type UsableSegment = { range: [number, number]; widthFraction: number; description: string };
type Wall = {
  id: string;
  wallLabel: string;
  extent: { polygon: [number, number][] };
  openingIds: string[];
  usableWidthFraction: number;
  usableSegments: UsableSegment[];
  confidence: number;
};

// Real extractStructuralBaseline() output for Bedroom 12, captured earlier
// tonight — same object used as context in Part 1's script.
const KNOWN_BASELINE = {
  room_type: "bedroom",
  openings: [
    { id: "A1", type: "walkthrough", wallIndex: 0 },
    { id: "D1", type: "door", wallIndex: 3 },
  ],
  anchorFixtures: [{ id: "AC1", type: "ac_unit", wallIndex: 3 }],
};

// Explicit, labeled assumption — not derived from anything, called out as
// such in the report. A queen bed's footprint is assumed to need roughly a
// third of a typical bedroom wall's visible width to sit comfortably.
const MIN_USABLE_FRACTION_FOR_BED = 0.35;
const MIN_USABLE_FRACTION_FOR_NIGHTSTAND = 0.08;

type ExtendedPlan = Stage2LayoutPlan & {
  reasoning: {
    wallCandidates: Array<{
      wallId: string;
      wallLabel: string;
      usableWidthFraction: number;
      largestContiguousSegmentFraction: number;
      openingIds: string[];
      meetsMinBedThreshold: boolean;
    }>;
    selectedWallId: string;
    selectionReason: string;
    secondaryPlacementNotes: string[];
  };
};

function planStagingDeterministic(
  baseline: typeof KNOWN_BASELINE,
  walls: Wall[]
): ExtendedPlan {
  const anchorItem: AnchorItem = baseline.room_type === "bedroom" ? "bed" : "sofa_group";

  const wallCandidates = walls.map((wall) => {
    const largestSegment = wall.usableSegments.reduce((max, s) => Math.max(max, s.widthFraction), 0);
    return {
      wallId: wall.id,
      wallLabel: wall.wallLabel,
      usableWidthFraction: wall.usableWidthFraction,
      largestContiguousSegmentFraction: largestSegment,
      openingIds: wall.openingIds,
      meetsMinBedThreshold: largestSegment >= MIN_USABLE_FRACTION_FOR_BED,
    };
  });

  // Rank by LARGEST CONTIGUOUS segment, not total usable fraction — a wall
  // with usable space split into disconnected slivers can't actually fit a
  // bed even if the slivers sum to a large total.
  const ranked = [...wallCandidates].sort((a, b) => b.largestContiguousSegmentFraction - a.largestContiguousSegmentFraction);
  const qualifying = ranked.filter((w) => w.meetsMinBedThreshold);
  const selected = qualifying[0] || ranked[0];
  const usedFallback = qualifying.length === 0;

  const selectedWall = walls.find((w) => w.id === selected.wallId)!;
  const bestSegment = [...selectedWall.usableSegments].sort((a, b) => b.widthFraction - a.widthFraction)[0];

  const selectionReason = usedFallback
    ? `No wall had a single contiguous segment meeting the ${MIN_USABLE_FRACTION_FOR_BED} minimum-width assumption for a bed; selected ${selected.wallId} (${selected.wallLabel}) as the best available (largest contiguous segment ${selected.largestContiguousSegmentFraction.toFixed(3)}), flagged as a fallback, not a confident fit.`
    : `${selected.wallId} (${selected.wallLabel}) selected: largest contiguous usable segment is ${selected.largestContiguousSegmentFraction.toFixed(3)} ("${bestSegment.description}"), which meets the ${MIN_USABLE_FRACTION_FOR_BED} minimum-width assumption for a bed and exceeds every other candidate wall's largest segment (${ranked.slice(1).map((w) => `${w.wallId}=${w.largestContiguousSegmentFraction.toFixed(3)}`).join(", ") || "none"}).`;

  const anchorRegion = {
    x: Number(bestSegment.range[0].toFixed(3)),
    y: 0.35, // rough floor-to-mid vertical band; not derived from wall-visibility data (that data is horizontal-only)
    width: Number((bestSegment.range[1] - bestSegment.range[0]).toFixed(3)),
    height: 0.5,
  };

  const layout: Stage2LayoutPlan["layout"] = [
    {
      item: "Bed (Queen)",
      placement: `Against ${selectedWall.wallLabel} (${selectedWall.id}), centered within the clear segment described as "${bestSegment.description}".`,
    },
  ];

  const secondaryNotes: string[] = [];
  // Nightstands: only place within a segment big enough, on the SAME wall as
  // the bed if room remains, otherwise explicitly note it's skipped rather
  // than silently guessing.
  const remainingOnBedWall = selectedWall.usableSegments.filter((s) => s !== bestSegment && s.widthFraction >= MIN_USABLE_FRACTION_FOR_NIGHTSTAND);
  if (bestSegment.widthFraction >= MIN_USABLE_FRACTION_FOR_BED + 2 * MIN_USABLE_FRACTION_FOR_NIGHTSTAND) {
    layout.push({ item: "Nightstand (x2)", placement: `Flanking the bed within the same segment on ${selectedWall.id} (segment is wide enough to fit bed + two nightstands under the ${MIN_USABLE_FRACTION_FOR_NIGHTSTAND} per-nightstand assumption).` });
    secondaryNotes.push(`Nightstands placed in-segment: bed segment width ${bestSegment.widthFraction.toFixed(3)} exceeds bed+2*nightstand minimum (${(MIN_USABLE_FRACTION_FOR_BED + 2 * MIN_USABLE_FRACTION_FOR_NIGHTSTAND).toFixed(3)}).`);
  } else {
    secondaryNotes.push(`Nightstands NOT confidently placed in-segment: bed segment width ${bestSegment.widthFraction.toFixed(3)} does not clearly exceed bed+2*nightstand minimum (${(MIN_USABLE_FRACTION_FOR_BED + 2 * MIN_USABLE_FRACTION_FOR_NIGHTSTAND).toFixed(3)}) under this planner's simple width-sum assumption — reported as a gap rather than guessed.`);
  }

  // Other candidate wall(s): only place secondary/small items in segments
  // that clear the (smaller) nightstand-scale threshold; otherwise mark
  // explicitly as insufficient rather than forcing a placement.
  for (const wall of walls) {
    if (wall.id === selectedWall.id) continue;
    const wallLargest = wall.usableSegments.reduce((max, s) => Math.max(max, s.widthFraction), 0);
    if (wallLargest >= MIN_USABLE_FRACTION_FOR_NIGHTSTAND) {
      const seg = [...wall.usableSegments].sort((a, b) => b.widthFraction - a.widthFraction)[0];
      layout.push({ item: "Accent item (e.g. small chair or plant)", placement: `On ${wall.wallLabel} (${wall.id}), within the segment described as "${seg.description}" (width ${seg.widthFraction.toFixed(3)}).` });
      secondaryNotes.push(`${wall.id}: largest segment (${wallLargest.toFixed(3)}) clears the small-item threshold (${MIN_USABLE_FRACTION_FOR_NIGHTSTAND}) — assigned a small accent item only, not a bed-scale piece.`);
    } else {
      secondaryNotes.push(`${wall.id}: largest segment (${wallLargest.toFixed(3)}) does NOT clear even the small-item threshold (${MIN_USABLE_FRACTION_FOR_NIGHTSTAND}) — no furniture assigned to this wall by this planner.`);
    }
  }

  const avoidZones = [
    ...baseline.openings.map((o) => `${o.id}_(${o.type})_zone`),
    ...baseline.anchorFixtures.map((f) => `${f.id}_(${f.type})_zone`),
  ];

  return {
    room_type: baseline.room_type,
    layout,
    avoid_zones: avoidZones,
    anchorItem,
    anchorWall: selectedWall.wallLabel,
    anchorOrientation: "facing_camera",
    anchorConstraints: {
      allowWallMount: false,
      avoidAboveWindow: true,
      avoidCoveringWindows: true,
      mountMode: "freestanding",
      rules: [`centered_within_${selectedWall.id}_clear_segment`],
    },
    anchorRegion,
    anchorConfidence: usedFallback ? 0.3 : Math.min(selectedWall.confidence, 0.9),
    decorRestrictions: [
      { target: "door_zone", rule: `Do not place furniture over ${KNOWN_BASELINE.openings.find((o) => o.type === "door")?.id || "the door"}.` },
      { target: "anchor_wall", rule: `Do not place furniture over any opening/fixture zone on ${selectedWall.id}.` },
    ],
    furnitureVisibilityRules: { allow_crop: false, assume_wall_continuation: false, rules: [] },
    reasoning: {
      wallCandidates,
      selectedWallId: selected.wallId,
      selectionReason,
      secondaryPlacementNotes: secondaryNotes,
    },
  };
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const resultsFiles = (await fs.readdir(path.join(repoRoot, "tmp"))).filter((f) => f.startsWith("wall_visibility_results_"));
  if (resultsFiles.length === 0) {
    console.error("No wall_visibility_results_*.json found — run investigate_wall_visibility.ts first.");
    process.exit(1);
  }
  const latest = resultsFiles.sort().at(-1)!;
  const raw = JSON.parse(await fs.readFile(path.join(repoRoot, "tmp", latest), "utf8"));

  for (const runKey of ["run1", "run2"] as const) {
    const walls: Wall[] = raw[runKey]?.parsed?.walls;
    if (!walls) {
      console.log(`\n=== ${runKey}: no wall data available, skipping ===`);
      continue;
    }
    const plan = planStagingDeterministic(KNOWN_BASELINE, walls);
    console.log(`\n=== DETERMINISTIC PLAN using ${runKey} wall-visibility data ===`);
    console.log(JSON.stringify(plan, null, 2));
  }
}

main().catch((e) => {
  console.error("build_deterministic_layout_plan failed:", e);
  process.exit(1);
});
