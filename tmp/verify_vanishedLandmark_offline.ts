import { compareVanishedLandmarkObservations, type LandmarkChoiceObservation, type LandmarkConfirmationObservation } from "./vanishedLandmarkCheck";

let failures = 0;
function check(label: string, baseline: LandmarkChoiceObservation, staged: LandmarkConfirmationObservation, expectVerdict: string) {
  const v = compareVanishedLandmarkObservations(baseline, staged);
  const pass = v.verdict === expectVerdict;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: verdict=${v.verdict} vanishedLandmark=${v.vanishedLandmark} resized=${v.resized} repositioned=${v.repositioned} (${v.reason}) (expected ${expectVerdict})`);
  if (!pass) failures++;
}

function base(primaryLandmark: string, relativePosition: string, secondLandmark: string, relativeExtentFraction: number | null): LandmarkChoiceObservation {
  return { identifiedItemDescription: "", itemPlane: "wall", primaryLandmark, relativePosition, secondLandmark, relativeExtentFraction };
}
function staged(opts: Partial<LandmarkConfirmationObservation>): LandmarkConfirmationObservation {
  return {
    identifiedItemDescription: "",
    primaryLandmarkLocationDescription: "",
    primaryLandmarkStillPresent: "yes",
    relativePosition: null,
    secondLandmarkLocationDescription: "",
    secondLandmarkStillPresent: "yes",
    relativeExtentFraction: null,
    whatOccupiesLandmarkLocationNow: null,
    ...opts,
  };
}

console.log("=== Primary landmark confirmed absent (must be a CONCLUSIVE FAIL, not a discard) ===");
check(
  "AC unit genuinely removed (Bedroom 12 style)",
  base("wall-mounted AC unit", "left of it, close", "room corner", 0.7),
  staged({ primaryLandmarkStillPresent: "no", whatOccupiesLandmarkLocationNow: "plain continuous painted wall" }),
  "fail_vanished_landmark"
);

console.log("\n=== Primary landmark occluded by new furniture, genuinely unable to tell (must NOT be a fail — the new false-positive risk this design must guard against) ===");
check(
  "Landmark blocked by new wardrobe placed in front of it",
  base("AC unit", "left of it, close", "room corner", 0.7),
  staged({ primaryLandmarkStillPresent: "cannot_tell", primaryLandmarkLocationDescription: "completely blocked by a large wardrobe" }),
  "inconclusive_occluded"
);

console.log("\n=== Both landmarks present, consistent position/extent (must PASS) ===");
check(
  "Consistent, unchanged",
  base("the doorway", "left of it, close", "the corner", 0.8),
  staged({ primaryLandmarkStillPresent: "yes", relativePosition: "left of it, close", secondLandmarkStillPresent: "yes", relativeExtentFraction: 0.78 }),
  "pass"
);

console.log("\n=== Both landmarks present, direction changed (must fail_repositioned) ===");
check(
  "Direction flips",
  base("the curtain rod bracket", "left of it, touching", "the corner", 0.8),
  staged({ primaryLandmarkStillPresent: "yes", relativePosition: "right of it, close", secondLandmarkStillPresent: "yes", relativeExtentFraction: 0.8 }),
  "fail_repositioned"
);

console.log("\n=== Both landmarks present, extent dropped >25% (must fail_resized) ===");
check(
  "Extent drops from 1.0 to 0.4",
  base("the curtain rod", "below it, touching", "the corner", 1.0),
  staged({ primaryLandmarkStillPresent: "yes", relativePosition: "below it, touching", secondLandmarkStillPresent: "yes", relativeExtentFraction: 0.4 }),
  "fail_resized"
);

console.log("\n=== Second landmark confirmed absent (must also be a conclusive fail) ===");
check(
  "Second landmark vanished",
  base("the doorway", "left of it, close", "the far wall corner", 0.8),
  staged({ primaryLandmarkStillPresent: "yes", relativePosition: "left of it, close", secondLandmarkStillPresent: "no" }),
  "fail_vanished_landmark"
);

console.log("\n=== Second landmark occluded (extent comparison impossible -> inconclusive_occluded, NOT silently 'pass'; the vanish-check+fallback task's own combineWithFallback layer is what turns this into a fallback attempt, not this function) ===");
check(
  "Second landmark cannot_tell -> inconclusive_occluded (bug fix: previously fell through to a silent, wrong 'pass')",
  base("the doorway", "left of it, close", "the far corner", 0.8),
  staged({ primaryLandmarkStillPresent: "yes", relativePosition: "left of it, close", secondLandmarkStillPresent: "cannot_tell", relativeExtentFraction: null }),
  "inconclusive_occluded"
);

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
