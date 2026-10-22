// Offline (no API calls) verification of Part A's fix, run against the
// EXACT real production texts captured from Logs/logs.1786960639792.log for
// each job/attempt in the task's test suite. Must pass before any live call.
import {
  classifyMaterialMatch,
  classifySeamVisible,
} from "../worker/src/validators/flooringBoundaryCheck";
import {
  classifyResized,
  classifyRepositioned,
} from "../worker/src/validators/occlusionVsRemovalCheck";

let failures = 0;

function checkMaterial(label: string, text: string, expectMatches: boolean) {
  const r = classifyMaterialMatch(text);
  // r.value === true means "material matches original" (preserved)
  const pass = r.value === expectMatches;
  console.log(
    `${pass ? "PASS" : "FAIL"} [material] ${label}: value=${r.value} confidence=${r.confidence} matchedPattern=${r.matchedPattern} (expected value=${expectMatches})`
  );
  if (!pass) failures++;
}

function checkSeam(label: string, text: string, expectVisible: boolean) {
  const r = classifySeamVisible(text);
  const pass = r.value === expectVisible;
  console.log(
    `${pass ? "PASS" : "FAIL"} [seam] ${label}: value=${r.value} confidence=${r.confidence} matchedPattern=${r.matchedPattern} (expected value=${expectVisible})`
  );
  if (!pass) failures++;
}

function checkResizedRepositioned(label: string, text: string, expectExtentChanged: boolean) {
  const resized = classifyResized(text);
  const repositioned = classifyRepositioned(text);
  const extentChanged = resized.value || repositioned.value;
  const pass = extentChanged === expectExtentChanged;
  console.log(
    `${pass ? "PASS" : "FAIL"} [resize/reposition] ${label}: resized=${resized.value}(${resized.matchedPattern}) repositioned=${repositioned.value}(${repositioned.matchedPattern}) extentChanged=${extentChanged} (expected ${expectExtentChanged})`
  );
  if (!pass) failures++;
}

console.log("=== MUST-NOW-PASS (confirmed false positives — fix must correct) ===\n");

// job_4f09191f attempt 2 floor (verdict was boundary_lost, should now be
// boundary VISIBLE / preserved i.e. classifySeamVisible => true)
checkSeam(
  "job_4f09191f attempt2 floor (zone1)",
  "A clear transition remains visible along the edge where this dark carpet meets the lighter kitchen flooring near the peninsula/counter—the two materials still abut with a distinct seam rather than blending into one continuous surface.",
  true
);

// job_f53669f1 attempt 1 floor (verdict was material_changed, should now be
// material MATCHES / preserved i.e. classifyMaterialMatch => true)
checkMaterial(
  "job_f53669f1 attempt1 floor (zone1)",
  'The same solid black low-pile carpet from the original remains clearly visible across the exposed floor areas (left near the white dresser, right near the nightstand/door, and along the edges). A large white high-pile/shaggy area rug now covers most of the central floor under the bed, sitting on top of that black carpet rather than replacing it.',
  true
);

// job_f53669f1 W1 window resize (verdict was resized, should now be
// extentChanged=false)
checkResizedRepositioned(
  "job_f53669f1 W1 window resize",
  "The window's own frame and glazed area occupy the same wide landscape footprint and position under the bulkhead as the given region, with no apparent change in size, shape, or shift along the wall.",
  false
);

// job_3e255f88 attempt 1 floor (verdict was material_changed, should now be
// preserved)
checkMaterial(
  "job_3e255f88 attempt1 floor (zone1)",
  "The original medium-brown, low-pile carpet with its mottled, textured look is still clearly visible around the edges of the room, near the doorway, and along the walls. A large light cream/off-white area rug with a soft gray abstract pattern now covers most of the central floor under the bed, but it sits on top of the same carpet rather than replacing it—the underlying flooring material matches the baseline carpet.",
  true
);

// job_3e255f88 L1/L2 ceiling light resize (verdict was resized, should now
// be extentChanged=false) — L1 and L2 texts are identical
checkResizedRepositioned(
  "job_3e255f88 L1 ceiling light resize",
  "The fixture occupies roughly the same small circular footprint and position as the given region, with no visible change in size, shape, or shift along the ceiling.",
  false
);
checkResizedRepositioned(
  "job_3e255f88 L2 ceiling light resize",
  "The fixture occupies roughly the same small circular footprint and position as the given region, with no visible change in size, shape, or shift along the ceiling.",
  false
);

console.log("\n=== MUST-STILL-FAIL (genuine violations — must NOT be softened) ===\n");

// job_7121d9d1 attempt 1 floor zone1 (boundary_lost, "is no longer
// visible") — must remain classified as boundary LOST (false)
checkSeam(
  "job_7121d9d1 attempt1 floor (zone1, 'is no longer visible')",
  'The original transition line where this carpet met the smoother floor on the right is no longer visible. The speckled carpet now runs unbroken across that former edge with no seam, threshold, or material change showing.',
  false
);

// job_7121d9d1 attempt 1 floor zone2 ("is gone") — must remain
// material_changed (false = does not match original)
checkMaterial(
  "job_7121d9d1 attempt1 floor (zone2, 'is gone')",
  'The solid dark gray smooth flooring with a slight sheen is gone. This area now shows the same dark gray low-pile carpet with dense speckled pattern as the rest of the room, continuing under the dining table and chairs.',
  false
);

console.log("\n=== Part B regression guardrail: sanity-check contrastive text without negation still trips ===\n");

// Sanity: a genuine "rather than" sentence that DOES assert a change in the
// non-rejected clause must still correctly fail (verifies the strip isn't
// overly broad and doesn't blind the classifier to real violations stated
// in the leading clause).
checkMaterial(
  "synthetic genuine-violation sanity check",
  "The original carpet is gone, replaced by hardwood flooring, rather than remaining visible anywhere in the room.",
  false
);

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
