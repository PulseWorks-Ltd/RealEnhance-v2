// Offline verification of the PRODUCTION vanished-landmark check
// (worker/src/validators/vanishedLandmarkCheck.ts), now wired into both
// openingEnvelopeValidator.ts and fixtureFlooringValidator.ts. Reuses the
// exact case sets from tmp/verify_vanishedLandmark_offline.ts,
// tmp/verify_relativeLandmark_offline.ts, and
// tmp/verify_vanishedLandmarkFallback_offline.ts — the pure comparison and
// combine functions are unchanged logic, just consolidated into one file
// and restructured for batched observation input (each observation type
// now carries an itemId field, unused by these pure functions' own logic).
import {
  compareVanishedLandmarkObservations,
  compareRelativeLandmarkObservations,
  combineWithFallback,
  type LandmarkChoiceObservation,
  type LandmarkConfirmationObservation,
  type RelativeLandmarkObservation,
  type VanishedLandmarkVerdict,
  type RelativeLandmarkVerdict,
} from "../worker/src/validators/vanishedLandmarkCheck";

let failures = 0;
function check(label: string, actual: string, expected: string, detail: string) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: ${actual} (${detail}) (expected ${expected})`);
  if (!pass) failures++;
}

// ── Strict path: compareVanishedLandmarkObservations ──
console.log("=== Strict path: primary landmark confirmed absent (must be a CONCLUSIVE FAIL, not a discard) ===");
function baseChoice(primaryLandmark: string, relativePosition: string, secondLandmark: string, relativeExtentFraction: number | null): LandmarkChoiceObservation {
  return { itemId: "it1", identifiedItemDescription: "", itemPlane: "wall", primaryLandmark, relativePosition, secondLandmark, relativeExtentFraction };
}
function stagedConfirm(opts: Partial<LandmarkConfirmationObservation>): LandmarkConfirmationObservation {
  return {
    itemId: "it1",
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
{
  const v = compareVanishedLandmarkObservations(
    baseChoice("wall-mounted AC unit", "left of it, close", "room corner", 0.7),
    stagedConfirm({ primaryLandmarkStillPresent: "no", whatOccupiesLandmarkLocationNow: "plain continuous painted wall" })
  );
  check("AC unit genuinely removed (Bedroom 12 style)", v.verdict, "fail_vanished_landmark", v.reason);
}

console.log("\n=== Strict path: primary landmark occluded, genuinely unable to tell (must NOT be a fail) ===");
{
  const v = compareVanishedLandmarkObservations(
    baseChoice("AC unit", "left of it, close", "room corner", 0.7),
    stagedConfirm({ primaryLandmarkStillPresent: "cannot_tell", primaryLandmarkLocationDescription: "completely blocked by a large wardrobe" })
  );
  check("Landmark blocked by new wardrobe", v.verdict, "inconclusive_occluded", v.reason);
}

console.log("\n=== Strict path: both landmarks present, consistent (must PASS) ===");
{
  const v = compareVanishedLandmarkObservations(
    baseChoice("the doorway", "left of it, close", "the corner", 0.8),
    stagedConfirm({ primaryLandmarkStillPresent: "yes", relativePosition: "left of it, close", secondLandmarkStillPresent: "yes", relativeExtentFraction: 0.78 })
  );
  check("Consistent, unchanged", v.verdict, "pass", v.reason);
}

console.log("\n=== Strict path: both present, direction changed (must fail_repositioned) ===");
{
  const v = compareVanishedLandmarkObservations(
    baseChoice("the curtain rod bracket", "left of it, touching", "the corner", 0.8),
    stagedConfirm({ primaryLandmarkStillPresent: "yes", relativePosition: "right of it, close", secondLandmarkStillPresent: "yes", relativeExtentFraction: 0.8 })
  );
  check("Direction flips", v.verdict, "fail_repositioned", v.reason);
}

console.log("\n=== Strict path: both present, extent dropped >25% (must fail_resized) ===");
{
  const v = compareVanishedLandmarkObservations(
    baseChoice("the curtain rod", "below it, touching", "the corner", 1.0),
    stagedConfirm({ primaryLandmarkStillPresent: "yes", relativePosition: "below it, touching", secondLandmarkStillPresent: "yes", relativeExtentFraction: 0.4 })
  );
  check("Extent drops from 1.0 to 0.4", v.verdict, "fail_resized", v.reason);
}

console.log("\n=== Strict path: second landmark confirmed absent (must also be a conclusive fail) ===");
{
  const v = compareVanishedLandmarkObservations(
    baseChoice("the doorway", "left of it, close", "the far wall corner", 0.8),
    stagedConfirm({ primaryLandmarkStillPresent: "yes", relativePosition: "left of it, close", secondLandmarkStillPresent: "no" })
  );
  check("Second landmark vanished", v.verdict, "fail_vanished_landmark", v.reason);
}

console.log("\n=== Strict path: second landmark cannot_tell (bug-fix regression guard — must be inconclusive_occluded, NOT silently pass) ===");
{
  const v = compareVanishedLandmarkObservations(
    baseChoice("the doorway", "left of it, close", "the far corner", 0.8),
    stagedConfirm({ primaryLandmarkStillPresent: "yes", relativePosition: "left of it, close", secondLandmarkStillPresent: "cannot_tell", relativeExtentFraction: null })
  );
  check("Second landmark cannot_tell", v.verdict, "inconclusive_occluded", v.reason);
}

// ── Fallback path: compareRelativeLandmarkObservations ──
console.log("\n=== Fallback path: landmark mismatch (must default to not-comparable, not-flagged) ===");
function relObs(primaryLandmark: string, relativePosition: string, secondLandmark: string, relativeExtentFraction: number | null): RelativeLandmarkObservation {
  return { itemId: "it1", identifiedItemDescription: "", primaryLandmark, relativePosition, secondLandmark, relativeExtentFraction };
}
{
  const v = compareRelativeLandmarkObservations(
    relObs("the back-right room corner", "left of it, close", "the window", 1.0),
    relObs("the left nightstand lamp", "above it, far", "the bed headboard", 0.4)
  );
  check("Different primary landmarks entirely", `comparable=${v.comparable}`, "comparable=false", v.reason);
}

console.log("\n=== Fallback path: same landmark, large extent drop (must flag resized) ===");
{
  const v = compareRelativeLandmarkObservations(relObs("the curtain rod", "below it, touching", "the room corner", 1.0), relObs("the curtain rod", "below it, touching", "the room corner", 0.4));
  check("Extent fraction drops from 1.0 to 0.4", `resized=${v.resized}`, "resized=true", v.reason);
}

console.log("\n=== Fallback path: same landmark, small extent difference under threshold (must NOT flag) ===");
{
  const v = compareRelativeLandmarkObservations(relObs("the doorway", "left of it, close", "the corner", 1.0), relObs("the doorway", "left of it, close", "the corner", 0.85));
  check("15% relative drop, under 25% threshold", `resized=${v.resized}`, "resized=false", v.reason);
}

// ── Orchestration: combineWithFallback ──
console.log("\n=== combineWithFallback: confirmed absent -> conclusive fail, fallback ignored entirely ===");
function strictBase(overrides: Partial<VanishedLandmarkVerdict>): VanishedLandmarkVerdict {
  return { verdict: "pass", vanishedLandmark: null, resized: false, repositioned: false, extentDeltaPct: null, positionDirectionChanged: null, reason: "", ...overrides };
}
function fallbackBase(overrides: Partial<RelativeLandmarkVerdict>): RelativeLandmarkVerdict {
  return { comparable: true, resized: false, repositioned: false, extentDeltaPct: null, positionDirectionChanged: null, reason: "", ...overrides };
}
{
  const v = combineWithFallback(strictBase({ verdict: "fail_vanished_landmark", vanishedLandmark: "primary", reason: "confirmed absent" }), fallbackBase({ resized: true }));
  check("no -> fail_vanished_landmark, fallback ignored even if supplied", `${v.verdict}|${v.usedFallback}`, "fail_vanished_landmark|false", v.reason);
}

console.log("\n=== combineWithFallback: both confirmed present, resolves cleanly, no fallback ===");
{
  const v = combineWithFallback(strictBase({ verdict: "pass" }), null);
  check("yes/yes, pass", `${v.verdict}|${v.usedFallback}`, "pass|false", v.reason);
}
{
  const v = combineWithFallback(strictBase({ verdict: "fail_resized", resized: true }), null);
  check("yes/yes, fail_resized", `${v.verdict}|${v.usedFallback}`, "fail_resized|false", v.reason);
}

console.log("\n=== combineWithFallback: cannot_tell -> fallback triggered ===");
{
  const v = combineWithFallback(strictBase({ verdict: "inconclusive_occluded" }), fallbackBase({ comparable: true, resized: true }));
  check("cannot_tell, fallback resized", `${v.verdict}|${v.usedFallback}`, "fail_resized_fallback|true", v.reason);
}
{
  const v = combineWithFallback(strictBase({ verdict: "inconclusive_occluded" }), fallbackBase({ comparable: true, repositioned: true }));
  check("cannot_tell, fallback repositioned", `${v.verdict}|${v.usedFallback}`, "fail_repositioned_fallback|true", v.reason);
}
{
  const v = combineWithFallback(strictBase({ verdict: "inconclusive_occluded" }), fallbackBase({ comparable: false }));
  check("cannot_tell, fallback also not comparable -> safe default pass", `${v.verdict}|${v.usedFallback}`, "pass|true", v.reason);
}
{
  const v = combineWithFallback(strictBase({ verdict: "inconclusive_occluded" }), null);
  check("cannot_tell, no fallback supplied -> safe default pass", `${v.verdict}|${v.usedFallback}`, "pass|true", v.reason);
}

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
