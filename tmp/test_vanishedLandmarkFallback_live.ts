// Live test of the vanish-check + fallback-extent split. STANDALONE, not
// wired to production.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runVanishedLandmarkWithFallback } from "./vanishedLandmarkWithFallback";
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

const CASES: Case[] = [
  {
    label: "f53669f1 window (KNOWN CLEAN — must NOT fail)",
    baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"),
    jobId: "vf-f53669f1-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFail: false,
  },
  {
    label: "3e255f88 ceiling lights (KNOWN CLEAN — must NOT fail)",
    baselinePath: path.join(PRODIMG, "baseline_3e255f88.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_3e255f88.webp"),
    jobId: "vf-3e255f88-lights",
    pick: (b) => pickLargestFixture(b, ["light_fixture"]),
    expectFail: false,
  },
  {
    label: "Bedroom 12 sliding door (KNOWN VIOLATION — AC unit removed + door relocated)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 12.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 12-2.webp"),
    jobId: "vf-b12-door",
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
    label: "Bedroom 09 window (KNOWN VIOLATION — pure resize, no landmark vanishing — the case being fixed)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 09.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 09 (Enhanced).webp"),
    jobId: "vf-b09-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFail: true,
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

    let failCount = 0;
    const verdictCounts: Record<string, number> = {};
    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      const result = await runVanishedLandmarkWithFallback({
        baselinePath: c.baselinePath,
        stagedPath: c.stagedPath,
        semanticRef,
        ctx: { jobId: c.jobId, imageId: `${c.jobId}-run${run}` },
      });

      console.log(`  BASELINE: primaryLandmark="${result.baselineChoice.primaryLandmark}" | relativePosition="${result.baselineChoice.relativePosition}" | secondLandmark="${result.baselineChoice.secondLandmark}" | extentFraction=${result.baselineChoice.relativeExtentFraction}`);
      console.log(`  STAGED (strict confirm): primary=${result.stagedConfirm.primaryLandmarkStillPresent} | second=${result.stagedConfirm.secondLandmarkStillPresent} | relativePosition="${result.stagedConfirm.relativePosition}" | extentFraction=${result.stagedConfirm.relativeExtentFraction}`);
      console.log(`  STRICT VERDICT: ${result.strictVerdict.verdict} (${result.strictVerdict.reason})`);
      if (result.stagedFallbackChoice) {
        console.log(`  FALLBACK staged free choice: primaryLandmark="${result.stagedFallbackChoice.primaryLandmark}" | relativePosition="${result.stagedFallbackChoice.relativePosition}" | secondLandmark="${result.stagedFallbackChoice.secondLandmark}" | extentFraction=${result.stagedFallbackChoice.relativeExtentFraction}`);
        console.log(`  FALLBACK VERDICT: ${JSON.stringify(result.fallbackVerdict)}`);
      }
      console.log(`  COMBINED VERDICT: ${result.combined.verdict} usedFallback=${result.combined.usedFallback} (${result.combined.reason})`);

      verdictCounts[result.combined.verdict] = (verdictCounts[result.combined.verdict] || 0) + 1;
      if (result.combined.verdict.startsWith("fail")) failCount++;
    }

    const line = `${c.label}: failed ${failCount}/${RUNS_PER_CASE} (${JSON.stringify(verdictCounts)}) (expected fail=${c.expectFail})`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Vanish-Check + Fallback-Extent Split)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
