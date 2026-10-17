import {
  evaluateWindowArtworkReplacement,
  isWindowArtworkCheckApplicable,
  evaluateArtworkOnDoorSurface,
  isArtworkOnDoorCheckApplicable,
  type WindowArtworkObservation,
  type ArtworkOnDoorObservation,
  type DoorSurfaceType,
} from "./implausibleStagingCheck";

let failures = 0;
function check(label: string, actualVerdict: string, expectVerdict: string, reason: string) {
  const pass = actualVerdict === expectVerdict;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: verdict=${actualVerdict} (${reason}) (expected ${expectVerdict})`);
  if (!pass) failures++;
}

console.log("=== B: window replaced by artwork ===");
function windowObs(artworkAtLocation: WindowArtworkObservation["artworkAtLocation"], locationDescription = ""): WindowArtworkObservation {
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

console.log("\n=== C: artwork mounted on door surface ===");
function doorObs(doorSurfaceType: DoorSurfaceType, artworkMountedOnDoor: ArtworkOnDoorObservation["artworkMountedOnDoor"], doorSurfaceDescription = "", mountedArtworkDescription = ""): ArtworkOnDoorObservation {
  return { doorSurfaceDescription, doorSurfaceType, mountedArtworkDescription, artworkMountedOnDoor };
}
{
  const v = evaluateArtworkOnDoorSurface("door", undefined, doorObs("glass_panes", "yes", "glazed panes visible", "a canvas hangs directly on the glass"));
  check("door + fresh glass_panes + artwork yes -> fail", v.verdict, "fail_artwork_on_door_surface", v.reason);
}
{
  const v = evaluateArtworkOnDoorSurface("door", undefined, doorObs("flush_solid", "yes", "plain solid panel", "somehow claims artwork present"));
  check("door + flush_solid (fresh AND baseline both indicate nothing special) -> not_applicable even if artwork claimed", v.verdict, "not_applicable", v.reason);
}
{
  const v = evaluateArtworkOnDoorSurface("closet_door", "Full-height sliding closet doors with one mirrored panel", doorObs("flush_solid", "yes", "fresh read now shows a flush panel (obscured by the artwork itself)", "large canvas covers the door"));
  check("closet_door: fresh says flush_solid, but BASELINE says mirrored -> applicable via OR-scoping -> fail", v.verdict, "fail_artwork_on_door_surface", v.reason);
}
{
  const v = evaluateArtworkOnDoorSurface("door", undefined, doorObs("sliding_panel", "no", "sliding door track visible", "nothing mounted on the door"));
  check("door + sliding_panel + artwork no -> pass", v.verdict, "pass", v.reason);
}
{
  const v = evaluateArtworkOnDoorSurface("door", undefined, doorObs("mirror_panel", "cannot_tell"));
  check("door + mirror_panel + cannot_tell -> pass (conservative default)", v.verdict, "pass", v.reason);
}
{
  const v = evaluateArtworkOnDoorSurface("window", undefined, doorObs("mirror_panel", "yes"));
  check("window item type -> not_applicable regardless of other fields", v.verdict, "not_applicable", v.reason);
}
{
  const v = evaluateArtworkOnDoorSurface("closet_door", undefined, doorObs("glass_panes", "yes"));
  check("closet_door applicable type", v.verdict, "fail_artwork_on_door_surface", v.reason);
}

console.log("\n=== isArtworkOnDoorCheckApplicable direct checks ===");
{
  const cases: Array<[string, boolean]> = [
    ["door", true],
    ["closet_door", true],
    ["window", false],
    ["walkthrough", false],
    ["fireplace", false],
  ];
  for (const [type, expected] of cases) {
    const actual = isArtworkOnDoorCheckApplicable(type);
    const pass = actual === expected;
    console.log(`${pass ? "PASS" : "FAIL"} isArtworkOnDoorCheckApplicable("${type}") = ${actual} (expected ${expected})`);
    if (!pass) failures++;
  }
}

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
