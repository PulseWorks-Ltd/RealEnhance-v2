import { compareSingleImageObservations, type SingleImageObservation } from "./singleImageResizeCheck";

let failures = 0;
function check(label: string, baseline: SingleImageObservation, staged: SingleImageObservation, expectFlagged: boolean) {
  const v = compareSingleImageObservations(baseline, staged);
  const flagged = v.resized || v.repositioned;
  const pass = flagged === expectFlagged;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: resized=${v.resized} repositioned=${v.repositioned} (${v.reason}) (expected flagged=${expectFlagged})`);
  if (!pass) failures++;
}

function obs(bbox: [number, number, number, number]): SingleImageObservation {
  return { referencePoints: "", boundaryDescription: "", bboxEstimate: bbox, touchesFrameEdge: "none" };
}

console.log("=== Genuine large change (Bedroom 12 door, using my own crop-based quantitative measurement as ground truth) ===");
check(
  "Bedroom 12 door: baseline wide-left, staged narrow-shifted-right (matches my ~55% size reduction + large shift measurement)",
  obs([0.18, 0.20, 0.44, 0.75]),
  obs([0.47, 0.30, 0.62, 0.75]),
  true
);

console.log("\n=== Genuine large change (Bedroom 09 window — visibly larger/more square and shifted, per direct user visual inspection) ===");
check(
  "Bedroom 09 window: baseline smaller/narrower, staged larger/shifted",
  obs([0.10, 0.24, 0.47, 0.57]),
  obs([0.05, 0.20, 0.55, 0.62]),
  true
);

console.log("\n=== Small, camera-angle-plausible differences (must NOT flag) ===");
check("Tiny uniform shift (~1-2% of frame, same size)", obs([0.10, 0.15, 0.45, 0.60]), obs([0.11, 0.16, 0.46, 0.61]), false);
check("Small size difference only (~10%, well under 25% threshold)", obs([0.10, 0.15, 0.45, 0.60]), obs([0.105, 0.16, 0.44, 0.595]), false);

console.log("\n=== Threshold boundary sanity checks ===");
// baseline area = 0.4*0.4 = 0.16 exactly. staged area = 0.4*0.52 = 0.208 = 0.16*1.30 exactly
// (rational numbers chosen specifically to avoid the floating-point boundary
// fragility of the previous sqrt(1.25)-based construction) => 30% area increase, clearly over the 25% threshold.
check("Clearly over 25% area increase (30%, should flag)", obs([0, 0, 0.4, 0.4]), obs([0, 0, 0.4, 0.52]), true);
check("20% area increase (should NOT flag, under 25%)", obs([0, 0, 0.4, 0.4]), obs([0, 0, 0.4382, 0.4382]), false); // area *1.20

console.log("\n=== Missing bbox estimate (model failed to give one — must not crash, must default to not-flagged) ===");
check(
  "Missing staged bbox",
  obs([0.1, 0.1, 0.3, 0.3]),
  { referencePoints: "", boundaryDescription: "", bboxEstimate: null, touchesFrameEdge: "none" },
  false
);

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
