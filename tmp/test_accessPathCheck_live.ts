// Live test of the decomposed access-path check, looped across both Gemini
// (the user's explicit ask) and Grok (for direct comparison against the
// already-measured old tri-state signal: Bedroom 02 2/3, Bedroom 11 FIXED
// 1/3). STANDALONE, not wired to production.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { observeAccessPath, evaluateAccessPath, isAccessCheckApplicable } from "./accessPathCheck";
import { buildSemanticReference, pickLargestOpening, type PickedItem } from "./semanticItemRef";

const ROOT = path.join(__dirname, "..");
const BEDROOM_BASE = path.join(ROOT, "Test Images", "Bedroom (Baseline)");
const BEDROOM_STAGED = path.join(ROOT, "Test Images", "Bedroom (Staged)");

type Case = {
  label: string;
  baselinePath: string;
  stagedPath: string;
  jobIdPrefix: string;
  pick: (baseline: any) => PickedItem | null;
  expectFail: boolean;
};

const CASES: Case[] = [
  {
    label: "Bedroom 02 (door walled over, dresser+mirror in front — should register FAIL)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 02.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 02 (Enhanced).webp"),
    jobIdPrefix: "accesspath-b02",
    pick: (b) => pickLargestOpening(b, ["closet_door", "door"]),
    expectFail: true,
  },
  {
    label: "Bedroom 11 FIXED (closet door behind dresser, confirmed PASS case)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 11.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 11-staged-FIXED-controlled.webp"),
    jobIdPrefix: "accesspath-b11-fixed",
    pick: (b) => pickLargestOpening(b, ["closet_door", "door"]),
    expectFail: false,
  },
];

const RUNS_PER_CASE = 3;
const MODELS = ["gemini", "grok"];

async function main() {
  const summary: string[] = [];

  for (const model of MODELS) {
    process.env.STAGE2_VALIDATOR_MODEL = model;
    console.log(`\n\n${"#".repeat(80)}\nMODEL: ${model}\n${"#".repeat(80)}`);

    for (const c of CASES) {
      console.log(`\n${"=".repeat(80)}\n[${model}] ${c.label}\n${"=".repeat(80)}`);
      const jobId = `${c.jobIdPrefix}-${model}`;

      let item: PickedItem | null = null;
      try {
        const baseline: any = await extractStructuralBaseline(c.baselinePath, { jobId, imageId: jobId });
        item = c.pick(baseline);
      } catch (e: any) {
        console.log(`  BASELINE EXTRACTION FAILED: ${e?.message || e}`);
      }

      if (!item) {
        console.log(`  Could not pick a target item — skipping.`);
        summary.push(`[${model}] ${c.label}: SKIPPED (no item)`);
        continue;
      }

      const semanticRef = buildSemanticReference(item);
      console.log(`  item.type="${item.type}" | applicable=${isAccessCheckApplicable(item.type)} | semantic reference: "${semanticRef}"`);

      let failCount = 0;
      let inconclusiveCount = 0;
      for (let run = 1; run <= RUNS_PER_CASE; run++) {
        console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
        try {
          const obs = await observeAccessPath({ imagePath: c.stagedPath, semanticRef, ctx: { jobId, imageId: jobId, callLabel: `run${run}`, attempt: run } });
          console.log(`  blocksEntirePathState="${obs.blocksEntirePathState}" | hasWalkwayAccessState="${obs.hasWalkwayAccessState}"`);
          console.log(`  clearanceDescription="${obs.clearanceDescription}"`);
          const verdict = evaluateAccessPath(item.type, obs);
          console.log(`  VERDICT: ${verdict.verdict} (${verdict.reason})`);
          if (verdict.verdict === "fail_access_blocked") failCount++;
          if (verdict.verdict === "inconclusive_conflicting_signals") inconclusiveCount++;
        } catch (e: any) {
          console.log(`  ERROR: ${e?.message || e}`);
        }
      }

      const line = `[${model}] ${c.label}: failed ${failCount}/${RUNS_PER_CASE}, inconclusive ${inconclusiveCount}/${RUNS_PER_CASE} (expected fail=${c.expectFail})`;
      console.log(`\n  SUMMARY: ${line}`);
      summary.push(line);
    }
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Access-Path, decomposed, cross-model)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
