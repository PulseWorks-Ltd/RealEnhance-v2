import { classifyResized, classifyRepositioned } from "../worker/src/validators/occlusionVsRemovalCheck";

let failures = 0;
function check(label: string, text: string, expectChanged: boolean) {
  const resized = classifyResized(text);
  const repositioned = classifyRepositioned(text);
  const extentChanged = resized.value || repositioned.value;
  const pass = extentChanged === expectChanged;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: resized=${resized.value}(${resized.matchedPattern}) repositioned=${repositioned.value}(${repositioned.matchedPattern}) extentChanged=${extentChanged} (expected ${expectChanged})`);
  if (!pass) failures++;
}

console.log("=== Plausible NEW-prompt-format outputs: genuine large change (must be caught) ===");
check("Bedroom 12 door style large-change answer", "Step 1: the door's own frame and glass appear roughly 50% smaller than the given region, and shifted about one door-width to the right. Step 2: this is far more than 25%, so this is a real, obvious change, not camera angle.", true);
check("Simple percentage-only phrasing", "The window's own frame appears roughly 40% narrower than the given region.", true);
check("Shift-only phrasing", "The item has shifted roughly a third of the wall's length to the left compared to the given region.", true);

console.log("\n=== Plausible NEW-prompt-format outputs: genuine small difference (must NOT be flagged) ===");
check("Small percentage, explicitly under 25%", "About the same, within 5% — the window's own frame occupies essentially the same fraction of the wall as the given region, same spot.", false);
check("Camera angle correctly invoked after small estimate", "Step 1: appears about 10% different in size, same general position. Step 2: this is a small difference, consistent with ordinary camera angle variation, not a real resize.", false);

console.log("\n=== Original false-positive cases from earlier tonight (must still correctly NOT flag) ===");
check(
  "job_f53669f1 W1 window (original captured false positive)",
  "The window's own frame and glazed area occupy the same wide landscape footprint and position under the bulkhead as the given region, with no apparent change in size, shape, or shift along the wall.",
  false
);
check(
  "job_3e255f88 ceiling lights (original captured false positive)",
  "The fixture occupies roughly the same small circular footprint and position as the given region, with no visible change in size, shape, or shift along the ceiling.",
  false
);

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
