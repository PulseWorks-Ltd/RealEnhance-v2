// LIVE test of the two-call single-image-observation resize/relocation mechanism.
// Standalone — does not touch any production validator.
//
// For each case: extract a structural baseline from the BASELINE image only to
// get a real approxBbox pointer for the target item, then run observeSingleImage()
// separately against baseline and staged images (no comparison shown to either
// call), multiple times each, and run compareSingleImageObservations() in code.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { observeSingleImage, compareSingleImageObservations, type SingleImageObservation } from "./singleImageResizeCheck";

process.env.STAGE2_VALIDATOR_MODEL = process.env.STAGE2_VALIDATOR_MODEL || "grok";

type Case = {
  label: string;
  baselinePath: string;
  stagedPath: string;
  jobId: string;
  // how to find the target bbox within the extracted baseline
  pick: (baseline: any) => [number, number, number, number] | null;
  expectFlagged: boolean;
};

const ROOT = path.join(__dirname, "..");
const PRODIMG = path.join(__dirname, "prodimg");
const BEDROOM_BASE = path.join(ROOT, "Test Images", "Bedroom (Baseline)");
const BEDROOM_STAGED = path.join(ROOT, "Test Images", "Bedroom (Staged)");

function pickLargestOpening(types: string[]) {
  return (baseline: any): [number, number, number, number] | null => {
    const openings = (baseline?.openings || []).filter((o: any) => types.includes(o.type));
    if (openings.length === 0) return null;
    openings.sort((a: any, b: any) => (b.area_pct || 0) - (a.area_pct || 0));
    return openings[0].bbox;
  };
}

function pickLargestFixture(types: string[]) {
  return (baseline: any): [number, number, number, number] | null => {
    const fixtures = (baseline?.anchorFixtures || []).filter((f: any) => types.includes(f.type));
    if (fixtures.length === 0) return null;
    fixtures.sort((a: any, b: any) => {
      const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
      const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
      return areaB - areaA;
    });
    return fixtures[0].bbox;
  };
}

const CASES: Case[] = [
  {
    label: "Bedroom 09 window (KNOWN GENUINE RESIZE — positive control)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 09.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 09 (Enhanced).webp"),
    jobId: "live-b09-window",
    pick: pickLargestOpening(["window"]),
    expectFlagged: true,
  },
  {
    label: "Bedroom 12 sliding door (KNOWN GENUINE RESIZE/RELOCATION — positive control)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 12.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 12-2.webp"),
    jobId: "live-b12-door",
    pick: pickLargestOpening(["door", "walkthrough"]),
    expectFlagged: true,
  },
  {
    label: "f53669f1 window (KNOWN FALSE POSITIVE — must NOT flag)",
    baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"),
    jobId: "live-f53669f1-window",
    pick: pickLargestOpening(["window"]),
    expectFlagged: false,
  },
  {
    label: "3e255f88 ceiling lights (KNOWN FALSE POSITIVE — must NOT flag)",
    baselinePath: path.join(PRODIMG, "baseline_3e255f88.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_3e255f88.webp"),
    jobId: "live-3e255f88-lights",
    pick: pickLargestFixture(["light_fixture"]),
    expectFlagged: false,
  },
];

const RUNS_PER_CASE = 3;

async function main() {
  console.log(`Validator model: ${process.env.STAGE2_VALIDATOR_MODEL}`);
  const summary: string[] = [];

  for (const c of CASES) {
    console.log(`\n${"=".repeat(80)}\n${c.label}\n${"=".repeat(80)}`);

    let approxBbox: [number, number, number, number] | null = null;
    try {
      const baseline: any = await extractStructuralBaseline(c.baselinePath, { jobId: c.jobId, imageId: c.jobId });
      approxBbox = c.pick(baseline);
    } catch (e: any) {
      console.log(`  BASELINE EXTRACTION FAILED: ${e?.message || e}`);
    }

    if (!approxBbox) {
      console.log(`  Could not derive an approxBbox pointer from baseline extraction — skipping this case.`);
      summary.push(`${c.label}: SKIPPED (no approxBbox)`);
      continue;
    }
    console.log(`  approxBbox pointer (from baseline extraction): [${approxBbox.map((v) => v.toFixed(3)).join(", ")}]`);

    const runResults: { resized: boolean; repositioned: boolean; sizeChangePct: number | null; centerShiftFraction: number | null; baselineObs: SingleImageObservation; stagedObs: SingleImageObservation }[] = [];

    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      const [baselineObs, stagedObs] = await Promise.all([
        observeSingleImage({ imagePath: c.baselinePath, approxBbox, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `baseline_run${run}` } }),
        observeSingleImage({ imagePath: c.stagedPath, approxBbox, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `staged_run${run}` } }),
      ]);
      console.log(`  BASELINE: refs="${baselineObs.referencePoints}" | boundary="${baselineObs.boundaryDescription}" | bbox=${JSON.stringify(baselineObs.bboxEstimate)} | edge=${baselineObs.touchesFrameEdge}`);
      console.log(`  STAGED:   refs="${stagedObs.referencePoints}" | boundary="${stagedObs.boundaryDescription}" | bbox=${JSON.stringify(stagedObs.bboxEstimate)} | edge=${stagedObs.touchesFrameEdge}`);

      const verdict = compareSingleImageObservations(baselineObs, stagedObs);
      console.log(`  VERDICT: resized=${verdict.resized} repositioned=${verdict.repositioned} (${verdict.reason})`);
      runResults.push({ ...verdict, baselineObs, stagedObs });
    }

    const flaggedCount = runResults.filter((r) => r.resized || r.repositioned).length;
    const line = `${c.label}: flagged ${flaggedCount}/${RUNS_PER_CASE} runs (expected flagged=${c.expectFlagged})`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
