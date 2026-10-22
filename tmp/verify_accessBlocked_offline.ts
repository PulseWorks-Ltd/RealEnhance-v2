import { evaluateAccessBlocked, isAccessCheckApplicable, type AccessBlockedObservation } from "./accessBlockedCheck";

let failures = 0;
function check(label: string, itemType: string, observation: AccessBlockedObservation, expectVerdict: string) {
  const v = evaluateAccessBlocked(itemType, observation);
  const pass = v.verdict === expectVerdict;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: verdict=${v.verdict} (${v.reason}) (expected ${expectVerdict})`);
  if (!pass) failures++;
}

function obs(accessBlocked: AccessBlockedObservation["accessBlocked"], clearanceDescription = ""): AccessBlockedObservation {
  return { clearanceDescription, accessBlocked };
}

console.log("=== Type scoping (per explicit user direction: door, closet_door, walkthrough all applicable; window/fixtures are not) ===");
check("door blocked -> fail", "door", obs("blocked", "dresser and mirror fully span the door's footprint"), "fail_access_blocked");
check("closet_door blocked -> fail (user explicitly included closet doors)", "closet_door", obs("blocked", "dresser pushed directly across the sliding track"), "fail_access_blocked");
check("walkthrough blocked -> fail", "walkthrough", obs("blocked", "sofa placed directly across the opening"), "fail_access_blocked");
check("window blocked -> not_applicable (windows don't require passage access)", "window", obs("blocked", "furniture in front of window"), "not_applicable");
check("light_fixture -> not_applicable", "light_fixture", obs("blocked"), "not_applicable");
check("ac_unit -> not_applicable", "ac_unit", obs("blocked"), "not_applicable");
check("fireplace -> not_applicable", "fireplace", obs("blocked"), "not_applicable");

console.log("\n=== Applicable type, but access genuinely clear -> must NOT fail ===");
check(
  "closet_door with furniture nearby but path clear -> pass (Bedroom 11 FIXED style)",
  "closet_door",
  obs("clear", "a low dresser sits beside the closet, but the sliding door's own track and swing path remain unobstructed"),
  "pass"
);
check("door, no furniture at all -> pass", "door", obs("clear", "clear open floor leading to the door"), "pass");

console.log("\n=== cannot_tell must NOT fail (conservative default, same philosophy as every classifier tonight) ===");
check("closet_door, ambiguous visibility -> pass (not a fail)", "closet_door", obs("cannot_tell", "too dark to tell if anything blocks the path"), "pass");
check("door, cropped out of frame -> pass (not a fail)", "door", obs("cannot_tell", "the location is cropped out of frame"), "pass");

console.log("\n=== Case-insensitivity / defensive parsing ===");
check("Uppercase type still matches", "DOOR", obs("blocked"), "fail_access_blocked");

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
