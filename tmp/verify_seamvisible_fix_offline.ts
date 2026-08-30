// Offline verification of the classifySeamVisible fix, before any live
// API call — same discipline as every classifier fix tonight. Tests the
// exact real captured text from the last verification task's two runs,
// plus a real positive-case sanity check (must not regress the passing
// direction while fixing the failing one).
import { classifySeamVisible } from "../worker/src/validators/flooringBoundaryCheck";

function check(label: string, text: string, expectedValue: boolean) {
  const result = classifySeamVisible(text);
  const pass = result.value === expectedValue;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${label}`);
  console.log(`  text: "${text}"`);
  console.log(`  expected value=${expectedValue}, got value=${result.value}, confidence=${result.confidence}, matchedPattern=${result.matchedPattern}`);
  return pass;
}

let allPass = true;

// Real captured text, run 1, zone 1 boundaryDescription (previously
// misclassified as value=true/preserved; must now be value=false/lost).
allPass = check(
  "Run 1 zone 1 boundary (real failing text #1)",
  "Where this zone originally met the carpet, no obvious seam, threshold, or two-material transition stands out. The dark floor looks continuous from the living area into the dining area with no clear boundary line visible along that edge.",
  false
) && allPass;

// Real captured text, run 2, zone 1 boundaryDescription (previously
// misclassified as value=true/preserved; must now be value=false/lost).
allPass = check(
  "Run 2 zone 1 boundary (real failing text #2)",
  "The carpet still meets the light stone hearth at a clear irregular edge on the lower left. Toward the right/mid area where a different smoother floor originally began, no distinct seam or threshold is visible anymore—the dark carpet appears to run continuously under the dining set with no material change line.",
  false
) && allPass;

// Real captured text, run 2, zone 2 boundaryDescription — this one
// already correctly classified as false before the fix (bare "no seam"
// with no intervening adjective); confirm it STILL correctly classifies
// as false after the fix (no regression on the already-working case).
allPass = check(
  "Run 2 zone 2 boundary (already-correct case, must stay correct)",
  "No seam, threshold, or transition line to a different flooring material is visible along the former carpet–vinyl edge; the floor reads as one continuous dark carpet surface into the living area.",
  false
) && allPass;

// Real POSITIVE case — a genuinely preserved boundary, must still
// classify as value=true/visible (don't regress the passing direction).
allPass = check(
  "Run 1 zone 2 boundary (real positive case, hearth-to-carpet, must stay true)",
  "The stone hearth still has a clear edge against the surrounding dark carpet; the transition between the light flagstone and the carpet remains easy to see.",
  true
) && allPass;

allPass = check(
  "Run 2 zone 3 boundary (real positive case, hearth-to-carpet, must stay true)",
  "A clear boundary remains where the light stone hearth meets the surrounding dark carpet—the irregular stone edge and material change are still obvious.",
  true
) && allPass;

console.log(`\n\n=== ${allPass ? "ALL OFFLINE CHECKS PASSED" : "SOME OFFLINE CHECKS FAILED"} ===`);
process.exit(allPass ? 0 : 1);
