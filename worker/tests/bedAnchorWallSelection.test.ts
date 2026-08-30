// Regression tests for planBedroomAnchor's wall-selection tier logic
// (anchorLockedStaging.ts). planBedroomAnchor/selectAnchorWallByTier are
// pure, synchronous functions over already-extracted baseline/wall data —
// no Gemini calls, no mocking needed, real fixture data in, real decision
// out.
import { planBedroomAnchor } from "../src/pipeline/anchorLockedStaging";
import type { StructuralBaseline, StructuralOpening, AnchorFixture } from "../src/validators/openingPreservationValidator";
import type { WallVisibilityWall } from "../src/pipeline/anchorLockedStaging";

function makeWindow(overrides: Partial<StructuralOpening> & Pick<StructuralOpening, "id" | "bbox" | "wallIndex">): StructuralOpening {
  return {
    type: "window",
    area_pct: 5,
    horizontalBand: "center_third",
    verticalBand: "mid_zone",
    wallCoverageBand: "20-40",
    orientation: "landscape",
    paneStructure: "fixed_plus_opening",
    doorLeafState: "unknown",
    confidence: 0.95,
    wallPosition: "far_wall",
    relativeHorizontalPosition: "center",
    shape: "rectangle",
    touchesFloor: false,
    touchesCeiling: false,
    approxCount: 1,
    ...overrides,
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
  };
}

function makeWall(id: string, wallLabel: string, xRange: [number, number], openingIds: string[], usableWidthFraction = 1): WallVisibilityWall {
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

// A fixture-only wall (e.g. an AC unit or light fixture with no opening) —
// not blank (isBlank requires zero openings AND zero fixtures), not a
// window wall, not a door wall. This is what a genuine "return wall" looks
// like in real baseline data: something registered on it, just nothing
// that makes it a window or door candidate.
function makeFixture(overrides: Partial<AnchorFixture> & Pick<AnchorFixture, "id" | "wallIndex">): AnchorFixture {
  return {
    type: "ac_unit",
    horizontalBand: "center_third",
    bbox: [0.4, 0.05, 0.6, 0.15],
    confidence: 0.9,
    description: "Wall-mounted AC unit.",
    ...overrides,
  };
}

describe("planBedroomAnchor — wall eligibility must precede ranking (job_3a99aa08 regression)", () => {
  // Real geometry captured from job_3a99aa08's actual baseline extraction
  // (Furniture_Detector - Bedroom Image w Closets.jpg): a genuine but tiny
  // (9.1% of frame) blank return-wall sliver at the far left edge (wall_1),
  // a substantial (36% of frame) wall with a small, high-set window
  // (wall_3), and a substantial (40% of frame) wall with a large window
  // (wall_0). Before the frame-visible-width eligibility fix, wall_1 won
  // tier 1 outright — a wall-relative clear-segment score of 1.000 with no
  // floor on the wall's actual size in the photo. It must never win over
  // wall_3 again.
  const baseline: StructuralBaseline = {
    openings: [
      makeWindow({ id: "W2", wallIndex: 0, bbox: [0.505, 0.441, 0.824, 0.738], wallCoverageBand: "20-40" }),
      makeWindow({ id: "W1", wallIndex: 3, bbox: [0.034, 0.383, 0.444, 0.514], wallCoverageBand: "5-10", verticalBand: "ceiling_zone" }),
    ],
    anchorFixtures: [],
  };

  const walls: WallVisibilityWall[] = [
    makeWall("wall_0", "Back wall with large window", [0.449, 0.85], ["W2"]),
    makeWall("wall_1", "Foreground left wall section", [0, 0.091], []),
    makeWall("wall_2", "Right wall", [0.85, 1], []),
    makeWall("wall_3", "Left wall with high window", [0.091, 0.455], ["W1"]),
  ];

  it("does not select the 9.1%-of-frame blank return-wall sliver (wall_1)", () => {
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan).not.toBeNull();
    expect(plan!.anchorWallId).not.toBe("wall_1");
  });

  it("selects wall_3 — the substantial wall with the smaller, high-set window — over both the tiny sliver and the large-window wall", () => {
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_3");
    expect(plan!.selectionReason).toMatch(/^tier 2:/);
  });

  it("never lets a wall-relative clear-segment score of 1.000 alone qualify a wall below the frame-visibility floor", () => {
    // wall_1 and wall_2 both report a perfect largestSegment (1.000) via
    // their single full-width usableSegment, same as every other wall in
    // this fixture — the only thing that should disqualify them is their
    // real, tiny frameVisibleWidth (9.1% / 15% of the frame).
    const plan = planBedroomAnchor(baseline, walls);
    expect(["wall_0", "wall_3"]).toContain(plan!.anchorWallId);
  });
});

