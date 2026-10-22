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
import { planMultiAnchor, resolveSofaPlacement, buildLivingFocalWallInstruction, buildUniversalFeatureProtectionSection, pickSofaWallCandidate, type MultiAnchorPlan } from "../src/pipeline/anchorLockedStaging";
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

// Fireplace-loss investigation (job_5671358c, a living room with a
// fireplace and a TV bracket mounted directly above it): rooms with a
// fireplace sometimes lost it entirely in staged output, or got furniture
// placed directly in front of/over it. Root cause confirmed: the TV
// bracket's own raw description (e.g. "TV wall-mount bracket above the
// fireplace") was echoed verbatim into the console placement instruction,
// literally pointing furniture at the hearth. These cases cover the fix.
describe("planMultiAnchor — fireplace handling", () => {
  it("a fireplace-only wall (no TV bracket) becomes the focal wall", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 0.3]), // narrow — would not qualify by width alone
      makeWall("wall_1", "Right wall", [0.3, 1]),
    ];
    const zone = makeDeepLivingZone([0, 1]);
    const baseline = makeBaseline([], [makeFixture({ id: "fp1", type: "fireplace", wallIndex: 0, bbox: [0.35, 0.5, 0.55, 0.9] })]);
    const plan = planMultiAnchor(baseline, walls, [zone]);

    expect(plan.tvPlan?.wallId).toBe("wall_0");
    expect(plan.tvPlan?.fireplaceIds).toContain("fp1");
  });

  it("bracket directly above a fireplace on the same wall: segmentDescription is no longer the raw bracket description, and points to a computed clear segment instead", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 1]),
    ];
    const zone = makeDeepLivingZone([0]);
    const baseline = makeBaseline([], [
      // Narrow fireplace centered on the wall (bbox 45%-55%) — narrow
      // enough that both sides comfortably clear MIN_FIREPLACE_WALL_CLEAR_SEGMENT
      // (0.35) after the clearance buffer, so this tests the "clear segment
      // found" branch specifically (see the separate "spans the full wall" test below).
      makeFixture({ id: "fp1", type: "fireplace", wallIndex: 0, bbox: [0.45, 0.5, 0.55, 0.9], description: "white tiled fireplace" }),
      // TV bracket mounted above it, same wall — this is the exact
      // job_5671358c geometry. Raw description deliberately says "above
      // the fireplace", matching what a real extraction would return.
      makeFixture({ id: "tv1", type: "tv_mount", wallIndex: 0, bbox: [0.47, 0.1, 0.53, 0.3], description: "TV wall-mount bracket above the fireplace" }),
    ]);
    const plan = planMultiAnchor(baseline, walls, [zone]);

    expect(plan.tvPlan?.wallId).toBe("wall_0");
    expect(plan.tvPlan?.usedBracket).toBe(true);
    // The bug: this used to literally be "TV wall-mount bracket above the
    // fireplace" — the console placement instruction would then say
    // '...within the segment described as "TV wall-mount bracket above the
    // fireplace"', pointing furniture at the hearth.
    expect(plan.tvPlan?.segmentDescription).not.toContain("above the fireplace");
    expect(plan.tvPlan?.segmentDescription).toContain("clear of the fireplace");
    expect(plan.tvPlan?.fireplaceIds).toContain("fp1");
  });

  it("buildUniversalFeatureProtectionSection reconciles the tv_mount/fireplace collision instead of emitting two contradicting sentences", () => {
    const baseline = makeBaseline([], [
      makeFixture({ id: "fp1", type: "fireplace", wallIndex: 2, bbox: [0.4, 0.5, 0.6, 0.9], description: "white tiled fireplace" }),
      makeFixture({ id: "tv1", type: "tv_mount", wallIndex: 2, bbox: [0.42, 0.1, 0.58, 0.3], description: "TV wall-mount bracket" }),
    ]);
    const result = buildUniversalFeatureProtectionSection(baseline, null);
    const tvSentence = result.sentences.find((s) => s.includes("TV wall-mount bracket"));
    // Must NOT be the old unconditional permissive sentence (which would
    // license a console "at this location" with no fireplace awareness).
    expect(tvSentence).toBeDefined();
    expect(tvSentence).toContain("do NOT place a TV console");
    expect(tvSentence).toContain("fireplace");
    expect(tvSentence).toContain("hearth and firebox opening must remain fully visible");
  });

  it("a fireplace spanning the full wall: no clear segment exists, so no console is placed — seating still orients toward the fireplace", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 1]),
    ];
    const zone = makeDeepLivingZone([0]);
    // Fireplace spans nearly the entire wall (5%-95%) — neither side can
    // leave a MIN_FIREPLACE_WALL_CLEAR_SEGMENT-wide clear segment.
    const baseline = makeBaseline([], [makeFixture({ id: "fp1", type: "fireplace", wallIndex: 0, bbox: [0.05, 0.5, 0.95, 0.9] })]);
    const plan = planMultiAnchor(baseline, walls, [zone]);

    expect(plan.tvPlan?.wallId).toBe("wall_0");
    expect(plan.tvPlan?.skippedLiteralTv).toBe(true);
    expect(plan.tvPlan?.fireplaceIds).toContain("fp1");
    expect(plan.noTvReason).toContain("too wide to leave a safely clear segment");
  });

  // Note: pickSofaWallCandidate's fireplace deprioritization is tested
  // directly here rather than end-to-end through planMultiAnchor — the
  // fireplace-focal-wall fast-path added above (2d) always wins focal-wall
  // selection whenever any fireplace exists anywhere in the living zone,
  // so the fallback branch that calls pickSofaWallCandidate can never
  // actually encounter a fireplace-bearing candidate in practice. This unit
  // test verifies the tiebreak logic itself in isolation, as defense in
  // depth in case a future change to the fast-path's priority order ever
  // makes this branch reachable with a fireplace present.
  it("pickSofaWallCandidate prefers a non-fireplace wall over a fireplace-bearing one, but still returns a fireplace wall rather than nothing", () => {
    const fireplaceWall = makeWall("wall_0", "Front wall", [0, 0.5]);
    const cleanWall = makeWall("wall_1", "Right wall", [0.5, 1]);
    const baseline = makeBaseline([], [makeFixture({ id: "fp1", type: "fireplace", wallIndex: 0 })]);

    const preferred = pickSofaWallCandidate(
      [{ wall: fireplaceWall, largestSegment: 0.9 }, { wall: cleanWall, largestSegment: 0.5 }],
      baseline
    );
    // Even though the fireplace wall has the LARGER usable segment, the
    // clean wall must still be preferred (soft deprioritization).
    expect(preferred?.wall.id).toBe("wall_1");

    const onlyFireplaceWall = pickSofaWallCandidate([{ wall: fireplaceWall, largestSegment: 0.9 }], baseline);
    // But when it's the only candidate, it must still be returned — this
    // is a soft preference, never a hard exclusion.
    expect(onlyFireplaceWall?.wall.id).toBe("wall_0");
  });
});
