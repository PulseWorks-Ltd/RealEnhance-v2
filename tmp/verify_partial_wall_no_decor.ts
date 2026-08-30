// Deterministic validation of the new rule: if the anchor wall is only
// partially visible in the frame (edge-cropped), the planner must forbid
// wall-mounted artwork/decor above the bed entirely — since whatever's
// just off-frame can't be verified by baseline extraction, so co-located
// -feature protection can't cover it either.
import type { StructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { planBedroomAnchor, type WallVisibilityWall } from "../worker/src/pipeline/anchorLockedStaging";

const BASELINE: StructuralBaseline = {
  openings: [{ id: "D1", type: "door", bbox: [0, 0.2, 0.1, 0.9], area_pct: 8, wallIndex: 3, horizontalBand: "left_third", verticalBand: "full_height", wallCoverageBand: "20-40", orientation: "portrait", paneStructure: "unknown", doorLeafState: "open", confidence: 0.95, wallPosition: "left_wall", relativeHorizontalPosition: "left_third", shape: "door", touchesFloor: true, touchesCeiling: false, approxCount: 1 }],
  anchorFixtures: [],
};

function run(label: string, wall: WallVisibilityWall) {
  const plan = planBedroomAnchor(BASELINE, [wall]);
  if (!plan) { console.log(`${label}: planner returned null (unexpected)`); return; }
  console.log(`\n--- ${label} ---`);
  console.log("wallPartiallyVisible:", plan.wallPartiallyVisible);
  console.log("noDecorAboveBedNote:", plan.noDecorAboveBedNote);
}

// Case 1: fully visible wall (x range comfortably inside the frame).
run("Fully visible wall", {
  id: "wall_0", wallLabel: "Back wall",
  extent: { polygon: [[0.2, 0.1], [0.7, 0.1], [0.7, 0.9], [0.2, 0.9]] },
  openingIds: [], usableWidthFraction: 1, usableSegments: [{ range: [0, 1], widthFraction: 1, description: "full visible extent" }], confidence: 0.9,
});

// Case 2: wall cropped at the right frame edge (maxX >= 0.97).
run("Edge-cropped wall (right)", {
  id: "wall_1", wallLabel: "Right wall",
  extent: { polygon: [[0.7, 0.1], [1.0, 0.05], [1.0, 0.95], [0.7, 0.9]] },
  openingIds: [], usableWidthFraction: 1, usableSegments: [{ range: [0, 1], widthFraction: 1, description: "full visible extent" }], confidence: 0.9,
});

console.log("\n=== CHECK ===");
const fullyVisible = planBedroomAnchor(BASELINE, [{
  id: "wall_0", wallLabel: "Back wall",
  extent: { polygon: [[0.2, 0.1], [0.7, 0.1], [0.7, 0.9], [0.2, 0.9]] },
  openingIds: [], usableWidthFraction: 1, usableSegments: [{ range: [0, 1], widthFraction: 1, description: "full visible extent" }], confidence: 0.9,
}]);
const cropped = planBedroomAnchor(BASELINE, [{
  id: "wall_1", wallLabel: "Right wall",
  extent: { polygon: [[0.7, 0.1], [1.0, 0.05], [1.0, 0.95], [0.7, 0.9]] },
  openingIds: [], usableWidthFraction: 1, usableSegments: [{ range: [0, 1], widthFraction: 1, description: "full visible extent" }], confidence: 0.9,
}]);

const pass = fullyVisible?.noDecorAboveBedNote === null && !!cropped?.noDecorAboveBedNote;
console.log("Fully visible wall correctly has NO no-decor restriction:", fullyVisible?.noDecorAboveBedNote === null);
console.log("Edge-cropped wall correctly triggers the no-decor restriction:", !!cropped?.noDecorAboveBedNote);
console.log(pass ? "PASS" : "FAIL");
