// Live test of the window-replaced-by-artwork rule. STANDALONE, not wired
// to production. Positive control: Living 10 (job_9f64fe2a — window
// genuinely replaced by a hung painting, visually confirmed during
// planning). False-positive control: f53669f1 (window genuinely intact,
// unrelated framed print present elsewhere in the room — visually
// confirmed during planning, a real match, not a proxy).
import path from "path";
process.env.STAGE2_VALIDATOR_MODEL = process.env.STAGE2_VALIDATOR_MODEL || "grok";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { observeWindowArtworkReplacement, evaluateWindowArtworkReplacement } from "./implausibleStagingCheck";
import { buildSemanticReference, pickLargestOpening, type PickedItem } from "./semanticItemRef";

const ROOT = path.join(__dirname, "..");
const PRODIMG = path.join(__dirname, "prodimg");

type Case = {
  label: string;
  baselinePath: string;
  stagedPath: string;
  jobId: string;
  expectFail: boolean;
};

const CASES: Case[] = [
  {
    label: "Living 10 / job_9f64fe2a (window replaced by painting — should FAIL)",
    baselinePath: path.join(PRODIMG, "baseline_9f64fe2a.jpg"),
    stagedPath: path.join(PRODIMG, "attempt1_9f64fe2a.webp"),
    jobId: "windowart-living10",
    expectFail: true,
  },
  {
    label: "f53669f1 (window genuinely intact, unrelated art elsewhere — must NOT fail)",
    baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"),
    jobId: "windowart-f53669f1",
    expectFail: false,
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
      item = pickLargestOpening(baseline, ["window"]);
    } catch (e: any) {
      console.log(`  BASELINE EXTRACTION FAILED: ${e?.message || e}`);
    }

    if (!item) {
      console.log(`  Could not pick a window — skipping.`);
      summary.push(`${c.label}: SKIPPED (no window found)`);
      continue;
    }

    const semanticRef = buildSemanticReference(item);
    console.log(`  item.type="${item.type}" | semantic reference: "${semanticRef}"`);

    let failCount = 0;
    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      const obs = await observeWindowArtworkReplacement({ imagePath: c.stagedPath, semanticRef, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `run${run}` } });
      console.log(`  artworkAtLocation="${obs.artworkAtLocation}" | locationDescription="${obs.locationDescription}"`);
      const verdict = evaluateWindowArtworkReplacement(item.type, obs);
      console.log(`  VERDICT: ${verdict.verdict} (${verdict.reason})`);
      if (verdict.verdict === "fail_window_replaced_by_artwork") failCount++;
    }

    const line = `${c.label}: failed ${failCount}/${RUNS_PER_CASE} (expected fail=${c.expectFail})`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Window Replaced by Artwork)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
