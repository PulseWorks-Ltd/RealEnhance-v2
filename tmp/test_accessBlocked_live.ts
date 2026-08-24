// Live test of the access-blocked signal, targeted at the two critical
// contrasting cases: Bedroom 02 (door, genuinely blocked — should FAIL via
// this signal) vs. Bedroom 11 FIXED (closet door, confirmed PASS case —
// this signal must NOT break it, per the visual-occlusion-vs-physical-
// access distinction). STANDALONE, not wired to production.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { observeAccessBlocked, evaluateAccessBlocked, isAccessCheckApplicable } from "./accessBlockedCheck";
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
  expectBlocked: boolean;
};

const CASES: Case[] = [
  {
    label: "Bedroom 02 (door walled over, dresser+mirror in front — should register BLOCKED)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 02.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 02 (Enhanced).webp"),
    jobId: "access-b02",
    pick: (b) => pickLargestOpening(b, ["closet_door", "door"]),
    expectBlocked: true,
  },
  {
    label: "Bedroom 11 FIXED (closet door behind dresser, confirmed PASS case — must NOT register as blocked)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 11.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 11-staged-FIXED-controlled.webp"),
    jobId: "access-b11-fixed",
    pick: (b) => pickLargestOpening(b, ["closet_door", "door"]),
    expectBlocked: false,
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
      console.log(`  Could not pick a target item — skipping.`);
      summary.push(`${c.label}: SKIPPED (no item)`);
      continue;
    }

    const semanticRef = buildSemanticReference(item);
    console.log(`  item.type="${item.type}" | applicable=${isAccessCheckApplicable(item.type)} | semantic reference: "${semanticRef}"`);

    let blockedCount = 0;
    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      const obs = await observeAccessBlocked({ imagePath: c.stagedPath, semanticRef, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `run${run}` } });
      console.log(`  accessBlocked="${obs.accessBlocked}" | clearanceDescription="${obs.clearanceDescription}"`);
      const verdict = evaluateAccessBlocked(item.type, obs);
      console.log(`  VERDICT: ${verdict.verdict} (${verdict.reason})`);
      if (verdict.verdict === "fail_access_blocked") blockedCount++;
    }

    const line = `${c.label}: blocked ${blockedCount}/${RUNS_PER_CASE} runs (expected blocked=${c.expectBlocked})`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Access-Blocked Signal)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