describe("planBedroomAnchor — door-wall clear-segment calculation", () => {
  // A room with only one substantial wall, and that wall has a door on it
  // (tier 4, last resort) — the doorway sits left-of-center, so the
  // computed clear segment should land to the right of it.
  const baseline: StructuralBaseline = {
    openings: [makeDoor({ id: "D1", wallIndex: 0, bbox: [0.1, 0.0, 0.3, 1.0] })],
    anchorFixtures: [],
  };
  const walls: WallVisibilityWall[] = [makeWall("wall_0", "Back wall with door", [0, 1], ["D1"])];

  it("selects the door wall (only candidate) and records the door id for the access-requirement prompt block", () => {
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan).not.toBeNull();
    expect(plan!.anchorWallId).toBe("wall_0");
    expect(plan!.anchorWallHasDoorOrWalkthrough).toBe(true);
    expect(plan!.doorAccessDoorIds).toEqual(["D1"]);
  });

  it("computes a clear segment to the right of the door, excluding the door plus its circulation buffer", () => {
    const plan = planBedroomAnchor(baseline, walls);
    // Door spans wall-relative [0.1, 0.3] (20% wide) with a 50%-of-door-width
    // buffer on each side -> exclusion zone [0.05, 0.35]. Remaining gaps:
    // left [0, 0.05] (too small), right [0.35, 1] (65% wide, wins).
    expect(plan!.anchorSegmentDescription).toMatch(/right of D1/);
    expect(plan!.selectionReason).toMatch(/door-clearance-computed segment/);
  });
});

