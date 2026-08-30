// Deterministic validation of the co-located-feature fix, using the REAL
// Bedroom 11 baseline extraction captured this session (tmp/check_bedroom11_baseline.log),
// which is the exact data that produced the original window-walled-over
// failure (W2, a window, on wallIndex 1 — the same wall the bed was
// anchored against in both of the user's failed staged images).
//
// This bypasses wall-visibility's known run-to-run instability (confirmed
// again just now — a full-pipeline repro landed on the fallback path
// instead of re-selecting wall_1) by calling the fix's own function
// directly against real, already-captured production data.
import type { StructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { describeCoLocatedFeatures } from "../worker/src/pipeline/anchorLockedStaging";

const REAL_BEDROOM11_BASELINE: StructuralBaseline = {
  openings: [
    { id: "W1", type: "window", bbox: [0.284, 0.375, 0.651, 0.665], area_pct: 10.64, wallIndex: 0, horizontalBand: "center_third", verticalBand: "mid_zone", wallCoverageBand: "20-40", orientation: "portrait", paneStructure: "fixed_plus_opening", doorLeafState: "unknown", confidence: 0.99, wallPosition: "near_wall", relativeHorizontalPosition: "center", shape: "window", touchesFloor: false, touchesCeiling: false, approxCount: 1 },
    { id: "W2", type: "window", bbox: [0.718, 0.323, 0.923, 0.453], area_pct: 2.67, wallIndex: 1, horizontalBand: "right_third", verticalBand: "mid_zone", wallCoverageBand: "10-20", orientation: "landscape", paneStructure: "single_fixed", doorLeafState: "unknown", confidence: 0.98, wallPosition: "right_wall", relativeHorizontalPosition: "right_third", shape: "window", touchesFloor: false, touchesCeiling: false, approxCount: 1 },
    { id: "D1", type: "door", bbox: [0, 0, 0.141, 1], area_pct: 14.1, wallIndex: 3, horizontalBand: "left_third", verticalBand: "full_height", wallCoverageBand: "20-40", orientation: "portrait", paneStructure: "unknown", doorLeafState: "open", confidence: 0.92, wallPosition: "left_wall", relativeHorizontalPosition: "left_third", shape: "door", touchesFloor: true, touchesCeiling: false, approxCount: 1 },
    { id: "C1", type: "closet_door", bbox: [0.138, 0.133, 0.315, 0.926], area_pct: 14.03, wallIndex: 3, horizontalBand: "left_third", verticalBand: "full_height", wallCoverageBand: "40-60", orientation: "portrait", paneStructure: "sliding_panel", doorLeafState: "closed", confidence: 0.95, wallPosition: "left_wall", relativeHorizontalPosition: "left_third", shape: "closet_door", touchesFloor: true, touchesCeiling: false, approxCount: 1 },
  ],
  anchorFixtures: [
    { id: "L1", type: "light_fixture", wallIndex: 0, horizontalBand: "center_third", bbox: [0.465, 0.225, 0.505, 0.255], confidence: 0.99 },
    { id: "L2", type: "light_fixture", wallIndex: 0, horizontalBand: "right_third", bbox: [0.675, 0.255, 0.705, 0.285], confidence: 0.99 },
  ],
};

function main() {
  console.log("=== Simulating the exact scenario that caused the original failure ===");
  console.log("Anchor wall = wall_1 (the wall the bed was placed against in both failed staged images, which is where W2 lives)\n");

  const wallIndexUnderTest = 1; // matches W2's wallIndex, and the wall used in the user's failed runs
  const lines = describeCoLocatedFeatures(REAL_BEDROOM11_BASELINE, wallIndexUnderTest);

  console.log(`describeCoLocatedFeatures(baseline, anchorWallIndex=${wallIndexUnderTest}) returned ${lines.length} line(s):\n`);
  for (const line of lines) console.log(line);

  const mentionsW2 = lines.some((l) => l.includes("W2"));
  const forbidsDecor = lines.some((l) => /do not place artwork, mirrors, shelving/i.test(l));

  console.log("\n=== CHECK ===");
  console.log("W2 explicitly named:", mentionsW2);
  console.log("Explicitly forbids artwork/mirrors/shelving over it:", forbidsDecor);
  console.log(mentionsW2 && forbidsDecor ? "PASS — the fix would have caught this exact failure." : "FAIL");

  console.log("\n=== Sanity check: a wall with NO openings/fixtures produces an empty list (no over-restriction) ===");
  const emptyCase = describeCoLocatedFeatures(REAL_BEDROOM11_BASELINE, 2 as any);
  console.log(`wallIndex=2 (no openings/fixtures on it in this baseline): ${emptyCase.length} line(s) — `, emptyCase.length === 0 ? "PASS (no spurious restriction)" : "UNEXPECTED");
}

main();
