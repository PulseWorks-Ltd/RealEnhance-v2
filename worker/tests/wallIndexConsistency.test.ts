// Regression tests for diagnoseWallIndexConsistency (LD2 diagnostic —
// anchorLockedStaging.ts). Pure, synchronous function over already-
// extracted baseline/wall data — no Gemini calls, no mocking needed.
import { diagnoseWallIndexConsistency } from "../src/pipeline/anchorLockedStaging";
import type { StructuralBaseline, StructuralOpening } from "../src/validators/openingPreservationValidator";
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
  } as StructuralOpening;
}

function makeWall(id: string, openingIds: string[]): WallVisibilityWall {
  return {
    id,
    wallLabel: `Wall ${id}`,
    extent: { polygon: [[0, 0.2], [1, 0.2], [1, 1], [0, 1]] },
    openingIds,
    usableWidthFraction: 0.8,
    usableSegments: [{ range: [0, 0.8], widthFraction: 0.8, description: "Clear wall space." }],
    confidence: 0.95,
  };
}

function makeBaseline(openings: StructuralOpening[]): StructuralBaseline {
  return { openings } as StructuralBaseline;
}

describe("diagnoseWallIndexConsistency (LD2 diagnostic)", () => {
  it("reports consistent when every wall's self-reported openingIds agrees with the baseline's own wallIndex for those openings", () => {
    const baseline = makeBaseline([
      makeWindow({ id: "window_A", bbox: [0.1, 0.3, 0.3, 0.6], wallIndex: 0 }),
      makeWindow({ id: "window_B", bbox: [0.1, 0.3, 0.3, 0.6], wallIndex: 1 }),
    ]);
    const walls = [
      makeWall("wall_0", ["window_A"]),
      makeWall("wall_1", ["window_B"]),
    ];

    const report = diagnoseWallIndexConsistency(baseline, walls);
    expect(report.consistent).toBe(true);
    expect(report.mismatches).toHaveLength(0);
  });

  it("reports consistent for a genuinely blank wall with no openings claimed and none expected", () => {
    const baseline = makeBaseline([
      makeWindow({ id: "window_A", bbox: [0.1, 0.3, 0.3, 0.6], wallIndex: 0 }),
    ]);
    const walls = [
      makeWall("wall_0", ["window_A"]),
      makeWall("wall_1", []), // blank wall, correctly claims nothing
    ];

    const report = diagnoseWallIndexConsistency(baseline, walls);
    expect(report.consistent).toBe(true);
  });

  it("flags a numbering disagreement: the wall-visibility model placed a baseline opening on a wall whose index disagrees with the baseline's own wallIndex for it", () => {
    // The exact class of bug LD2 describes: extractWallVisibility's second,
    // independent model call mis-numbers which physical wall an opening
    // belongs to relative to what extractStructuralBaseline assigned.
    const baseline = makeBaseline([
      makeWindow({ id: "window_A", bbox: [0.1, 0.3, 0.3, 0.6], wallIndex: 2 }),
    ]);
    const walls = [
      // wall-visibility model claims window_A is on wall_0, but the
      // baseline says window_A's wallIndex is 2.
      makeWall("wall_0", ["window_A"]),
    ];

    const report = diagnoseWallIndexConsistency(baseline, walls);
    expect(report.consistent).toBe(false);
    expect(report.mismatches).toEqual([
      expect.objectContaining({
        wallId: "wall_0",
        wallIndex: 0,
        openingId: "window_A",
        openingBaselineWallIndex: 2,
        kind: "opening_claims_different_wall_index",
      }),
    ]);
  });

  it("flags a wall that omits an opening the baseline says belongs to its own index", () => {
    const baseline = makeBaseline([
      makeWindow({ id: "window_A", bbox: [0.1, 0.3, 0.3, 0.6], wallIndex: 1 }),
    ]);
    const walls = [
      // wall_1 exists but its own openingIds list is empty — it never
      // claimed window_A, even though the baseline says window_A belongs
      // to wallIndex 1.
      makeWall("wall_1", []),
    ];

    const report = diagnoseWallIndexConsistency(baseline, walls);
    expect(report.consistent).toBe(false);
    expect(report.mismatches).toEqual([
      expect.objectContaining({
        wallId: "wall_1",
        wallIndex: 1,
        openingId: "window_A",
        openingBaselineWallIndex: 1,
        kind: "wall_missing_opening_for_its_index",
      }),
    ]);
  });

  it("does not flag an opening id the wall-visibility model invented that doesn't exist in the baseline at all (not this diagnostic's concern)", () => {
    const baseline = makeBaseline([
      makeWindow({ id: "window_A", bbox: [0.1, 0.3, 0.3, 0.6], wallIndex: 0 }),
    ]);
    const walls = [
      makeWall("wall_0", ["window_A", "nonexistent_opening_id"]),
    ];

    const report = diagnoseWallIndexConsistency(baseline, walls);
    expect(report.consistent).toBe(true);
  });
});
