// Regression tests for the low-confidence edge-sliver advisory downgrade
// (job_e233cecb): Stage 2's opening validator hard-blocked an image over
// opening "C1" — a tiny sliver bbox hugging the image's right edge
// (x-range ~0.97-1.0, ~1-3% of image width), described as "a partially
// visible white, possibly bifold, closet door." Direct visual inspection
// of the actual baseline/candidate images showed no door there at all —
// just a plain wall corner. Replaying the exact baseline-extraction call
// three times against the real image showed the model didn't even agree
// with itself run-to-run (type flip-flopped closet_door/door, bbox
// drifted), despite misleadingly high per-item confidence (0.85-0.95) that
// tracked none of that instability. Root cause: OPENING_BASELINE_SINGLE_PASS
// disables the multi-pass consensus system, so every extraction is exactly
// one ungated call, honestly self-labeled graphConfidence: 0.5 — a signal
// the opening validator's hard-fail path never consulted.
//
// The fix is deliberately narrow: it does NOT remove the opening from
// baseline.openings (layoutPlanner/anchorLockedStaging must keep avoiding
// it) — it only stops THIS validator's hard-fail decision from being
// triggered by an edge-sliver item when the whole extraction was never
// confirmed. A genuinely material, non-sliver alteration still hard-fails.
import { isEdgeSliverOpening } from "../src/validators/openingPreservationValidator";
import type { StructuralBaseline, StructuralOpening } from "../src/validators/openingPreservationValidator";
import { partitionHardFailEligibleAlteredItems } from "../src/validators/openingEnvelopeValidator";

// The real C1 bbox reproduced by replaying job_e233cecb's baseline
// extraction call directly.
const C1_SLIVER_BBOX: [number, number, number, number] = [0.97, 0.511, 1.0, 1.0];

function makeOpening(overrides: Partial<StructuralOpening> & Pick<StructuralOpening, "id" | "bbox" | "wallIndex">): StructuralOpening {
  return {
    type: "closet_door",
    area_pct: 1.5,
    horizontalBand: "right_third",
    verticalBand: "full_height",
    wallCoverageBand: "10-20",
    orientation: "portrait",
    paneStructure: "unknown",
    doorLeafState: "unknown",
    confidence: 0.9,
    wallPosition: "right_wall",
    relativeHorizontalPosition: "right_third",
    shape: "rectangle",
    touchesFloor: false,
    touchesCeiling: false,
    approxCount: 1,
    ...overrides,
  } as StructuralOpening;
}

function makeBaseline(openings: StructuralOpening[], graphConfidence: number): StructuralBaseline {
  return {
    openings,
    graphMeta: {
      graphStable: false,
      graphConfidence,
      extractionAgreement: graphConfidence,
      passCount: 1,
      openingCountVariance: 0,
      imageHash: "test-hash",
      graphHash: "test-graph-hash",
      cacheStatus: "unstable",
      candidateGraphHashes: [],
      openingCountRange: { min: openings.length, max: openings.length },
      confirmedAt: new Date().toISOString(),
    },
  } as StructuralBaseline;
}

function makeAlteredItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    altered: true,
    verdict: "replaced",
    traceVisible: true,
    replacedByContinuousSurface: true,
    itemExtendsBeyondCoveringObject: true,
    extentChanged: false,
    structuralEvidenceFound: false,
    confidence: 0.9,
    materiality: "material",
    materialityReason: "test",
    type: "closet_door",
    description: "test item",
    rawObservation: { id, currentStateDescription: "test", currentSurfaceDescription: "test" },
    classification: {},
    ...overrides,
  } as any;
}

