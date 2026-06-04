import {
  getStructuralBaselineGraphHash,
  validateOpeningPreservation,
  type StructuralBaseline,
  type StructuralOpening,
} from "../src/validators/openingPreservationValidator";

function makeOpening(overrides: Partial<StructuralOpening> & Pick<StructuralOpening, "id" | "type" | "bbox">): StructuralOpening {
  return {
    id: overrides.id,
    type: overrides.type,
    bbox: overrides.bbox,
    area_pct: overrides.area_pct ?? 12,
    aspect_ratio: overrides.aspect_ratio ?? 1,
    structuralClass: overrides.structuralClass ?? (overrides.type === "window" ? "exterior" : "circulation"),
    wallIndex: overrides.wallIndex ?? 3,
    horizontalBand: overrides.horizontalBand ?? "center_third",
    verticalBand: overrides.verticalBand ?? "mid_zone",
    widthBand: overrides.widthBand ?? "single",
    wallCoverageBand: overrides.wallCoverageBand ?? "10-20",
    orientation: overrides.orientation ?? "portrait",
    paneStructure: overrides.paneStructure ?? "single_fixed",
    heightClass: overrides.heightClass ?? "standard",
    doorLeafState: overrides.doorLeafState ?? "unknown",
    approxAspectRatio: overrides.approxAspectRatio ?? 1,
    confidence: overrides.confidence ?? 0.95,
    wallPosition: overrides.wallPosition ?? "left_wall",
    relativeHorizontalPosition: overrides.relativeHorizontalPosition ?? "center",
    shape: overrides.shape ?? overrides.type,
    touchesFloor: overrides.touchesFloor ?? (overrides.type !== "window"),
    touchesCeiling: overrides.touchesCeiling ?? false,
    approxCount: overrides.approxCount ?? 1,
  };
}

function makeBaseline(openings: StructuralOpening[]): StructuralBaseline {
  return {
    openings,
    wallCount: 4,
    anchorFixtures: [],
  };
}

describe("opening preservation determinism", () => {
  it("keeps graph hash stable for sub-precision bbox noise", () => {
    const baselineA = makeBaseline([
      makeOpening({
        id: "W1",
        type: "window",
        bbox: [0.1, 0.2, 0.3, 0.5],
      }),
    ]);
    const baselineB = makeBaseline([
      makeOpening({
        id: "W1",
        type: "window",
        bbox: [0.10004, 0.20004, 0.30004, 0.50004],
      }),
    ]);

    expect(getStructuralBaselineGraphHash(baselineA)).toBe(getStructuralBaselineGraphHash(baselineB));
  });

  it("changes graph hash when structural bbox geometry changes materially", () => {
    const baselineA = makeBaseline([
      makeOpening({
        id: "W1",
        type: "window",
        bbox: [0.1, 0.2, 0.3, 0.5],
      }),
    ]);
    const baselineB = makeBaseline([
      makeOpening({
        id: "W1",
        type: "window",
        bbox: [0.1, 0.2, 0.34, 0.5],
      }),
    ]);

    expect(getStructuralBaselineGraphHash(baselineA)).not.toBe(getStructuralBaselineGraphHash(baselineB));
  });

  it("keeps graph hash stable when an equivalent opening drifts between window and door subtype", () => {
    const baselineA = makeBaseline([
      makeOpening({
        id: "A1",
        type: "window",
        bbox: [0.64, 0.16, 0.9, 0.84],
        wallIndex: 3,
        horizontalBand: "right_third",
        verticalBand: "mid_zone",
        wallCoverageBand: "20-40",
        touchesFloor: false,
      }),
    ]);
    const baselineB = makeBaseline([
      makeOpening({
        id: "A1",
        type: "door",
        bbox: [0.64, 0.16, 0.9, 0.84],
        wallIndex: 3,
        horizontalBand: "right_third",
        verticalBand: "mid_zone",
        wallCoverageBand: "20-40",
        touchesFloor: false,
      }),
    ]);

    expect(getStructuralBaselineGraphHash(baselineA)).toBe(getStructuralBaselineGraphHash(baselineB));
  });

  it("does not emit sequence drift when identical openings arrive in reversed equal-x order", async () => {
    const baseline = makeBaseline([
      makeOpening({
        id: "window-base",
        type: "window",
        bbox: [0.2, 0.2, 0.4, 0.5],
        wallIndex: 3,
        horizontalBand: "center_third",
        verticalBand: "mid_zone",
        wallPosition: "left_wall",
      }),
      makeOpening({
        id: "door-base",
        type: "door",
        bbox: [0.2, 0.55, 0.4, 0.95],
        wallIndex: 3,
        horizontalBand: "center_third",
        verticalBand: "floor_zone",
        wallPosition: "left_wall",
        touchesFloor: true,
        paneStructure: "unknown",
      }),
    ]);

    const detected = makeBaseline([
      makeOpening({
        id: "door-base",
        type: "door",
        bbox: [0.2, 0.55, 0.4, 0.95],
        wallIndex: 3,
        horizontalBand: "center_third",
        verticalBand: "floor_zone",
        wallPosition: "left_wall",
        touchesFloor: true,
        paneStructure: "unknown",
      }),
      makeOpening({
        id: "window-base",
        type: "window",
        bbox: [0.2, 0.2, 0.4, 0.5],
        wallIndex: 3,
        horizontalBand: "center_third",
        verticalBand: "mid_zone",
        wallPosition: "left_wall",
      }),
    ]);

    const result = await validateOpeningPreservation(baseline, "unused", {
      detectedBaseline: detected,
      jobId: "job-det-1",
      imageId: "img-det-1",
      attempt: 1,
    });

    expect(result.summary.openingSignatureMismatch).toBe(false);
    expect(result.summary.openingRemoved).toBe(false);
    expect(result.summary.openingRelocated).toBe(false);
  });

  it("preserves downstream subtype mismatch semantics after canonical hash normalization", async () => {
    const baseline = makeBaseline([
      makeOpening({
        id: "opening-base",
        type: "window",
        bbox: [0.64, 0.16, 0.9, 0.84],
        wallIndex: 3,
        horizontalBand: "right_third",
        verticalBand: "mid_zone",
        wallCoverageBand: "20-40",
      }),
    ]);

    const detected = makeBaseline([
      makeOpening({
        id: "opening-detected",
        type: "door",
        bbox: [0.64, 0.16, 0.9, 0.84],
        wallIndex: 3,
        horizontalBand: "right_third",
        verticalBand: "mid_zone",
        wallCoverageBand: "20-40",
      }),
    ]);

    const result = await validateOpeningPreservation(baseline, "unused", {
      detectedBaseline: detected,
      jobId: "job-det-2",
      imageId: "img-det-2",
      attempt: 1,
    });

    expect(result.summary.openingRemoved).toBe(false);
    expect(result.summary.openingClassMismatch).toBe(true);
    expect(result.reconciledMatches).toEqual([
      expect.objectContaining({
        baselineId: "opening-base",
        detectedId: "opening-detected",
        matchSource: "graph_reconcile",
      }),
    ]);
  });
});
