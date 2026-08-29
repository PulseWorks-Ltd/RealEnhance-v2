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

function makeWall(id: string, wallLabel: string, xRange: [number, number], openingIds: string[]): WallVisibilityWall {
  const [minX, maxX] = xRange;
  return {
    id,
    wallLabel,
    extent: { polygon: [[minX, 0.2], [maxX, 0.2], [maxX, 1], [minX, 1]] },
    openingIds,
    usableWidthFraction: 1,
    usableSegments: [{ range: [0, 1], widthFraction: 1, description: "Clear wall space." }],
    confidence: 0.95,
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
