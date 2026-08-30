// PART 1 (standalone, no Gemini call): extends the deterministic planner
// (tmp/build_deterministic_layout_plan.ts / _v2.ts from earlier tonight)
// with two new general-purpose reasoning steps that tonight's hand-authored
// v2 test proved were missing:
//
//   1. ORIENTATION — which way an anchor item with a natural "facing"
//      (bed, sofa) should point. Rule: prefer the room's real opening types
//      that bring in light/view (window, door) as the "focal feature" to
//      orient toward, over openings that are purely functional passages
//      (walkthrough, closet_door) — using the SAME StructuralOpeningType
//      enum already defined in production
//      (worker/src/validators/openingPreservationValidator.ts:8), not a
//      new invented type. Never orient toward a focal feature on the SAME
//      wall as the anchor item itself (you can't face something behind you).
//
//   2. FRAMING — whether the anchor item should be centered within the
//      visible portion of its wall, or allowed to sit naturally cropped at
//      the frame edge. Rule: if the SELECTED wall's own polygon extent
//      touches (or nearly touches) the image's left/right boundary, treat
//      that as evidence the wall continues off-frame, and explicitly permit
//      edge placement instead of forcing centering.
//
// Both rules are written in general form — no wall IDs or opening IDs are
// hard-coded — so they apply to any room, not just Bedroom 12.
//
// Also fixes a bug flagged (but not fixed) in the previous report: anchorRegion.x/width
// were being taken directly from a usable-segment's WALL-RELATIVE range
// (0=that wall's own left edge, 1=its own right edge) and used as if they
// were already FRAME-RELATIVE normalized coordinates. This produced a
// wrong anchorRegion whenever the selected wall doesn't itself span the
// full frame (obviously wrong once framing logic starts selecting narrow,
// edge-cropped walls). Fixed here by projecting the segment range through
// the wall's own polygon bounding box, same technique already used by the
// wall-visibility overlay-rendering code.
import path from "path";
import fs from "fs/promises";
import type { Stage2LayoutPlan, AnchorItem, AnchorOrientation } from "../worker/src/pipeline/layoutPlanner";
import type { StructuralOpeningType } from "../worker/src/validators/openingPreservationValidator";

type UsableSegment = { range: [number, number]; widthFraction: number; description: string };
type Point = [number, number];
type Wall = {
  id: string;
  wallLabel: string;
  extent: { polygon: Point[] };
  openingIds: string[];
  usableWidthFraction: number;
  usableSegments: UsableSegment[];
  confidence: number;
};
type BaselineOpening = { id: string; type: StructuralOpeningType; wallIndex: number };

// Real extractStructuralBaseline() output for Bedroom 12, captured earlier
// tonight — unchanged from the v1/v2 scripts, same IDs reused throughout.
const KNOWN_BASELINE = {
  room_type: "bedroom",
  openings: [
    { id: "A1", type: "walkthrough", wallIndex: 0 },
    { id: "D1", type: "door", wallIndex: 3 },
  ] as BaselineOpening[],
  anchorFixtures: [{ id: "AC1", type: "ac_unit", wallIndex: 3 }],
};

const MIN_USABLE_FRACTION_FOR_BED = 0.35;
const MIN_USABLE_FRACTION_FOR_NIGHTSTAND = 0.08;

// General rule, not room-specific: opening types that bring in outside
// light/view outrank openings that are purely a walkable passage, as
// candidates for "what the anchor item should face." Uses the real
// StructuralOpeningType enum values verbatim.
const FOCAL_OPENING_TYPE_PRIORITY: StructuralOpeningType[] = ["window", "door"];
const NON_FOCAL_OPENING_TYPES: StructuralOpeningType[] = ["walkthrough", "closet_door"];

// A wall's own polygon touching (or nearly touching) the image boundary is
// treated as evidence the wall continues past the frame edge. Generous
// epsilon chosen to tolerate the polygon-extraction imprecision already
// documented tonight (repeat runs disagree on exact wall boundaries by a
// few percent), rather than requiring an exact 0.000/1.000 touch.
const FRAME_EDGE_EPSILON = 0.03;

type OrientationReasoning = {
  focalFeatureId: string | null;
  focalFeatureType: StructuralOpeningType | null;
  focalFeatureWallIndex: number | null;
  rule: string;
};

