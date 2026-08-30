// Verifies a real production false-positive found analyzing
// Logs/logs.1787557821015.log: two independent hard-fails (job_bb5814f4
// attempt 1 opening A1, job_f61d8dc1 attempt 2 opening D1) both landed on
// verdict="resized" even though extentComparisonDescription plainly states
// nothing changed. Testing classifyResized/classifyRepositioned directly
// against the real captured text to confirm this is a genuine classifier
// miss, not a misread of the log.
import { classifyResized, classifyRepositioned } from "../worker/src/validators/occlusionVsRemovalCheck";

const case1 = "The opening has the same width, height, and position in both photos. The half-wall height and the span of the pass-through match the baseline footprint with no visible enlargement, shrinkage, or shift.";
const case2 = "The sliding door's overall footprint—spanning from near the left edge across roughly half the room width and from roughly mid-wall height down toward the floor—matches closely between baseline and staged photos in size, shape, and wall position; the black vertical mullions and header align the same way in both.";

for (const [label, text] of [["job_bb5814f4 attempt1 A1", case1], ["job_f61d8dc1 attempt2 D1", case2]] as const) {
  const resized = classifyResized(text);
  const repositioned = classifyRepositioned(text);
  console.log(`\n=== ${label} ===`);
  console.log(`text: "${text}"`);
  console.log(`classifyResized -> value=${resized.value} confidence=${resized.confidence} matchedPattern=${resized.matchedPattern}`);
  console.log(`classifyRepositioned -> value=${repositioned.value} confidence=${repositioned.confidence} matchedPattern=${repositioned.matchedPattern}`);
}
