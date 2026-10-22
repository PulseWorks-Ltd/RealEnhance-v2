import { evaluateAccessPath, isAccessCheckApplicable, type AccessPathObservation, type AccessPathTriState } from "./accessPathCheck";

let failures = 0;
function check(label: string, itemType: string, observation: AccessPathObservation, expectVerdict: string) {
  const v = evaluateAccessPath(itemType, observation);
  const pass = v.verdict === expectVerdict;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: verdict=${v.verdict} (${v.reason}) (expected ${expectVerdict})`);
  if (!pass) failures++;
}

function obs(blocksEntirePathState: AccessPathTriState, hasWalkwayAccessState: AccessPathTriState, clearanceDescription = ""): AccessPathObservation {
  return { clearanceDescription, blocksEntirePathState, hasWalkwayAccessState };
}

console.log("=== Full 3x3 truth table (blocksEntirePath x hasWalkwayAccess), applicable type ===");
check("yes/no -> fail (both agree: unusable)", "door", obs("yes", "no", "dresser spans the full width, no gap"), "fail_access_blocked");
check("no/yes -> pass (both agree: clear)", "door", obs("no", "yes", "clear open path"), "pass");
check("yes/yes -> inconclusive (self-contradictory)", "door", obs("yes", "yes"), "inconclusive_conflicting_signals");
check("no/no -> inconclusive (self-contradictory)", "door", obs("no", "no"), "inconclusive_conflicting_signals");
check("cannot_tell/no -> inconclusive", "door", obs("cannot_tell", "no"), "inconclusive_conflicting_signals");
check("cannot_tell/yes -> inconclusive", "door", obs("cannot_tell", "yes"), "inconclusive_conflicting_signals");
check("yes/cannot_tell -> inconclusive", "door", obs("yes", "cannot_tell"), "inconclusive_conflicting_signals");
check("no/cannot_tell -> inconclusive", "door", obs("no", "cannot_tell"), "inconclusive_conflicting_signals");
check("cannot_tell/cannot_tell -> inconclusive", "door", obs("cannot_tell", "cannot_tell"), "inconclusive_conflicting_signals");

console.log("\n=== Type scoping ===");
check("closet_door applicable, yes/no -> fail", "closet_door", obs("yes", "no"), "fail_access_blocked");
check("walkthrough applicable, yes/no -> fail", "walkthrough", obs("yes", "no"), "fail_access_blocked");
check("window not applicable, even if yes/no", "window", obs("yes", "no"), "not_applicable");
check("light_fixture not applicable", "light_fixture", obs("yes", "no"), "not_applicable");
check("fireplace not applicable", "fireplace", obs("yes", "no"), "not_applicable");

console.log("\n=== Case-insensitivity ===");
check("Uppercase DOOR still applicable", "DOOR", obs("yes", "no"), "fail_access_blocked");

console.log("\n=== isAccessCheckApplicable direct checks ===");
{
  const cases: Array<[string, boolean]> = [
    ["door", true],
    ["closet_door", true],
    ["walkthrough", true],
    ["window", false],
    ["ac_unit", false],
    ["fireplace", false],
    ["built_in_cabinet", false],
    ["kitchen_island", false],
    ["staircase", false],
    ["plumbing_fixture", false],
    ["light_fixture", false],
    ["other", false],
  ];
  for (const [type, expected] of cases) {
    const actual = isAccessCheckApplicable(type);
    const pass = actual === expected;
    console.log(`${pass ? "PASS" : "FAIL"} isAccessCheckApplicable("${type}") = ${actual} (expected ${expected})`);
    if (!pass) failures++;
  }
}

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
