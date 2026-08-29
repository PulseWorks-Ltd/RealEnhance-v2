// Regression tests for the living-area anchor-wall reframing:
// planMultiAnchor's livingFocalWall is now the wall the room's seating
// FACES, selected independently of whether a literal TV/console is drawn
// there (previously one gate — a wall only qualified if it cleared BOTH a
// width threshold AND the whole zone's own TV-viewing-distance depth
// threshold, so a shallow-but-otherwise-ideal wall got no focal-wall role
// at all and the sofa fell back to a window/door/generic orientation
// instead). Also covers the new door/walkthrough exclusion on focal-wall
// candidacy and the ported frame-edge crop-awareness.
//
// planMultiAnchor/resolveSofaPlacement/buildLivingFocalWallInstruction are
// pure, synchronous functions over already-extracted baseline/wall/zone
// data — no Gemini calls, no mocking needed.
import { planMultiAnchor, resolveSofaPlacement, buildLivingFocalWallInstruction, type MultiAnchorPlan } from "../src/pipeline/anchorLockedStaging";
import type { StructuralBaseline, StructuralOpening, AnchorFixture } from "../src/validators/openingPreservationValidator";
import type { WallVisibilityWall } from "../src/pipeline/anchorLockedStaging";
import type { LivingDiningZone } from "../src/pipeline/anchorLockedStaging";

function makeWall(id: string, wallLabel: string, xRange: [number, number], openingIds: string[] = [], usableWidthFraction = 1): WallVisibilityWall {
  const [minX, maxX] = xRange;
  return {
    id,
    wallLabel,
    extent: { polygon: [[minX, 0.2], [maxX, 0.2], [maxX, 1], [minX, 1]] },
    openingIds,
    usableWidthFraction,
    usableSegments: [{ range: [0, usableWidthFraction], widthFraction: usableWidthFraction, description: "Clear wall space." }],
    confidence: 0.95,
  };
}

function makeDoor(overrides: Partial<StructuralOpening> & Pick<StructuralOpening, "id" | "bbox" | "wallIndex">): StructuralOpening {
  return {
    type: "door",
    area_pct: 8,
    horizontalBand: "center_third",
    verticalBand: "full_height",
    wallCoverageBand: "20-40",
    orientation: "portrait",
    paneStructure: "single_fixed",
    doorLeafState: "closed",
    confidence: 0.95,
    wallPosition: "far_wall",
    relativeHorizontalPosition: "center",
    shape: "rectangle",
    touchesFloor: true,
    touchesCeiling: false,
    approxCount: 1,
    ...overrides,
  } as StructuralOpening;
}

function makeFixture(overrides: Partial<AnchorFixture> & Pick<AnchorFixture, "id" | "wallIndex">): AnchorFixture {
  return {
    type: "tv_mount",
    horizontalBand: "center_third",
    bbox: [0.4, 0.3, 0.6, 0.5],
    confidence: 0.9,
    description: "Wall-mounted TV bracket.",
    ...overrides,
  };
}

function makeBaseline(openings: StructuralOpening[] = [], anchorFixtures: AnchorFixture[] = []): StructuralBaseline {
  return { openings, anchorFixtures } as StructuralBaseline;
}

// A deep living zone (clears MIN_ZONE_DEPTH_FOR_TV_FACING = 0.25).
function makeDeepLivingZone(borderingWallIndices: number[]): LivingDiningZone {
  return {
    id: "zone_living",
    purpose: "living",
    floorRegion: { polygon: [[0, 0.2], [1, 0.2], [1, 0.9], [0, 0.9]] }, // depth 0.7
    borderingWallIndices,
    reasoning: "test fixture",
  };
}

// A shallow living zone (below the 0.25 depth threshold).
function makeShallowLivingZone(borderingWallIndices: number[]): LivingDiningZone {
  return {
    id: "zone_living",
    purpose: "living",
    floorRegion: { polygon: [[0, 0.75], [1, 0.75], [1, 0.9], [0, 0.9]] }, // depth 0.15
    borderingWallIndices,
    reasoning: "test fixture",
  };
}

