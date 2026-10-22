// Live test of the vanished-landmark redesign. STANDALONE, not wired to
// production. False-positive risk (known-clean cases) tested first per
// explicit user priority.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { observeLandmarkChoice, observeLandmarkConfirmation, compareVanishedLandmarkObservations } from "./vanishedLandmarkCheck";
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
  expectFail: boolean;
};

// Order matters: false-positive controls (known-clean) FIRST, per explicit
// user priority — "the critical question" this task exists to answer.
const CASES: Case[] = [
  {
    label: "f53669f1 window (KNOWN CLEAN — must NOT fail)",
    baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"),
    jobId: "vl-f53669f1-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFail: false,
  },
  {
    label: "3e255f88 ceiling lights (KNOWN CLEAN — must NOT fail)",
    baselinePath: path.join(PRODIMG, "baseline_3e255f88.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_3e255f88.webp"),
    jobId: "vl-3e255f88-lights",
    pick: (b) => pickLargestFixture(b, ["light_fixture"]),
    expectFail: false,
  },
  {
    label: "Bedroom 12 sliding door (KNOWN VIOLATION — AC unit removed + door relocated — should now fail)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 12.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 12-2.webp"),
    jobId: "vl-b12-door",
    pick: (b) => {
      const allOpenings = [...(b?.openings || [])];
      const slidingDoor = allOpenings.find((o: any) => /sliding/i.test(o.description || "") && /(door|glass)/i.test(o.description || ""));
      return slidingDoor
        ? { id: slidingDoor.id, type: slidingDoor.type, description: slidingDoor.description, wallIndex: slidingDoor.wallIndex, horizontalBand: slidingDoor.horizontalBand, verticalBand: slidingDoor.verticalBand, bbox: slidingDoor.bbox }
        : pickLargestOpening(b, ["door", "walkthrough"]);
    },
    expectFail: true,
  },
  {
    label: "Bedroom 09 window (KNOWN VIOLATION — genuine resize)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 09.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 09 (Enhanced).webp"),
    jobId: "vl-b09-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFail: true,
  },
];

const RUNS_PER_CASE = 3;

async function main() {
  console.log(`Validator model: ${process.env.STAGE2_VALIDATOR_MODEL}`);
  const summary: string[] = [];

  for (const c of CASES) {
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

    let failCount = 0;
    let vanishedCount = 0;
    let inconclusiveCount = 0;
    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      // Sequential, not parallel: call 2 needs call 1's chosen landmark.
      const baselineObs = await observeLandmarkChoice({ imagePath: c.baselinePath, semanticRef, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `baseline_run${run}` } });
      console.log(`  BASELINE identity: "${baselineObs.identifiedItemDescription}" | plane=${baselineObs.itemPlane}`);
      console.log(`  BASELINE: primaryLandmark="${baselineObs.primaryLandmark}" | relativePosition="${baselineObs.relativePosition}" | secondLandmark="${baselineObs.secondLandmark}" | extentFraction=${baselineObs.relativeExtentFraction}`);

      const stagedObs = await observeLandmarkConfirmation({
        imagePath: c.stagedPath,
        semanticRef,
        primaryLandmark: baselineObs.primaryLandmark,
        secondLandmark: baselineObs.secondLandmark,
        ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `staged_run${run}` },
      });
      console.log(`  STAGED identity: "${stagedObs.identifiedItemDescription}"`);
      console.log(`  STAGED: primaryLandmarkLocationDescription="${stagedObs.primaryLandmarkLocationDescription}" | primaryLandmarkStillPresent=${stagedObs.primaryLandmarkStillPresent}`);
      console.log(`  STAGED: relativePosition="${stagedObs.relativePosition}" | secondLandmarkLocationDescription="${stagedObs.secondLandmarkLocationDescription}" | secondLandmarkStillPresent=${stagedObs.secondLandmarkStillPresent}`);
      console.log(`  STAGED: extentFraction=${stagedObs.relativeExtentFraction} | whatOccupiesLandmarkLocationNow="${stagedObs.whatOccupiesLandmarkLocationNow}"`);

      const verdict = compareVanishedLandmarkObservations(baselineObs, stagedObs);
      console.log(`  VERDICT: ${verdict.verdict} (${verdict.reason})`);
      if (verdict.verdict.startsWith("fail")) failCount++;
      if (verdict.verdict === "fail_vanished_landmark") vanishedCount++;
      if (verdict.verdict === "inconclusive_occluded") inconclusiveCount++;
    }

    const line = `${c.label}: failed ${failCount}/${RUNS_PER_CASE} (vanished_landmark=${vanishedCount}, inconclusive_occluded=${inconclusiveCount}) (expected fail=${c.expectFail})`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Vanished-Landmark Redesign)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
