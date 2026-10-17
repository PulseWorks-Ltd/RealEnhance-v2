import { combineFabricatedOpeningVerdict } from "../worker/src/validators/fabricatedOpeningCheck";

let failures = 0;
function check(label: string, verdict: any, expectStatus: "pass" | "fail", expectVerdict: string) {
  const pass = verdict.outcome.status === expectStatus && verdict.verdict === expectVerdict;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: status=${verdict.outcome.status} verdict=${verdict.verdict} hardFail=${verdict.outcome.hardFail} (expected status=${expectStatus} verdict=${expectVerdict})`);
  if (!pass) failures++;
}

// Branch 1: fabricated — call1 flagged, call2 says absent from baseline
check(
  "Fabricated case (job_8505488a-style)",
  combineFabricatedOpeningVerdict({
    location: "far-left wall, ceiling to floor",
    locationBbox: [0, 0.15, 0.15, 0.85],
    call1Description: "A rectangular doorway with white trim, opening into another room with a console table.",
    presentInBaseline: false,
    call2Description: "Continuous flat painted wall with a heater mounted on it; no opening, gap, or doorway anywhere in this region.",
  }),
  "fail",
  "fabricated"
);

// Branch 2: baseline_extraction_miss — call1 flagged, call2 confirms present
check(
  "Baseline-extraction-miss case (synthetic)",
  combineFabricatedOpeningVerdict({
    location: "right wall, mid-height",
    locationBbox: [0.85, 0.3, 1, 0.8],
    call1Description: "A closet door with mirrored panels.",
    presentInBaseline: true,
    call2Description: "Yes, the same mirrored closet door is visible at this exact location in the baseline photo.",
  }),
  "pass",
  "baseline_extraction_miss"
);

// Branch 3 (call1 not flagged) is handled before combineFabricatedOpeningVerdict
// is ever called (early return in runFabricatedOpeningCheck), so it's not
// exercised by this pure-function test — verified by code inspection instead:
// `if (!call1?.foundUnlistedOpening) return { ...verdict: "clean", outcome: CLEAN_OUTCOME }`
// runs before any call to combineFabricatedOpeningVerdict.

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
