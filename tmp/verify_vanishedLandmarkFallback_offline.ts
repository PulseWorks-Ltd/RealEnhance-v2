import { combineWithFallback } from "./vanishedLandmarkWithFallback";
import type { VanishedLandmarkVerdict } from "./vanishedLandmarkCheck";
import type { RelativeLandmarkVerdict } from "./relativeLandmarkResizeCheck";

let failures = 0;
function check(label: string, strict: VanishedLandmarkVerdict, fallback: RelativeLandmarkVerdict | null, expectVerdict: string, expectUsedFallback: boolean) {
  const v = combineWithFallback(strict, fallback);
  const pass = v.verdict === expectVerdict && v.usedFallback === expectUsedFallback;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: verdict=${v.verdict} usedFallback=${v.usedFallback} (${v.reason}) (expected ${expectVerdict}, usedFallback=${expectUsedFallback})`);
  if (!pass) failures++;
}

function strictBase(overrides: Partial<VanishedLandmarkVerdict>): VanishedLandmarkVerdict {
  return { verdict: "pass", vanishedLandmark: null, resized: false, repositioned: false, extentDeltaPct: null, positionDirectionChanged: null, reason: "", ...overrides };
}
function fallbackBase(overrides: Partial<RelativeLandmarkVerdict>): RelativeLandmarkVerdict {
  return { comparable: true, resized: false, repositioned: false, extentDeltaPct: null, positionDirectionChanged: null, reason: "", ...overrides };
}

console.log("=== Confirmed absent -> conclusive fail, no fallback attempted (must short-circuit BEFORE fallback, even if a fallback observation happens to be supplied) ===");
check(
  "no -> fail_vanished_landmark, fallback ignored entirely",
  strictBase({ verdict: "fail_vanished_landmark", vanishedLandmark: "primary", reason: "confirmed absent" }),
  fallbackBase({ resized: true }), // even if supplied, must be ignored — confirmed absence always wins
  "fail_vanished_landmark",
  false
);

console.log("\n=== Both confirmed present, strict comparison resolves cleanly -> unchanged from last task, no fallback ===");
check("yes/yes, pass", strictBase({ verdict: "pass" }), null, "pass", false);
check("yes/yes, fail_resized", strictBase({ verdict: "fail_resized", resized: true }), null, "fail_resized", false);
check("yes/yes, fail_repositioned", strictBase({ verdict: "fail_repositioned", repositioned: true }), null, "fail_repositioned", false);

console.log("\n=== cannot_tell -> fallback triggered ===");
check(
  "cannot_tell, fallback resized",
  strictBase({ verdict: "inconclusive_occluded" }),
  fallbackBase({ comparable: true, resized: true }),
  "fail_resized_fallback",
  true
);
check(
  "cannot_tell, fallback repositioned",
  strictBase({ verdict: "inconclusive_occluded" }),
  fallbackBase({ comparable: true, repositioned: true }),
  "fail_repositioned_fallback",
  true
);
check(
  "cannot_tell, fallback comparable but no change",
  strictBase({ verdict: "inconclusive_occluded" }),
  fallbackBase({ comparable: true, resized: false, repositioned: false }),
  "pass",
  true
);
check(
  "cannot_tell, fallback ALSO not comparable (landmark mismatch on the substitute too) -> safe default pass, not a fail",
  strictBase({ verdict: "inconclusive_occluded" }),
  fallbackBase({ comparable: false }),
  "pass",
  true
);
check("cannot_tell, no fallback supplied at all -> safe default pass", strictBase({ verdict: "inconclusive_occluded" }), null, "pass", true);

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
