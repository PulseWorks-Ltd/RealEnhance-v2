import assert from "node:assert/strict";
import {
  classifyNonWindowOpeningAreaLoss,
  type StructuralOpening,
} from "../validators/openingPreservationValidator";

function makeOpening(overrides: Partial<StructuralOpening> = {}): StructuralOpening {
  return {
    id: "C1",
    type: "closet_door",
    bbox: [0.05, 0.18, 0.28, 0.96],
    area_pct: 8.5,
    aspect_ratio: 0.29,
    structuralClass: "storage",
    wallIndex: 3,
    horizontalBand: "left_third",
    verticalBand: "full_height",
    widthBand: "single",
    wallCoverageBand: "20-40",
    orientation: "portrait",
    paneStructure: "unknown",
    heightClass: "standard",
    doorLeafState: "closed",
    approxAspectRatio: 0.29,
    confidence: 0.95,
    wallPosition: "left_wall",
    relativeHorizontalPosition: "left_third",
    shape: "portrait",
    touchesFloor: true,
    touchesCeiling: false,
    approxCount: 1,
    ...overrides,
  };
}

function run() {
  const baseline = makeOpening();

  // VALID: bed/chair near opening causes partial occlusion and contrast change,
  // but the opening remains perceptually present in the same location.
  {
    const candidate = makeOpening({
      bbox: [0.08, 0.2, 0.24, 0.96],
      area_pct: 4.8,
      wallCoverageBand: "10-20",
      confidence: 0.93,
    });
    const areaDelta = Math.abs((candidate.area_pct - baseline.area_pct) / baseline.area_pct);
    const out = classifyNonWindowOpeningAreaLoss({
      baseOpening: baseline,
      detectedOpening: candidate,
      areaDelta,
      invariantReasons: ["wall_coverage_band_changed_gt_one"],
    });
    assert.equal(out.occlusionLikely, true, "Partial edge occlusion should be treated as likely occlusion");
    assert.equal(out.anchorsLikelyPresent, true, "Identity anchors should be treated as present for recoverable occlusion");
    assert.equal(out.classifyAsInfilled, false, "Partial edge occlusion should not be hard-failed as infill");
  }

  // VALID: mild visibility narrowing/shadow shift with stable geometry should pass.
  {
    const candidate = makeOpening({
      bbox: [0.06, 0.18, 0.25, 0.95],
      area_pct: 5.1,
      wallCoverageBand: "10-20",
      confidence: 0.91,
    });
    const areaDelta = Math.abs((candidate.area_pct - baseline.area_pct) / baseline.area_pct);
    const out = classifyNonWindowOpeningAreaLoss({
      baseOpening: baseline,
      detectedOpening: candidate,
      areaDelta,
      invariantReasons: ["wall_coverage_band_changed_gt_one"],
    });
    assert.equal(out.classifyAsInfilled, false, "Moderate narrowing with preserved presence should not infer infill");
  }

  // VALID/ADVISORY: frame-boundary truncation should not imply infill by itself.
  {
    const edgeBaseline = makeOpening({
      id: "C2",
      bbox: [0.0, 0.16, 0.22, 0.96],
      area_pct: 8.1,
    });
    const candidate = makeOpening({
      id: "C2",
      bbox: [0.0, 0.19, 0.18, 0.96],
      area_pct: 5.0,
      wallCoverageBand: "10-20",
      confidence: 0.9,
    });
    const areaDelta = Math.abs((candidate.area_pct - edgeBaseline.area_pct) / edgeBaseline.area_pct);
    const out = classifyNonWindowOpeningAreaLoss({
      baseOpening: edgeBaseline,
      detectedOpening: candidate,
      areaDelta,
      invariantReasons: ["wall_coverage_band_changed_gt_one"],
    });
    assert.equal(out.frameBoundaryTruncationLikely, true, "Edge-truncation should be recognized as truncation risk");
    assert.equal(out.classifyAsInfilled, false, "Edge truncation alone should not trigger infill");
  }

  // ADVISORY: semantic anchor erosion without continuity collapse should not hard-fail.
  {
    const anchorBaseline = makeOpening({
      id: "D2",
      type: "door",
      paneStructure: "single_fixed",
      doorLeafState: "closed",
      area_pct: 9.2,
      bbox: [0.42, 0.18, 0.6, 0.96],
    });
    const candidate = makeOpening({
      id: "D2",
      type: "door",
      paneStructure: "double_fixed",
      doorLeafState: "open",
      area_pct: 6.4,
      bbox: [0.45, 0.2, 0.58, 0.96],
      wallCoverageBand: "10-20",
      confidence: 0.92,
    });
    const areaDelta = Math.abs((candidate.area_pct - anchorBaseline.area_pct) / anchorBaseline.area_pct);
    const out = classifyNonWindowOpeningAreaLoss({
      baseOpening: anchorBaseline,
      detectedOpening: candidate,
      areaDelta,
      invariantReasons: ["wall_coverage_band_changed_gt_one"],
    });
    assert.equal(out.semanticAnchorErosionLikely, true, "Anchor erosion should be recognized when cues diverge");
    assert.equal(out.continuityCollapseLikely, false, "This case should remain recoverable, not collapsed");
    assert.equal(out.classifyAsInfilled, false, "Recoverable anchor erosion should remain advisory");
  }

  // INVALID: opening effectively removed/sealed (tiny retained aperture) should fail.
  {
    const candidate = makeOpening({
      bbox: [0.14, 0.55, 0.22, 0.88],
      area_pct: 1.2,
      wallCoverageBand: "5-10",
      confidence: 0.94,
    });
    const areaDelta = Math.abs((candidate.area_pct - baseline.area_pct) / baseline.area_pct);
    const out = classifyNonWindowOpeningAreaLoss({
      baseOpening: baseline,
      detectedOpening: candidate,
      areaDelta,
      invariantReasons: ["wall_coverage_band_changed_gt_one"],
    });
    assert.equal(out.classifyAsInfilled, true, "Near-sealed opening must remain hard-fail eligible");
  }

  // INVALID: major geometry mutation (orientation/pane/shape shift) should fail.
  {
    const candidate = makeOpening({
      bbox: [0.05, 0.18, 0.42, 0.72],
      area_pct: 3.9,
      wallCoverageBand: "40-60",
      orientation: "landscape",
      confidence: 0.95,
    });
    const areaDelta = Math.abs((candidate.area_pct - baseline.area_pct) / baseline.area_pct);
    const out = classifyNonWindowOpeningAreaLoss({
      baseOpening: baseline,
      detectedOpening: candidate,
      areaDelta,
      invariantReasons: ["orientation_changed", "wall_coverage_band_changed_gt_one"],
    });
    assert.equal(out.classifyAsInfilled, true, "Material opening geometry mutation must remain fail eligible");
  }

  // INVALID: major relocation-like drift with large area loss should fail.
  {
    const candidate = makeOpening({
      bbox: [0.32, 0.22, 0.49, 0.9],
      area_pct: 2.9,
      horizontalBand: "center_third",
      confidence: 0.92,
    });
    const areaDelta = Math.abs((candidate.area_pct - baseline.area_pct) / baseline.area_pct);
    const out = classifyNonWindowOpeningAreaLoss({
      baseOpening: baseline,
      detectedOpening: candidate,
      areaDelta,
      invariantReasons: ["horizontal_band_changed", "wall_coverage_band_changed_gt_one"],
    });
    assert.equal(out.classifyAsInfilled, true, "Material opening displacement with major loss must remain fail eligible");
  }

  // INVALID: severe edge-collapse with anchor erosion should hard-fail.
  {
    const edgeBaseline = makeOpening({
      id: "D3",
      type: "door",
      bbox: [0.0, 0.2, 0.21, 0.96],
      area_pct: 8.4,
      paneStructure: "single_fixed",
      doorLeafState: "closed",
    });
    const candidate = makeOpening({
      id: "D3",
      type: "door",
      bbox: [0.0, 0.7, 0.09, 0.93],
      area_pct: 0.9,
      paneStructure: "double_fixed",
      doorLeafState: "open",
      wallCoverageBand: "5-10",
      confidence: 0.95,
    });
    const areaDelta = Math.abs((candidate.area_pct - edgeBaseline.area_pct) / edgeBaseline.area_pct);
    const out = classifyNonWindowOpeningAreaLoss({
      baseOpening: edgeBaseline,
      detectedOpening: candidate,
      areaDelta,
      invariantReasons: ["wall_coverage_band_changed_gt_one"],
    });
    assert.equal(out.continuityCollapseLikely, true, "Collapsed edge case should be detected as continuity collapse");
    assert.equal(out.classifyAsInfilled, true, "Severe collapse with anchor loss must hard-fail");
  }

  console.log("[PASS] Opening occlusion gate regression tests");
}

run();