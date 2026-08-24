// False-positive check for the wall-gap + item-structure mechanism, using
// the EXACT unmodified module from the last task. STANDALONE, not wired to
// production.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { observeWallGapStructure, compareWallGapObservations } from "./wallGapStructureCheck";
import { buildSemanticReference, pickLargestOpening, pickLargestFixture, type PickedItem } from "./semanticItemRef";

process.env.STAGE2_VALIDATOR_MODEL = process.env.STAGE2_VALIDATOR_MODEL || "grok";

const ROOT = path.join(__dirname, "..");
const PRODIMG = path.join(__dirname, "prodimg");

type Case = {
  label: string;
  baselinePath: string;
  stagedPath: string;
  jobId: string;
  pick: (baseline: any) => PickedItem | null;
};

const CASES: Case[] = [
  {
    label: "f53669f1 window (KNOWN CLEAN — must NOT fail)",
    baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"),
    jobId: "wgfp-f53669f1-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
  },
  {
    label: "3e255f88 ceiling lights (KNOWN CLEAN — must NOT fail; pane-count applicability uncertain, reported explicitly)",
    baselinePath: path.join(PRODIMG, "baseline_3e255f88.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_3e255f88.webp"),
    jobId: "wgfp-3e255f88-lights",
    pick: (b) => pickLargestFixture(b, ["light_fixture"]),
  },
];

const RUNS_PER_CASE = 3;

async function main() {
  console.log(`Validator model: ${process.env.STAGE2_VALIDATOR_MODEL}`);
  const summary: string[] = [];

  const casesToRun = process.env.ONLY_JOB_IDS ? CASES.filter((c) => process.env.ONLY_JOB_IDS!.split(",").includes(c.jobId)) : CASES;
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
    console.log(`  item.type = "${item.type}"`);

    let failCount = 0;
    let structureMismatchCount = 0;
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
      console.log(`  PANE/STRUCTURE COUNT MATCH: ${baselineObs.itemStructureCount === stagedObs.itemStructureCount ? "MATCH (correct)" : "MISMATCH (potential false positive — diagnose below)"}`);

      verdictCounts[verdict.verdict] = (verdictCounts[verdict.verdict] || 0) + 1;
      if (verdict.verdict.startsWith("fail")) failCount++;
      if (verdict.structureCountChanged) structureMismatchCount++;
    }

    const line = `${c.label}: failed ${failCount}/${RUNS_PER_CASE} (${JSON.stringify(verdictCounts)}) | structureCountMismatches=${structureMismatchCount}/${RUNS_PER_CASE} (expected fail=false — known clean)`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Wall-Gap + Item-Structure — False-Positive Check)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