describe("isEdgeSliverOpening", () => {
  it("classifies the real C1 regression fixture as a sliver (right-edge, width 0.03)", () => {
    expect(isEdgeSliverOpening(C1_SLIVER_BBOX)).toBe(true);
  });

  it("classifies a left-edge sliver as a sliver (symmetry check)", () => {
    expect(isEdgeSliverOpening([0.0, 0.3, 0.02, 0.6])).toBe(true);
  });

  it("classifies a top-edge sliver as a sliver", () => {
    expect(isEdgeSliverOpening([0.3, 0.0, 0.6, 0.03])).toBe(true);
  });

  it("classifies a bottom-edge sliver as a sliver", () => {
    expect(isEdgeSliverOpening([0.3, 0.97, 0.6, 1.0])).toBe(true);
  });

  it("does not flag a genuinely large opening flush against an edge", () => {
    // Width 0.3, height 0.8 — a real door/window, not a sliver, even though
    // it touches the right edge.
    expect(isEdgeSliverOpening([0.7, 0.1, 1.0, 0.9])).toBe(false);
  });

  it("does not flag a small opening well inside the frame (skylight case)", () => {
    // Small area, but touches no edge at all.
    expect(isEdgeSliverOpening([0.4, 0.1, 0.44, 0.15])).toBe(false);
  });

  it("fails closed on a malformed bbox", () => {
    expect(isEdgeSliverOpening([NaN, 0, 1, 1] as any)).toBe(false);
    expect(isEdgeSliverOpening([0, 0, 1] as any)).toBe(false);
  });
});

describe("partitionHardFailEligibleAlteredItems", () => {
  it("excludes the real C1 sliver from hard-fail eligibility when graph confidence is low (0.5, matching single-pass mode)", () => {
    const baseline = makeBaseline(
      [makeOpening({ id: "C1", bbox: C1_SLIVER_BBOX, wallIndex: 1 })],
      0.5
    );
    const items = [makeAlteredItem("C1")];
    const { hardFailEligible, advisoryOnly } = partitionHardFailEligibleAlteredItems(items, baseline);
    expect(hardFailEligible).toHaveLength(0);
    expect(advisoryOnly).toHaveLength(1);
    expect(advisoryOnly[0].id).toBe("C1");
  });

  it("keeps the identical sliver hard-fail-eligible when graph confidence is high enough to trust (>= 0.67)", () => {
    const baseline = makeBaseline(
      [makeOpening({ id: "C1", bbox: C1_SLIVER_BBOX, wallIndex: 1 })],
      0.9
    );
    const items = [makeAlteredItem("C1")];
    const { hardFailEligible, advisoryOnly } = partitionHardFailEligibleAlteredItems(items, baseline);
    expect(hardFailEligible).toHaveLength(1);
    expect(advisoryOnly).toHaveLength(0);
  });

  it("keeps a genuinely large/real opening hard-fail-eligible even at low graph confidence (geometry required too)", () => {
    const baseline = makeBaseline(
      [makeOpening({ id: "D1", bbox: [0.1, 0.2, 0.5, 0.9], wallIndex: 0 })],
      0.5
    );
    const items = [makeAlteredItem("D1")];
    const { hardFailEligible, advisoryOnly } = partitionHardFailEligibleAlteredItems(items, baseline);
    expect(hardFailEligible).toHaveLength(1);
    expect(advisoryOnly).toHaveLength(0);
  });

  it("only downgrades the sliver in a mixed set, leaving a real alteration hard-fail-eligible", () => {
    const baseline = makeBaseline(
      [
        makeOpening({ id: "C1", bbox: C1_SLIVER_BBOX, wallIndex: 1 }),
        makeOpening({ id: "D1", type: "door", bbox: [0.1, 0.2, 0.5, 0.9], wallIndex: 0 }),
      ],
      0.5
    );
    const items = [makeAlteredItem("C1"), makeAlteredItem("D1")];
    const { hardFailEligible, advisoryOnly } = partitionHardFailEligibleAlteredItems(items, baseline);
    expect(hardFailEligible.map((i) => i.id)).toEqual(["D1"]);
    expect(advisoryOnly.map((i) => i.id)).toEqual(["C1"]);
  });

  it("fails open (treats as eligible) when the altered item has no matching baseline opening", () => {
    const baseline = makeBaseline([], 0.5);
    const items = [makeAlteredItem("UNKNOWN")];
    const { hardFailEligible, advisoryOnly } = partitionHardFailEligibleAlteredItems(items, baseline);
    expect(hardFailEligible).toHaveLength(1);
    expect(advisoryOnly).toHaveLength(0);
  });

  it("is a no-op passthrough when there are no altered items", () => {
    const baseline = makeBaseline([makeOpening({ id: "C1", bbox: C1_SLIVER_BBOX, wallIndex: 1 })], 0.5);
    const { hardFailEligible, advisoryOnly } = partitionHardFailEligibleAlteredItems([], baseline);
    expect(hardFailEligible).toHaveLength(0);
    expect(advisoryOnly).toHaveLength(0);
  });
});