type FramingReasoning = {
  wallTouchesFrameEdge: boolean;
  edgeSide: "left" | "right" | null;
  rule: string;
};

type ExtendedPlan = Stage2LayoutPlan & {
  anchorOrientation: AnchorOrientation | "foot_toward_focal_feature";
  anchorOrientationInstruction: string;
  anchorFramingInstruction: string;
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
    orientation: OrientationReasoning;
    framing: FramingReasoning;
  };
};

function wallBBox(wall: Wall) {
  const xs = wall.extent.polygon.map((p) => p[0]);
  const ys = wall.extent.polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// General-form orientation rule (no hard-coded room IDs): find the
// highest-priority focal opening type present in the baseline, preferring
// one that is NOT on the anchor item's own wall (facing a feature behind
// the item makes no physical sense).
function determineOrientation(
  baseline: typeof KNOWN_BASELINE,
  anchorWallIndex: number | null
): OrientationReasoning {
  for (const focalType of FOCAL_OPENING_TYPE_PRIORITY) {
    const candidates = baseline.openings.filter((o) => o.type === focalType);
    const offAnchorWall = candidates.filter((o) => o.wallIndex !== anchorWallIndex);
    const pick = offAnchorWall[0] || candidates[0];
    if (pick) {
      return {
        focalFeatureId: pick.id,
        focalFeatureType: pick.type,
        focalFeatureWallIndex: pick.wallIndex,
        rule:
          offAnchorWall.length > 0
            ? `Selected ${pick.id} (type="${pick.type}") as the orientation focal feature: it is the highest-priority focal opening type (${FOCAL_OPENING_TYPE_PRIORITY.join(" > ")}, ranked above passage-only types ${NON_FOCAL_OPENING_TYPES.join("/")}) that is NOT on the anchor item's own wall.`
            : `Selected ${pick.id} (type="${pick.type}") as the orientation focal feature: it is the highest-priority focal opening type available, though it is on the same wall as the anchor item (no off-wall focal opening existed) — flagged as a lower-confidence fallback.`,
      };
    }
  }
  return {
    focalFeatureId: null,
    focalFeatureType: null,
    focalFeatureWallIndex: null,
    rule: `No opening of a focal type (${FOCAL_OPENING_TYPE_PRIORITY.join("/")}) found in the baseline — defaulting to a generic "face into the room" orientation.`,
  };
}

// General-form framing rule (no hard-coded wall IDs): a wall's own polygon
// touching the frame boundary is evidence it is truncated by the camera
// frame, not that it physically ends there.
function determineFraming(wall: Wall): FramingReasoning {
  const { minX, maxX } = wallBBox(wall);
  const touchesLeft = minX <= FRAME_EDGE_EPSILON;
  const touchesRight = maxX >= 1 - FRAME_EDGE_EPSILON;
  if (touchesLeft || touchesRight) {
    const edgeSide: "left" | "right" = touchesRight ? "right" : "left";
    return {
      wallTouchesFrameEdge: true,
      edgeSide,
      rule: `${wall.id}'s extracted polygon touches the ${edgeSide} image boundary (x=${(edgeSide === "right" ? maxX : minX).toFixed(3)}, within ${FRAME_EDGE_EPSILON} of frame edge) — treated as evidence the wall continues past the frame. Edge-cropped placement is explicitly permitted instead of forcing the item to center within only the visible portion.`,
    };
  }
  return {
    wallTouchesFrameEdge: false,
    edgeSide: null,
    rule: `${wall.id}'s extracted polygon does not reach either image boundary (x range [${minX.toFixed(3)}, ${maxX.toFixed(3)}]) — the wall is assumed fully visible, so the item is centered within its widest usable segment.`,
  };
}

function planStagingDeterministic(baseline: typeof KNOWN_BASELINE, walls: Wall[]): ExtendedPlan {
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

  // Ranking logic UNCHANGED from tonight's earlier planner (out of scope for
  // this task) — still ranks by largest contiguous segment as a FRACTION OF
  // THE WALL'S OWN WIDTH, not translated into absolute frame-width. This is
  // a known, previously-flagged gap (see report): it can select a wall that
  // is 100% usable but only a sliver of the actual frame. Left unfixed here
  // deliberately — this task's scope is orientation + framing only.
  const ranked = [...wallCandidates].sort((a, b) => b.largestContiguousSegmentFraction - a.largestContiguousSegmentFraction);
  const qualifying = ranked.filter((w) => w.meetsMinBedThreshold);
  const selected = qualifying[0] || ranked[0];
  const usedFallback = qualifying.length === 0;

  const selectedWall = walls.find((w) => w.id === selected.wallId)!;
  const bestSegment = [...selectedWall.usableSegments].sort((a, b) => b.widthFraction - a.widthFraction)[0];
  const selectedWallIndex = Number(String(selectedWall.id).replace("wall_", ""));

  const selectionReason = usedFallback
    ? `No wall had a single contiguous segment meeting the ${MIN_USABLE_FRACTION_FOR_BED} minimum-width assumption for a bed; selected ${selected.wallId} (${selected.wallLabel}) as the best available (largest contiguous segment ${selected.largestContiguousSegmentFraction.toFixed(3)}), flagged as a fallback, not a confident fit.`
    : `${selected.wallId} (${selected.wallLabel}) selected: largest contiguous usable segment is ${selected.largestContiguousSegmentFraction.toFixed(3)} ("${bestSegment.description}"), which meets the ${MIN_USABLE_FRACTION_FOR_BED} minimum-width assumption for a bed and exceeds every other candidate wall's largest segment (${ranked.slice(1).map((w) => `${w.wallId}=${w.largestContiguousSegmentFraction.toFixed(3)}`).join(", ") || "none"}).`;

  // NEW: orientation reasoning.
  const orientation = determineOrientation(baseline, selectedWallIndex);
  const anchorOrientation: AnchorOrientation | "foot_toward_focal_feature" = orientation.focalFeatureId
    ? "foot_toward_focal_feature"
    : "facing_anchor_wall";
  const anchorOrientationInstruction = orientation.focalFeatureId
    ? `Orient the ${anchorItem} so its foot end points toward ${orientation.focalFeatureId} (the ${orientation.focalFeatureType} on wall_${orientation.focalFeatureWallIndex}) — NOT toward the camera. The camera should see the long side profile of the ${anchorItem}, not the headboard/footboard face-on.`
    : `No focal opening identified; orient the ${anchorItem} facing into the open floor area of the room.`;

  // NEW: framing reasoning.
  const framing = determineFraming(selectedWall);
  const anchorFramingInstruction = framing.wallTouchesFrameEdge
    ? `${selectedWall.id} is only partially visible in the frame (truncated at the ${framing.edgeSide} edge). Position the ${anchorItem} close to that edge — it is acceptable, even preferred, for part of the ${anchorItem} and wall to extend past the ${framing.edgeSide} edge of the photo, rather than centering the ${anchorItem} within only the visible portion of the wall.`
    : `${selectedWall.id} is fully visible in the frame. Center the ${anchorItem} within the widest usable segment described above.`;

  // Fixed: project the wall-relative segment range through the wall's own
  // polygon bounding box to get a FRAME-relative anchorRegion (previous
  // scripts used bestSegment.range directly as frame coordinates, which
  // was only coincidentally plausible when the selected wall happened to
  // span most of the frame).
  const { minX: wallMinX, maxX: wallMaxX, minY: wallMinY, maxY: wallMaxY } = wallBBox(selectedWall);
  const frameSegStartX = wallMinX + (wallMaxX - wallMinX) * bestSegment.range[0];
  const frameSegEndX = wallMinX + (wallMaxX - wallMinX) * bestSegment.range[1];
  const anchorRegion = {
    x: Number(frameSegStartX.toFixed(3)),
    y: 0.35,
    width: Number((frameSegEndX - frameSegStartX).toFixed(3)),
    height: 0.5,
  };
  void wallMinY;
  void wallMaxY;

  const layout: Stage2LayoutPlan["layout"] = [
    {
      item: "Bed (Queen)",
      placement: `Against ${selectedWall.wallLabel} (${selectedWall.id}), within the clear segment described as "${bestSegment.description}". ${anchorOrientationInstruction} ${anchorFramingInstruction}`,
    },
  ];

  const secondaryNotes: string[] = [];
  if (bestSegment.widthFraction >= MIN_USABLE_FRACTION_FOR_BED + 2 * MIN_USABLE_FRACTION_FOR_NIGHTSTAND) {
    layout.push({ item: "Nightstand (x2)", placement: `Flanking the bed within the same segment on ${selectedWall.id}.` });
    secondaryNotes.push(`Nightstands placed in-segment: bed segment width ${bestSegment.widthFraction.toFixed(3)} exceeds bed+2*nightstand minimum (${(MIN_USABLE_FRACTION_FOR_BED + 2 * MIN_USABLE_FRACTION_FOR_NIGHTSTAND).toFixed(3)}).`);
  } else {
    secondaryNotes.push(`Nightstands NOT confidently placed in-segment: bed segment width ${bestSegment.widthFraction.toFixed(3)} does not clearly exceed bed+2*nightstand minimum.`);
  }

  for (const wall of walls) {
    if (wall.id === selectedWall.id) continue;
    const wallLargest = wall.usableSegments.reduce((max, s) => Math.max(max, s.widthFraction), 0);
    if (wallLargest >= MIN_USABLE_FRACTION_FOR_NIGHTSTAND) {
      const seg = [...wall.usableSegments].sort((a, b) => b.widthFraction - a.widthFraction)[0];
      layout.push({ item: "Accent item (e.g. small chair or plant)", placement: `On ${wall.wallLabel} (${wall.id}), within the segment described as "${seg.description}" (width ${seg.widthFraction.toFixed(3)}).` });
      secondaryNotes.push(`${wall.id}: largest segment (${wallLargest.toFixed(3)}) clears the small-item threshold — assigned a small accent item only.`);
    } else {
      secondaryNotes.push(`${wall.id}: largest segment (${wallLargest.toFixed(3)}) does NOT clear the small-item threshold — no furniture assigned to this wall.`);
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
    anchorOrientation,
    anchorOrientationInstruction,
    anchorFramingInstruction,
    anchorConstraints: {
      allowWallMount: false,
      avoidAboveWindow: true,
      avoidCoveringWindows: true,
      mountMode: "freestanding",
      rules: [`centered_or_edge_cropped_within_${selectedWall.id}_clear_segment`],
    },
    anchorRegion,
    anchorConfidence: usedFallback ? 0.3 : Math.min(selectedWall.confidence, 0.9),
    decorRestrictions: [
      { target: "door_zone", rule: `Do not place furniture over ${KNOWN_BASELINE.openings.find((o) => o.type === "door")?.id || "the door"}.` },
      { target: "anchor_wall", rule: `Do not place furniture over any opening/fixture zone on ${selectedWall.id}.` },
    ],
    furnitureVisibilityRules: { allow_crop: framing.wallTouchesFrameEdge, assume_wall_continuation: framing.wallTouchesFrameEdge, rules: [] },
    reasoning: {
      wallCandidates,
      selectedWallId: selected.wallId,
      selectionReason,
      secondaryPlacementNotes: secondaryNotes,
      orientation,
      framing,
    },
  };
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const resultsFiles = (await fs.readdir(path.join(repoRoot, "tmp"))).filter((f) => f.startsWith("wall_visibility_v2_results_"));
  const latest = resultsFiles.sort().at(-1)!;
  const raw = JSON.parse(await fs.readFile(path.join(repoRoot, "tmp", latest), "utf8"));

  const plans: Record<string, ExtendedPlan> = {};
  for (const runKey of ["run1", "run2"] as const) {
    const walls: Wall[] = raw[runKey]?.parsed?.walls;
    if (!walls) continue;
    const plan = planStagingDeterministic(KNOWN_BASELINE, walls);
    plans[runKey] = plan;
    console.log(`\n=== EXTENDED DETERMINISTIC PLAN (orientation+framing) using ${runKey} wall data ===`);
    console.log(JSON.stringify(plan, null, 2));
  }

  const outPath = path.join(repoRoot, "tmp", `deterministic_plan_v3_${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(plans, null, 2));
  console.log("\n=== SAVED:", outPath, "===");
}

main().catch((e) => {
  console.error("build_deterministic_layout_plan_v3 failed:", e);
  process.exit(1);
});
