// Live test of the wall-gap + item-structure hypothesis, scoped to
// Bedroom 09 and Bedroom 12 per explicit request — compare against every
// other mechanism's results on these same two positive controls tonight.
// STANDALONE, not wired to production.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { observeWallGapStructure, compareWallGapObservations } from "./wallGapStructureCheck";
import { buildSemanticReference, pickLargestOpening, type PickedItem } from "./semanticItemRef";

process.env.STAGE2_VALIDATOR_MODEL = process.env.STAGE2_VALIDATOR_MODEL || "grok";

const ROOT = path.join(__dirname, "..");
const BEDROOM_BASE = path.join(ROOT, "Test Images", "Bedroom (Baseline)");
const BEDROOM_STAGED = path.join(ROOT, "Test Images", "Bedroom (Staged)");

type Case = {
  label: string;
  baselinePath: string;
  stagedPath: string;
  jobId: string;
  pick: (baseline: any) => PickedItem | null;
};

const CASES: Case[] = [
  {
    label: "Bedroom 09 window (KNOWN VIOLATION — pure resize)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 09.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 09 (Enhanced).webp"),
    jobId: "wg-b09-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
  },
  {
    label: "Bedroom 12 sliding door (KNOWN VIOLATION — AC unit removed + door relocated)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 12.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 12-2.webp"),
    jobId: "wg-b12-door",
    pick: (b) => {
      const allOpenings = [...(b?.openings || [])];
      const slidingDoor = allOpenings.find((o: any) => /sliding/i.test(o.description || "") && /(door|glass)/i.test(o.description || ""));
      return slidingDoor
        ? { id: slidingDoor.id, type: slidingDoor.type, description: slidingDoor.description, wallIndex: slidingDoor.wallIndex, horizontalBand: slidingDoor.horizontalBand, verticalBand: slidingDoor.verticalBand, bbox: slidingDoor.bbox }
        : pickLargestOpening(b, ["door", "walkthrough"]);
    },
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
    const verdictCounts: Record<string, number> = {};
    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      const [baselineObs, stagedObs] = await Promise.all([
        observeWallGapStructure({ imagePath: c.baselinePath, semanticRef, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `baseline_run${run}` } }),
        observeWallGapStructure({ imagePath: c.stagedPath, semanticRef, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `staged_run${run}` } }),
      ]);
      console.log(`  BASELINE: corner="${baselineObs.nearestCenterCorner}"`);
      console.log(`  BASELINE: gap="${baselineObs.gapDescription}" | gapCategory=${baselineObs.gapSizeCategory}`);
      console.log(`  BASELINE: structure="${baselineObs.itemStructureDescription}" | count=${baselineObs.itemStructureCount}`);
      console.log(`  STAGED: corner="${stagedObs.nearestCenterCorner}"`);
      console.log(`  STAGED: gap="${stagedObs.gapDescription}" | gapCategory=${stagedObs.gapSizeCategory}`);
      console.log(`  STAGED: structure="${stagedObs.itemStructureDescription}" | count=${stagedObs.itemStructureCount}`);

      const verdict = compareWallGapObservations(baselineObs, stagedObs);
      console.log(`  VERDICT: ${verdict.verdict} (${verdict.reason})`);

      verdictCounts[verdict.verdict] = (verdictCounts[verdict.verdict] || 0) + 1;
      if (verdict.verdict.startsWith("fail")) failCount++;
    }

    const line = `${c.label}: failed ${failCount}/${RUNS_PER_CASE} (${JSON.stringify(verdictCounts)}) (expected fail=true — known violation)`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Wall-Gap + Item-Structure)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
