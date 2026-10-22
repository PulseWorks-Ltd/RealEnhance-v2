// Offline verification of the PRODUCTION window-artwork check
// (worker/src/validators/windowArtworkCheck.ts), now wired into
// openingEnvelopeValidator.ts. Reuses the exact case set from
// tmp/verify_implausibleStaging_offline.ts's Part B section — the pure
// evaluate function is unchanged logic, just moved and restructured for
// batched observation input.
import { evaluateWindowArtworkReplacement, isWindowArtworkCheckApplicable, type WindowArtworkObservation } from "../worker/src/validators/windowArtworkCheck";

let failures = 0;
function check(label: string, actualVerdict: string, expectVerdict: string, reason: string) {
  const pass = actualVerdict === expectVerdict;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: verdict=${actualVerdict} (${reason}) (expected ${expectVerdict})`);
  if (!pass) failures++;
}

console.log("=== window replaced by artwork ===");
function windowObs(artworkAtLocation: WindowArtworkObservation["artworkAtLocation"], locationDescription = ""): Omit<WindowArtworkObservation, "itemId"> {
  return { locationDescription, artworkAtLocation };
}
{
  const v = evaluateWindowArtworkReplacement("window", windowObs("yes", "a large framed painting occupies the full window footprint"));
  check("window + artwork yes -> fail", v.verdict, "fail_window_replaced_by_artwork", v.reason);
}
{
  const v = evaluateWindowArtworkReplacement("window", windowObs("no", "genuine glass and frame visible, curtains hung normally"));
  check("window + artwork no -> pass", v.verdict, "pass", v.reason);
}
{
  const v = evaluateWindowArtworkReplacement("window", windowObs("cannot_tell"));
  check("window + cannot_tell -> pass (conservative default)", v.verdict, "pass", v.reason);
}
{
  const v = evaluateWindowArtworkReplacement("door", windowObs("yes"));
  check("non-window type -> not_applicable regardless of artwork field", v.verdict, "not_applicable", v.reason);
}
{
  const v = evaluateWindowArtworkReplacement("WINDOW", windowObs("yes"));
  check("case-insensitive type match", v.verdict, "fail_window_replaced_by_artwork", v.reason);
}

console.log("\n=== isWindowArtworkCheckApplicable direct checks ===");
{
  const cases: Array<[string, boolean]> = [
    ["window", true],
    ["door", false],
    ["closet_door", false],
    ["walkthrough", false],
    ["fireplace", false],
  ];
  for (const [type, expected] of cases) {
    const actual = isWindowArtworkCheckApplicable(type);
    const pass = actual === expected;
    console.log(`${pass ? "PASS" : "FAIL"} isWindowArtworkCheckApplicable("${type}") = ${actual} (expected ${expected})`);
    if (!pass) failures++;
  }
}

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
