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
    expect(plan!.selectionReason).toMatch(/^tier 4:/);
    expect(plan!.doorAccessDoorIds).toEqual(["D2"]);
    // Mandatory clearance: D2 sits wall-relative [0.1, 0.4] on wall_1
    // (bbox [0.55,0.7] minus wall_1's own [0.5,1] origin), so the
    // computed segment must exclude it, not just report the wall's own
    // generic "Clear wall space" default.
    expect(plan!.anchorSegmentDescription).not.toBe("Clear wall space.");
    expect(plan!.anchorSegmentDescription).toMatch(/right of D2/);
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

  it("a wall at exactly the 25% frame-visibility boundary is accepted, not incorrectly rejected", () => {
    const baseline: StructuralBaseline = { openings: [], anchorFixtures: [] };
    const walls: WallVisibilityWall[] = [
      makeWall("wall_0", "Just-too-narrow blank wall", [0, 0.2], []), // 20% — below floor
      makeWall("wall_1", "Exactly-at-floor blank wall", [0.2, 0.45], []), // exactly 25%
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