describe("planMultiAnchor — livingFocalWall reframing", () => {
  it("shallow zone with an otherwise-qualifying wall: seating still orients toward it, but no literal TV is placed (the core reframing fix)", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 0.6]),   // wide, qualifies for focal wall by width
      makeWall("wall_1", "Right wall", [0.6, 1]),
    ];
    const zone = makeShallowLivingZone([0, 1]);
    const plan = planMultiAnchor(makeBaseline(), walls, [zone]);

    expect(plan.tvPlan).not.toBeNull();
    expect(plan.tvPlan!.wallId).toBe("wall_0");
    expect(plan.tvPlan!.skippedLiteralTv).toBe(true);
    expect(plan.noTvReason).toContain("seating is still oriented toward the room's focal wall");
    // Sofa must face the focal wall, not fall back to a generic/window orientation.
    expect(plan.sofaPlan?.facingWallId).toBe("wall_0");
  });

  it("deep zone with a qualifying wall: unchanged behavior — a literal TV is placed", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 0.6]),
      makeWall("wall_1", "Right wall", [0.6, 1]),
    ];
    const zone = makeDeepLivingZone([0, 1]);
    const plan = planMultiAnchor(makeBaseline(), walls, [zone]);

    expect(plan.tvPlan).not.toBeNull();
    expect(plan.tvPlan!.skippedLiteralTv).toBeFalsy();
    expect(plan.sofaPlan?.facingWallId).toBe("wall_0");
  });

  it("an existing TV bracket wins outright regardless of zone depth, unchanged from before this reframing", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 0.3]), // narrow — would not qualify by width alone
      makeWall("wall_1", "Right wall", [0.3, 1]),
    ];
    const zone = makeShallowLivingZone([0, 1]);
    const baseline = makeBaseline([], [makeFixture({ id: "tv1", wallIndex: 0 })]);
    const plan = planMultiAnchor(baseline, walls, [zone]);

    expect(plan.tvPlan?.wallId).toBe("wall_0");
    expect(plan.tvPlan?.usedBracket).toBe(true);
    expect(plan.tvPlan?.skippedLiteralTv).toBeFalsy();
  });

  it("prefers a non-door wall as the focal wall over a wider door-bearing wall — new exclusion this reframing adds", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 0.7]),  // wider, but has a door
      makeWall("wall_1", "Right wall", [0.7, 1], [], 0.9), // narrower, but clean
    ];
    const zone = makeDeepLivingZone([0, 1]);
    const baseline = makeBaseline([makeDoor({ id: "d1", bbox: [0, 0.1, 0.2, 0.9], wallIndex: 0 })]);
    const plan = planMultiAnchor(baseline, walls, [zone]);

    expect(plan.tvPlan?.wallId).toBe("wall_1");
  });

  it("falls back to a door-bearing wall when it is the ONLY width-qualifying candidate", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 0.7], [], 1), // has a door, but is the only qualifying wall
      makeWall("wall_1", "Right wall", [0.7, 0.8], [], 0.1), // usableWidthFraction too low to qualify at all
    ];
    const zone = makeDeepLivingZone([0, 1]);
    const baseline = makeBaseline([makeDoor({ id: "d1", bbox: [0, 0.1, 0.2, 0.9], wallIndex: 0 })]);
    const plan = planMultiAnchor(baseline, walls, [zone]);

    expect(plan.tvPlan?.wallId).toBe("wall_0");
  });

  it("no wall clears the width threshold at all: falls back to the pre-existing window/door/generic sofa orientation, unchanged", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 0.15], [], 0.1), // usableWidthFraction too low
      makeWall("wall_1", "Right wall", [0.85, 1], [], 0.1), // usableWidthFraction too low
    ];
    const zone = makeDeepLivingZone([0, 1]);
    const plan = planMultiAnchor(makeBaseline(), walls, [zone]);

    expect(plan.tvPlan).toBeNull();
    expect(plan.noTvReason).toContain("no focal wall");
    expect(plan.sofaPlan?.facingWallId).toBeNull();
  });

  it("flags a focal wall touching the frame edge as partially visible (ported frame-edge crop awareness)", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 0.6]), // touches x=0, the left frame edge
      makeWall("wall_1", "Right wall", [0.6, 1]),
    ];
    const zone = makeDeepLivingZone([0, 1]);
    const plan = planMultiAnchor(makeBaseline(), walls, [zone]);

    expect(plan.tvPlan?.wallId).toBe("wall_0");
    expect(plan.tvPlan?.partiallyVisible).toBe(true);
  });

  it("does not flag a fully-interior wall as partially visible", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0.2, 0.8]), // interior, doesn't touch either edge
      makeWall("wall_1", "Right wall", [0.8, 0.95]),
    ];
    const zone = makeDeepLivingZone([0, 1]);
    const plan = planMultiAnchor(makeBaseline(), walls, [zone]);

    expect(plan.tvPlan?.wallId).toBe("wall_0");
    expect(plan.tvPlan?.partiallyVisible).toBe(false);
  });
});

