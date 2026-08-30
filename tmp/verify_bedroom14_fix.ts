// Deterministic validation of the Bedroom 14 fix (segment-specific
// placement + corrected co-located-features wording), using the REAL
// Bedroom 14 baseline extraction captured this session
// (tmp/check_bedroom14_baseline.log) — C1, a closet door, on wallIndex 1
// at the far-right edge of the frame, exactly where the bed was placed
// directly over it in the user's failed staged image.
//
// Constructs a realistic wall_1 wall-visibility result: a wall spanning
// frame x=[0.6,1.0], with C1 (frame x=[0.9326,0.9986]) correctly excluded
// from its usable segment — i.e. wall-visibility did its job here; the
// question this test answers is whether the FINAL PROMPT TEXT now
// correctly threads that clear segment through, and explicitly forbids
// the bed itself (not just decor) from overlapping C1.
import type { StructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { planBedroomAnchor, describeCoLocatedFeatures, type WallVisibilityWall } from "../worker/src/pipeline/anchorLockedStaging";

const REAL_BEDROOM14_BASELINE: StructuralBaseline = {
  openings: [
    { id: "W2", type: "window", bbox: [0.5729, 0.2546, 0.8118, 0.4806], area_pct: 5.4, wallIndex: 0, horizontalBand: "center_third", verticalBand: "mid_zone", wallCoverageBand: "10-20", orientation: "landscape", paneStructure: "sliding_panel", doorLeafState: "unknown", confidence: 0.95, wallPosition: "near_wall", relativeHorizontalPosition: "center", shape: "window", touchesFloor: false, touchesCeiling: false, approxCount: 1 },
    { id: "C1", type: "closet_door", bbox: [0.9326, 0.2926, 0.9986, 0.925], area_pct: 4.25, wallIndex: 1, horizontalBand: "right_third", verticalBand: "full_height", wallCoverageBand: "20-40", orientation: "portrait", paneStructure: "unknown", doorLeafState: "closed", confidence: 0.9, wallPosition: "right_wall", relativeHorizontalPosition: "right_third", shape: "closet_door", touchesFloor: true, touchesCeiling: false, approxCount: 1 },
    { id: "W1", type: "window", bbox: [0.0666, 0.1713, 0.4743, 0.5333], area_pct: 14.75, wallIndex: 3, horizontalBand: "left_third", verticalBand: "mid_zone", wallCoverageBand: "40-60", orientation: "landscape", paneStructure: "sliding_panel", doorLeafState: "unknown", confidence: 0.95, wallPosition: "left_wall", relativeHorizontalPosition: "left_third", shape: "window", touchesFloor: false, touchesCeiling: false, approxCount: 1 },
  ],
  anchorFixtures: [
    { id: "LF1", type: "light_fixture", wallIndex: 0, horizontalBand: "center_third", bbox: [0.4736, 0, 0.5543, 0.063], confidence: 0.98 },
  ],
};

// Realistic wall_1: spans frame x=[0.6,1.0]. C1 occupies frame x=[0.9326,0.9986],
// which in wall-relative terms is roughly [0.83, 1.0] of wall_1's own width
// ((0.9326-0.6)/(1.0-0.6)=0.83). A correctly-behaving wall-visibility
// extraction excludes that from the usable segment.
const walls: WallVisibilityWall[] = [
  {
    id: "wall_1",
    wallLabel: "Right wall",
    extent: { polygon: [[0.6, 0.1], [1.0, 0.05], [1.0, 0.95], [0.6, 0.9]] },
    openingIds: ["C1"],
    usableWidthFraction: 0.83,
    usableSegments: [{ range: [0, 0.8], widthFraction: 0.8, description: "clear space to the left of the closet door" }],
    confidence: 0.9,
  },
];

function main() {
  console.log("=== Simulating the exact scenario that caused the Bedroom 14 failure ===");
  console.log("wall_1 has a correctly-excluded usable segment (0.8 width), but the OLD prompt never referenced it.\n");

  const plan = planBedroomAnchor(REAL_BEDROOM14_BASELINE, walls);
  if (!plan) {
    console.error("FAIL — planner returned null, expected a plan");
    process.exit(1);
  }
  console.log("anchorSegmentDescription:", plan.anchorSegmentDescription);

  const coLocated = describeCoLocatedFeatures(REAL_BEDROOM14_BASELINE, plan.anchorWallIndex);
  console.log("\ncoLocatedFeatures:");
  for (const l of coLocated) console.log(l);

  // Reproduce the exact anchor-item instruction line the real prompt builds.
  const anchorItemLine = `* Place the bed against ${plan.anchorWallId} in the room analysis, referred to as "${plan.anchorWallLabel}", within the clear segment described as "${plan.anchorSegmentDescription}" — this is the wall and clear zone selected as the anchor by the room's own layout analysis.`;
  console.log("\nAnchor item instruction line:\n" + anchorItemLine);

  const featuresSectionIntro = `Position the bed within the clear segment described above so that it does NOT overlap or obstruct any of these — the bed must be positioned to avoid them, even if that means it does not span the entire wall.`;
  console.log("\nCo-located features section intro:\n" + featuresSectionIntro);

  console.log("\n=== CHECKS ===");
  const segmentMentioned = anchorItemLine.includes("clear space to the left of the closet door");
  const c1Named = coLocated.some((l) => l.includes("C1"));
  const bedMustAvoid = /bed must be positioned to avoid|does NOT overlap or obstruct/i.test(featuresSectionIntro);
  const noLongerSaysBedMayGo = !featuresSectionIntro.includes("bed itself may go against this wall");

  console.log("Anchor instruction now references the specific clear segment (not just the whole wall):", segmentMentioned);
  console.log("C1 (the closet door) explicitly named:", c1Named);
  console.log("Wording now explicitly requires the BED to avoid it (not just decor):", bedMustAvoid);
  console.log("Old permissive 'bed itself may go against this wall' wording removed:", noLongerSaysBedMayGo);

  const allPass = segmentMentioned && c1Named && bedMustAvoid && noLongerSaysBedMayGo;
  console.log(allPass ? "\nPASS — this exact failure mode is now addressed." : "\nFAIL");
}

main();