// Concise scenario matrix requested as a standalone artifact — each row is
// a fresh, isolated baseline/walls fixture (not sharing state with the
// regression fixtures above), covering the tier hierarchy's cross-tier
// comparisons and the two eligibility floors (frame-visible width, and the
// wall-relative usable-segment fraction) independently of each other.
describe("planBedroomAnchor — wall selection scenario matrix", () => {
  it("tiny blank sliver + substantial window wall -> window wall wins", () => {
    const baseline: StructuralBaseline = {
      openings: [makeWindow({ id: "W1", wallIndex: 1, bbox: [0.2, 0.3, 0.5, 0.5], wallCoverageBand: "20-40" })],
      anchorFixtures: [],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Sliver", [0, 0.08], []),
      makeWall("wall_1", "Window wall", [0.08, 0.68], ["W1"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_1");
    expect(plan!.selectionReason).toMatch(/^tier 2:/);
  });

  it("tiny blank sliver + substantial blank wall -> blank wall wins", () => {
    const baseline: StructuralBaseline = { openings: [], anchorFixtures: [] };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Sliver", [0, 0.08], []),
      makeWall("wall_1", "Blank wall", [0.08, 0.78], []),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_1");
    expect(plan!.selectionReason).toMatch(/^tier 1:/);
  });

  it("two substantial window walls -> smaller/least intrusive opening wins", () => {
    const baseline: StructuralBaseline = {
      openings: [
        makeWindow({ id: "W1", wallIndex: 0, bbox: [0.1, 0.3, 0.4, 0.5], wallCoverageBand: "20-40" }),
        makeWindow({ id: "W2", wallIndex: 1, bbox: [0.6, 0.3, 0.7, 0.5], wallCoverageBand: "5-10" }),
      ],
      anchorFixtures: [],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Big window wall", [0, 0.5], ["W1"]),
      makeWall("wall_1", "Small window wall", [0.5, 1], ["W2"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_1");
    expect(plan!.selectionReason).toMatch(/^tier 2:/);
  });

  it("two substantial door walls + a genuine return wall -> the return wall wins", () => {
    const baseline: StructuralBaseline = {
      openings: [
        makeDoor({ id: "D1", wallIndex: 0, bbox: [0.1, 0, 0.25, 1] }),
        makeDoor({ id: "D2", wallIndex: 1, bbox: [0.4, 0, 0.55, 1] }),
      ],
      anchorFixtures: [makeFixture({ id: "AC1", wallIndex: 2, bbox: [0.7, 0.05, 0.85, 0.15] })],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Door wall A", [0, 0.33], ["D1"]),
      makeWall("wall_1", "Door wall B", [0.33, 0.66], ["D2"]),
      makeWall("wall_2", "Return wall", [0.66, 1], ["AC1"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_2");
    expect(plan!.selectionReason).toMatch(/^tier 3:/);
  });

  it("return wall vs window wall -> the window wall wins (best usable substantial wall)", () => {
    const baseline: StructuralBaseline = {
      openings: [makeWindow({ id: "W1", wallIndex: 1, bbox: [0.6, 0.3, 0.9, 0.5], wallCoverageBand: "20-40" })],
      anchorFixtures: [makeFixture({ id: "AC1", wallIndex: 0, bbox: [0.15, 0.05, 0.3, 0.15] })],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Return wall", [0, 0.4], ["AC1"]),
      makeWall("wall_1", "Window wall", [0.4, 1], ["W1"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_1");
    expect(plan!.selectionReason).toMatch(/^tier 2:/);
  });

  it("return wall vs door wall -> the return wall wins", () => {
    const baseline: StructuralBaseline = {
      openings: [makeDoor({ id: "D1", wallIndex: 1, bbox: [0.6, 0, 0.75, 1] })],
      anchorFixtures: [makeFixture({ id: "AC1", wallIndex: 0, bbox: [0.15, 0.05, 0.3, 0.15] })],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Return wall", [0, 0.5], ["AC1"]),
      makeWall("wall_1", "Door wall", [0.5, 1], ["D1"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_0");
    expect(plan!.selectionReason).toMatch(/^tier 3:/);
  });

  it("only door walls -> the best door wall is selected with mandatory clearance computed", () => {
    const baseline: StructuralBaseline = {
      openings: [
        makeDoor({ id: "D1", wallIndex: 0, bbox: [0.05, 0, 0.15, 1] }), // hinged, near-left
        makeDoor({ id: "D2", wallIndex: 1, bbox: [0.55, 0, 0.7, 1], paneStructure: "sliding_panel" }), // sliding
      ],
      anchorFixtures: [],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Hinged door wall", [0, 0.5], ["D1"]),
      makeWall("wall_1", "Sliding door wall", [0.5, 1], ["D2"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    // Sliding door preferred over hinged within tier 4.
    expect(plan!.anchorWallId).toBe("wall_1");
    expect(plan!.selectionReason).toMatch(/^tier 4 \(last resort\):/);
    expect(plan!.doorAccessDoorIds).toEqual(["D2"]);
  });

  // Real production feedback (job_15b17d81, 2026-08-30): a return wall
  // that failed the old 0.25/new 0.20 floor was discarded outright, forcing
  // the plan onto a door wall — which reliably produced a hard validator
  // fail downstream (Gemini covering or infilling the door). Explicit
  // product direction: prefer even a fairly marginal (>= 0.15) non-door
  // wall over ANY door wall.
  it("door-avoidance rescue (tier 3.5): a marginal 18%-of-frame return wall beats an available door wall", () => {
    const baseline: StructuralBaseline = {
      openings: [makeDoor({ id: "D1", wallIndex: 1, bbox: [0.2, 0, 0.35, 1] })],
      anchorFixtures: [makeFixture({ id: "AC1", wallIndex: 0, bbox: [0.4, 0.05, 0.6, 0.15] })],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Marginal return wall", [0, 0.18], ["AC1"]), // 18% of frame — below the 0.20 main floor, above the 0.15 rescue floor
      makeWall("wall_1", "Door wall", [0.18, 1], ["D1"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_0");
    expect(plan!.selectionReason).toMatch(/^tier 3\.5 \(door-avoidance rescue\):/);
  });

  it("door-avoidance rescue (tier 3.5): a marginal blank wall still beats a marginal plain return wall, same priority order as tiers 1-3", () => {
    const baseline: StructuralBaseline = {
      openings: [makeDoor({ id: "D1", wallIndex: 2, bbox: [0.7, 0, 0.85, 1] })],
      anchorFixtures: [makeFixture({ id: "AC1", wallIndex: 1, bbox: [0.4, 0.05, 0.5, 0.15] })],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Marginal blank wall", [0, 0.17], []), // blank, 17% of frame
      makeWall("wall_1", "Marginal return wall", [0.17, 0.35], ["AC1"]), // plain, 18% of frame
      makeWall("wall_2", "Door wall", [0.35, 1], ["D1"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_0");
    expect(plan!.selectionReason).toMatch(/^tier 3\.5 \(door-avoidance rescue\):/);
  });

  it("below even the door-avoidance floor (< 15%) AND not touching a frame edge, a door wall is still selected as genuine last resort", () => {
    // wall_1 (the marginal return wall) deliberately sits in the MIDDLE of
    // the frame, touching neither edge — it must fail both the door-
    // avoidance floor (12% < 15%) AND the crop-rescue's frame-edge test,
    // unlike the crop-rescue tests below where the marginal wall starts at
    // the frame's own edge (x=0) and is croppable regardless of width.
    const baseline: StructuralBaseline = {
      openings: [
        makeDoor({ id: "D1", wallIndex: 0, bbox: [0.05, 0, 0.2, 1] }),
        makeDoor({ id: "D2", wallIndex: 2, bbox: [0.7, 0, 0.85, 1] }),
      ],
      anchorFixtures: [makeFixture({ id: "AC1", wallIndex: 1, bbox: [0.46, 0.05, 0.5, 0.15] })],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Door wall (left)", [0, 0.44], ["D1"]),
      makeWall("wall_1", "Too-thin, non-edge return wall", [0.44, 0.56], ["AC1"]), // 12% of frame, touches neither edge
      makeWall("wall_2", "Door wall (right)", [0.56, 1], ["D2"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallHasDoorOrWalkthrough).toBe(true);
    expect(plan!.faceDoorWallCropMode).toBe(false);
    expect(plan!.selectionReason).toMatch(/^tier 4 \(last resort\):/);
  });

  it("door+window wall vs window-only wall -> the window-only wall wins", () => {
    const baseline: StructuralBaseline = {
      openings: [
        makeWindow({ id: "W1", wallIndex: 0, bbox: [0.05, 0.3, 0.2, 0.5], wallCoverageBand: "20-40" }),
        makeDoor({ id: "D1", wallIndex: 0, bbox: [0.3, 0, 0.4, 1] }),
        makeWindow({ id: "W2", wallIndex: 1, bbox: [0.6, 0.3, 0.8, 0.5], wallCoverageBand: "20-40" }),
      ],
      anchorFixtures: [],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Door+window wall", [0, 0.5], ["W1", "D1"]),
      makeWall("wall_1", "Window-only wall", [0.5, 1], ["W2"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_1");
    expect(plan!.selectionReason).toMatch(/^tier 2:/);
  });

  it("a wall at exactly the 20% frame-visibility boundary is accepted, not incorrectly rejected", () => {
    const baseline: StructuralBaseline = { openings: [], anchorFixtures: [] };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Just-too-narrow blank wall", [0, 0.19], []), // 19% — below floor
      makeWall("wall_1", "Exactly-at-floor blank wall", [0.2, 0.4], []), // exactly 20%
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan).not.toBeNull();
    expect(plan!.anchorWallId).toBe("wall_1");
    expect(plan!.selectionReason).toMatch(/^tier 1:/);
  });

  it("a wall over 25% of frame with a poor wall-relative usable segment does not win on frame size alone", () => {
    const baseline: StructuralBaseline = { openings: [], anchorFixtures: [] };
    const walls: WallVisibilityWall[] = [
      // 50% of frame width, but only 15% of ITS OWN span is actually clear
      // (e.g. built-in joinery/an irregular alcove the wall-visibility
      // extraction accounted for in usableSegments without it being a
      // registered baseline opening/fixture) — still technically "blank"
      // by isBlank's opening/fixture count, but not usable.
      makeWall("wall_0", "Wide but mostly unusable wall", [0, 0.5], [], 0.15),
      // Only 30% of frame width, but fully clear.
      makeWall("wall_1", "Narrower but fully usable wall", [0.55, 0.85], [], 1),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallId).toBe("wall_1");
    expect(plan!.selectionReason).toMatch(/^tier 1:/);
  });
});

// Real production feedback (job_15b17d81, 2026-08-30, follow-up): staging
// directly against a door wall reliably produces a hard validator fail
// (Gemini covers or infills the door). When even the door-avoidance rescue
// (tier 3.5) finds nothing, prefer anchoring to a frame-edge wall — gated
// by only a permissive MIN_CROP_RESCUE_FRAME_VISIBLE_WIDTH (0.05), per
// explicit product direction: a photo framed to leave only a sliver of
// non-door wall visible is a framing limitation, not a reason to fall back
// to a door wall. A follow-up regression (job_9f092878, real 9%-of-frame
// wall) confirmed the actual failure mode isn't "the wall was too narrow"
// but "the model wasn't told which direction the overflow must go" — fixed
// in buildFaceAwayFromDoorInstructionSection, not by rejecting narrow
// walls. The floor only exists to reject near-zero/likely-noise
// measurements (covered separately further down).
describe("planBedroomAnchor — door-avoidance crop rescue (face the door wall, don't anchor to it)", () => {
  it("anchors to a frame-edge wall and orients the bed to face the door wall, instead of anchoring to the door wall itself", () => {
    const baseline: StructuralBaseline = {
      openings: [makeDoor({ id: "D1", wallIndex: 1, bbox: [0.3, 0, 0.45, 1] })],
      anchorFixtures: [],
    };
    const walls: WallVisibilityWall[] = [
      // Touches the left frame edge (minX = 0) — croppable, and clears the
      // 0.05 crop-rescue floor (13%) while still failing both the 0.20 and
      // 0.15 floors above it.
      makeWall("wall_0", "Sliver wall at frame edge", [0, 0.13], []),
      makeWall("wall_1", "Door wall", [0.13, 1], ["D1"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan).not.toBeNull();
    expect(plan!.anchorWallId).toBe("wall_0");
    expect(plan!.anchorWallHasDoorOrWalkthrough).toBe(false);
    expect(plan!.faceDoorWallCropMode).toBe(true);
    expect(plan!.cropDirection).toBe("left");
    expect(plan!.facingDoorWallDoorIds).toEqual(["D1"]);
    expect(plan!.selectionReason).toMatch(/door-wall touch avoided/);
    // The orientation instruction must point at the door being faced, not
    // a generic "no focal opening" fallback or an unrelated window.
    expect(plan!.anchorOrientationInstruction).toContain("D1");
  });

  it("job_9f092878's real geometry (9%-of-frame sliver wall): the crop rescue now DOES use it — a real, non-noise sliver beats touching a door wall, per explicit product direction", () => {
    // Real captured geometry: wall_2 ("Far-right wall") measured 0.090
    // frame-visible width, touching the right frame edge, with wall_1 (a
    // frameless walkthrough) immediately to its left. The 0.090 case
    // originally hard-failed because the generated bed bled the wrong way
    // (left, into the walkthrough) — fixed not by rejecting this wall
    // (MIN_CROP_RESCUE_FRAME_VISIBLE_WIDTH is deliberately permissive, see
    // its own comment) but by buildFaceAwayFromDoorInstructionSection's
    // explicit overflow-direction and corner-crossing instructions below.
    const baseline: StructuralBaseline = {
      openings: [
        makeDoor({ id: "SD1", wallIndex: 0, bbox: [0.02, 0, 0.35, 1], paneStructure: "sliding_panel" }),
        makeDoor({ id: "A1", wallIndex: 1, bbox: [0.55, 0, 0.91, 1] }),
      ],
      anchorFixtures: [],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Front wall (sliding door)", [0, 0.55], ["SD1"]),
      makeWall("wall_1", "Right wall (walkthrough)", [0.55, 0.91], ["A1"]),
      makeWall("wall_2", "Far-right wall", [0.91, 1], []), // 9% of frame, touches right edge
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan).not.toBeNull();
    expect(plan!.faceDoorWallCropMode).toBe(true);
    expect(plan!.anchorWallId).toBe("wall_2");
    expect(plan!.anchorWallHasDoorOrWalkthrough).toBe(false);
    expect(plan!.cropDirection).toBe("right");
  });

  it("a near-zero measurement (1%, plausibly an extraction artifact) still falls through to genuine tier 4", () => {
    const baseline: StructuralBaseline = {
      openings: [makeDoor({ id: "D1", wallIndex: 0, bbox: [0.02, 0, 0.35, 1] })],
      anchorFixtures: [],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Door wall", [0, 0.99], ["D1"]),
      makeWall("wall_1", "Sliver wall", [0.99, 1], []), // 1% of frame — below even the 0.05 floor
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.faceDoorWallCropMode).toBe(false);
    expect(plan!.anchorWallHasDoorOrWalkthrough).toBe(true);
    expect(plan!.anchorWallId).toBe("wall_0");
  });

  it("does not fire when the anchor wall has no door at all (tiers 1-3.5 already succeeded)", () => {
    const baseline: StructuralBaseline = { openings: [], anchorFixtures: [] };
    const walls: WallVisibilityWall[] = [makeWall("wall_0", "Blank wall", [0, 0.5], [])];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.faceDoorWallCropMode).toBe(false);
    expect(plan!.facingDoorWallDoorIds).toBeNull();
  });

  it("falls back to genuine tier 4 (anchored to the door wall) when no other wall touches a frame edge either", () => {
    // Both non-door walls sit in the middle of the frame, touching
    // neither edge — nothing is croppable, so the crop rescue must not
    // apply and the door wall itself must be selected as last resort.
    const baseline: StructuralBaseline = {
      openings: [
        makeDoor({ id: "D1", wallIndex: 0, bbox: [0.02, 0, 0.15, 1] }),
        makeDoor({ id: "D2", wallIndex: 2, bbox: [0.85, 0, 0.98, 1] }),
      ],
      anchorFixtures: [],
    };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Door wall (left, touches left edge)", [0, 0.45], ["D1"]),
      // 10% of frame, touching neither edge — must fail the crop rescue's
      // edge test (and, incidentally, both frame-visibility floors too).
      makeWall("wall_1", "Middle wall (touches neither edge)", [0.45, 0.55], []),
      makeWall("wall_2", "Door wall (right, touches right edge)", [0.55, 1], ["D2"]),
    ];
    const plan = planBedroomAnchor(baseline, walls);
    expect(plan!.anchorWallHasDoorOrWalkthrough).toBe(true);
    expect(plan!.faceDoorWallCropMode).toBe(false);
  });
});
