import { compareRelativeLandmarkObservations, type RelativeLandmarkObservation } from "./relativeLandmarkResizeCheck";

let failures = 0;
function check(label: string, baseline: RelativeLandmarkObservation, staged: RelativeLandmarkObservation, expectFlagged: boolean, expectComparable = true) {
  const v = compareRelativeLandmarkObservations(baseline, staged);
  const flagged = v.resized || v.repositioned;
  const pass = flagged === expectFlagged && v.comparable === expectComparable;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: comparable=${v.comparable} resized=${v.resized} repositioned=${v.repositioned} (${v.reason}) (expected flagged=${expectFlagged}, comparable=${expectComparable})`);
  if (!pass) failures++;
}

function obs(primaryLandmark: string, relativePosition: string, secondLandmark: string, relativeExtentFraction: number | null): RelativeLandmarkObservation {
  return { identifiedItemDescription: "", primaryLandmark, relativePosition, secondLandmark, relativeExtentFraction };
}

console.log("=== Landmark mismatch (must default to not-comparable, not-flagged) ===");
check(
  "Different primary landmarks entirely",
  obs("the back-right room corner", "left of it, close", "the window", 1.0),
  obs("the left nightstand lamp", "above it, far", "the bed headboard", 0.4),
  false,
  false
);

console.log("\n=== Same landmark, same direction, similar extent (must NOT flag) ===");
check(
  "Consistent position and extent",
  obs("the ceiling-wall junction above the window", "left of it, close", "the room corner", 1.0),
  obs("the ceiling-wall junction above the window", "left of it, close", "the room corner", 0.95),
  false
);

console.log("\n=== Same landmark, clearly different direction (must flag repositioned) ===");
check(
  "Direction flips left to right",
  obs("the curtain rod bracket", "left of it, touching", "the room corner", 0.8),
  obs("the curtain rod bracket", "right of it, close", "the room corner", 0.8),
  true
);

console.log("\n=== Same landmark, 'same spot' explicitly claimed on one side (must NOT flag reposition even if direction words differ) ===");
check(
  "One side says same spot",
  obs("the doorway", "same spot, near it", "the corner", 0.7),
  obs("the doorway", "left of it, close", "the corner", 0.7),
  false
);

console.log("\n=== Same landmark, large extent drop (Bedroom 12 door style — must flag resized) ===");
check(
  "Extent fraction drops from 1.0 to 0.4 (60% relative drop)",
  obs("the curtain rod", "below it, touching", "the room corner", 1.0),
  obs("the curtain rod", "below it, touching", "the room corner", 0.4),
  true
);

console.log("\n=== Same landmark, small extent difference under threshold (must NOT flag) ===");
check(
  "Extent fraction 1.0 vs 0.85 (15% relative drop, under 25%)",
  obs("the doorway", "left of it, close", "the corner", 1.0),
  obs("the doorway", "left of it, close", "the corner", 0.85),
  false
);

console.log("\n=== Missing extent fraction on one side (must not crash, must default to not-resized) ===");
check(
  "Staged extent fraction missing",
  obs("the doorway", "left of it, close", "the corner", 1.0),
  obs("the doorway", "left of it, close", "the corner", null),
  false
);

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