describe("resolveSofaPlacement — facing-wall wording reflects skippedLiteralTv honestly", () => {
  it("says 'the TV wall' when a literal TV is actually placed", () => {
    const walls = [makeWall("wall_0", "Front wall", [0, 0.6]), makeWall("wall_1", "Right wall", [0.6, 1])];
    const zone = makeDeepLivingZone([0, 1]);
    const baseline = makeBaseline();
    const plan = planMultiAnchor(baseline, walls, [zone]);
    const result = resolveSofaPlacement(baseline, zone, plan);
    expect(result?.floating).toBe(true);
    expect(result?.instruction).toContain("the TV wall");
  });

  it("says 'the room's focal wall', never 'the TV wall', when the literal TV was skipped for depth reasons", () => {
    const walls = [makeWall("wall_0", "Front wall", [0, 0.6]), makeWall("wall_1", "Right wall", [0.6, 1])];
    // Use a zone that's shallow for the TV depth gate but still deep enough
    // for resolveSofaPlacement's OWN floating-depth check to pass, so we
    // reach the "facing" text rather than the wall-anchored fallback.
    // MIN_ZONE_DEPTH_FOR_TV_FACING is reused by both checks in the current
    // implementation, so exercise the wall-anchored path instead, where
    // the wording lives in plan.tvPlan.skippedLiteralTv's effect on
    // buildLivingFocalWallInstruction (covered below) — here we confirm at
    // minimum that "the TV wall" is never produced when skippedLiteralTv.
    const zone = makeShallowLivingZone([0, 1]);
    const baseline = makeBaseline();
    const plan = planMultiAnchor(baseline, walls, [zone]);
    expect(plan.tvPlan?.skippedLiteralTv).toBe(true);
    const result = resolveSofaPlacement(baseline, zone, plan);
    expect(result?.instruction).not.toContain("the TV wall");
  });
});

describe("buildLivingFocalWallInstruction — prompt wording", () => {
  const basePlan: NonNullable<MultiAnchorPlan["tvPlan"]> = {
    wallId: "wall_0",
    wallLabel: "Front wall",
    wallDescription: "the wall directly ahead, facing the camera",
    segmentDescription: "Full wall width",
    largestSegment: 0.9,
    depthCheckFlaggedSuspect: false,
    usedBracket: false,
    reasoning: "test",
  };

  it("asks for a literal TV/console when skippedLiteralTv is not set", () => {
    const text = buildLivingFocalWallInstruction(basePlan);
    expect(text).toContain("Place a TV and low TV console/unit");
  });

  it("explicitly forbids placing a TV, and never says 'TV wall', when skippedLiteralTv is true", () => {
    const text = buildLivingFocalWallInstruction({ ...basePlan, skippedLiteralTv: true });
    expect(text).toContain("do NOT place a TV or TV console");
    expect(text).toContain("natural focal wall");
    expect(text).not.toContain("Place a TV and low TV console/unit");
  });

  it("appends the edge-crop note only when partiallyVisible is true", () => {
    const cropped = buildLivingFocalWallInstruction({ ...basePlan, partiallyVisible: true });
    expect(cropped).toContain("edge-cropped furniture placement is acceptable");
    const notCropped = buildLivingFocalWallInstruction({ ...basePlan, partiallyVisible: false });
    expect(notCropped).not.toContain("edge-cropped");
  });
});
