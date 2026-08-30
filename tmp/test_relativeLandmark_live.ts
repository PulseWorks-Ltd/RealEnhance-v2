// PART 2 live test: relative-landmark comparison vs. Variant B's raw bbox
// comparison, same four cases, same rigor. STANDALONE, not wired to
// production.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { observeRelativeLandmark, compareRelativeLandmarkObservations } from "./relativeLandmarkResizeCheck";
import { buildSemanticReference, pickLargestOpening, pickLargestFixture, type PickedItem } from "./semanticItemRef";

process.env.STAGE2_VALIDATOR_MODEL = process.env.STAGE2_VALIDATOR_MODEL || "grok";

const ROOT = path.join(__dirname, "..");
const PRODIMG = path.join(__dirname, "prodimg");
const BEDROOM_BASE = path.join(ROOT, "Test Images", "Bedroom (Baseline)");
const BEDROOM_STAGED = path.join(ROOT, "Test Images", "Bedroom (Staged)");

type Case = {
  label: string;
  baselinePath: string;
  stagedPath: string;
  jobId: string;
  pick: (baseline: any) => PickedItem | null;
  expectFlagged: boolean;
};

const CASES: Case[] = [
  {
    label: "Bedroom 09 window (KNOWN GENUINE RESIZE — positive control)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 09.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 09 (Enhanced).webp"),
    jobId: "rl-b09-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFlagged: true,
  },
  {
    label: "Bedroom 12 sliding door (KNOWN GENUINE RESIZE/RELOCATION — positive control)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 12.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 12-2.webp"),
    jobId: "rl-b12-door",
    // Baseline extraction is non-deterministic about type labeling for this
    // specific item (seen classified as "door" in one extraction pass and
    // "window" in another, same physical sliding glass door both times —
    // confirmed via raw OPENING_BASELINE JSON). Matching by type alone
    // silently picked the WRONG opening in one live run (an unrelated
    // walkthrough, A1, instead of the sliding door). Match by description
    // content instead, which is stable regardless of type mislabeling.
    pick: (b) => {
      const allOpenings = [...(b?.openings || [])];
      const slidingDoor = allOpenings.find((o: any) => /sliding/i.test(o.description || "") && /(door|glass)/i.test(o.description || ""));
      return slidingDoor
        ? { id: slidingDoor.id, type: slidingDoor.type, description: slidingDoor.description, wallIndex: slidingDoor.wallIndex, horizontalBand: slidingDoor.horizontalBand, verticalBand: slidingDoor.verticalBand, bbox: slidingDoor.bbox }
        : pickLargestOpening(b, ["door", "walkthrough"]);
    },
    expectFlagged: true,
  },
  {
    label: "f53669f1 window (KNOWN FALSE POSITIVE — must NOT flag)",
    baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"),
    jobId: "rl-f53669f1-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFlagged: false,
  },
  {
    label: "3e255f88 ceiling lights (KNOWN FALSE POSITIVE — must NOT flag)",
    baselinePath: path.join(PRODIMG, "baseline_3e255f88.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_3e255f88.webp"),
    jobId: "rl-3e255f88-lights",
    pick: (b) => pickLargestFixture(b, ["light_fixture"]),
    expectFlagged: false,
  },
];

const RUNS_PER_CASE = 3;

async function main() {
  console.log(`Validator model: ${process.env.STAGE2_VALIDATOR_MODEL}`);
  const summary: string[] = [];

  const casesToRun = process.env.ONLY_JOB_ID ? CASES.filter((c) => c.jobId === process.env.ONLY_JOB_ID) : CASES;
  for (const c of casesToRun) {
    console.log(`\n${"=".repeat(80)}\n${c.label}\n${"=".repeat(80)}`);

    let item: PickedItem | null = null;
    try {
      const baseline: any = await extractStructuralBaseline(c.baselinePath, { jobId: c.jobId, imageId: c.jobId });
      item = c.pick(baseline);
    } catch (e: any) {
      console.log(`  BASELINE EXTRACTION FAILED: ${e?.message || e}`);
    }

    if (!item) {
      console.log(`  Could not pick a target item from baseline extraction — skipping this case.`);
      summary.push(`${c.label}: SKIPPED (no item)`);
      continue;
    }

    const semanticRef = buildSemanticReference(item);
    console.log(`  semantic reference: "${semanticRef}"`);

    let flaggedCount = 0;
    let resizedCount = 0;
    let repositionedCount = 0;
    let notComparableCount = 0;
    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      const [baselineObs, stagedObs] = await Promise.all([
        observeRelativeLandmark({ imagePath: c.baselinePath, semanticRef, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `baseline_run${run}` } }),
        observeRelativeLandmark({ imagePath: c.stagedPath, semanticRef, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `staged_run${run}` } }),
      ]);
      console.log(`  BASELINE identity: "${baselineObs.identifiedItemDescription}"`);
      console.log(`  BASELINE: primaryLandmark="${baselineObs.primaryLandmark}" | relativePosition="${baselineObs.relativePosition}" | secondLandmark="${baselineObs.secondLandmark}" | extentFraction=${baselineObs.relativeExtentFraction}`);
      console.log(`  STAGED identity: "${stagedObs.identifiedItemDescription}"`);
      console.log(`  STAGED: primaryLandmark="${stagedObs.primaryLandmark}" | relativePosition="${stagedObs.relativePosition}" | secondLandmark="${stagedObs.secondLandmark}" | extentFraction=${stagedObs.relativeExtentFraction}`);

      const verdict = compareRelativeLandmarkObservations(baselineObs, stagedObs);
      console.log(`  VERDICT: comparable=${verdict.comparable} resized=${verdict.resized} repositioned=${verdict.repositioned} (${verdict.reason})`);
      if (!verdict.comparable) notComparableCount++;
      if (verdict.resized) resizedCount++;
      if (verdict.repositioned) repositionedCount++;
      if (verdict.resized || verdict.repositioned) flaggedCount++;
    }

    const line = `${c.label}: flagged ${flaggedCount}/${RUNS_PER_CASE} (resized=${resizedCount}, repositioned=${repositionedCount}, not-comparable=${notComparableCount}) (expected flagged=${c.expectFlagged})`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Relative-Landmark, Part 2)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
