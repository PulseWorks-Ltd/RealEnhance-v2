// Full standing-regression test: vanish-check (+ fallback) and pane-count
// (wall-gap-structure), run independently against every established case
// this session, before any production-integration decision. STANDALONE.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runVanishedLandmarkWithFallback } from "./vanishedLandmarkWithFallback";
import { observeWallGapStructure, compareWallGapObservations } from "./wallGapStructureCheck";
import { buildSemanticReference, pickLargestOpening, pickLargestFixture, type PickedItem } from "./semanticItemRef";

process.env.STAGE2_VALIDATOR_MODEL = process.env.STAGE2_VALIDATOR_MODEL || "grok";

const ROOT = path.join(__dirname, "..");
const PRODIMG = path.join(__dirname, "prodimg");
const BEDROOM_BASE = path.join(ROOT, "Test Images", "Bedroom (Baseline)");
const BEDROOM_STAGED = path.join(ROOT, "Test Images", "Bedroom (Staged)");
const LIVING_BASE = path.join(ROOT, "Test Images", "Living (Baseline)");

function pickSlidingDoorByDescription(b: any): PickedItem | null {
  const allOpenings = [...(b?.openings || [])];
  const slidingDoor = allOpenings.find((o: any) => /sliding/i.test(o.description || "") && /(door|glass)/i.test(o.description || ""));
  return slidingDoor
    ? { id: slidingDoor.id, type: slidingDoor.type, description: slidingDoor.description, wallIndex: slidingDoor.wallIndex, horizontalBand: slidingDoor.horizontalBand, verticalBand: slidingDoor.verticalBand, bbox: slidingDoor.bbox }
    : pickLargestOpening(b, ["door", "walkthrough"]);
}

type Case = {
  label: string;
  baselinePath: string;
  stagedPath: string;
  jobId: string;
  pick: (baseline: any) => PickedItem | null;
  expectFail: boolean;
  designCase: boolean; // true = one of the two original mechanisms were tuned against
};

const CASES: Case[] = [
  {
    label: "Bedroom 11 UNFIXED (window infilled)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 11.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 11-staged-UNFIXED-controlled.webp"),
    jobId: "reg-b11-unfixed",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFail: true,
    designCase: false,
  },
  {
    label: "Bedroom 11 FIXED (closet door behind dresser)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 11.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 11-staged-FIXED-controlled.webp"),
    jobId: "reg-b11-fixed",
    pick: (b) => pickLargestOpening(b, ["closet_door", "door"]),
    expectFail: false,
    designCase: false,
  },
  {
    label: "Living 10 (job_9f64fe2a — window replaced by painting)",
    baselinePath: path.join(PRODIMG, "baseline_9f64fe2a.jpg"),
    stagedPath: path.join(PRODIMG, "attempt1_9f64fe2a.webp"),
    jobId: "reg-living10",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFail: true,
    designCase: false,
  },
  {
    label: "Living 07 fireplace (occlusion, clean)",
    baselinePath: path.join(LIVING_BASE, "Living 07.jpg"),
    stagedPath: path.join(LIVING_BASE, "Living 07-staged.webp"),
    jobId: "reg-living07",
    pick: (b) => pickLargestFixture(b, ["fireplace"]),
    expectFail: false,
    designCase: false,
  },
  {
    label: "Bedroom 02 (door walled over, confirmed genuine violation)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 02.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 02 (Enhanced).webp"),
    jobId: "reg-b02",
    pick: (b) => pickLargestOpening(b, ["closet_door", "door"]),
    expectFail: true,
    designCase: false,
  },
  {
    label: "Bedroom 09 (known genuine resize)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 09.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 09 (Enhanced).webp"),
    jobId: "reg-b09",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFail: true,
    designCase: true,
  },
  {
    label: "Bedroom 12 (AC removed + door relocated)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 12.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 12-2.webp"),
    jobId: "reg-b12",
    pick: pickSlidingDoorByDescription,
    expectFail: true,
    designCase: true,
  },
  {
    label: "f53669f1 window (known clean)",
    baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"),
    jobId: "reg-f53669f1",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFail: false,
    designCase: true,
  },
  {
    label: "3e255f88 ceiling lights (known clean; pane-count expected not applicable)",
    baselinePath: path.join(PRODIMG, "baseline_3e255f88.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_3e255f88.webp"),
    jobId: "reg-3e255f88",
    pick: (b) => pickLargestFixture(b, ["light_fixture"]),
    expectFail: false,
    designCase: true,
  },
];

const RUNS_PER_CASE = 3;

async function runVanishOnce(c: Case, run: number): Promise<{ fail: boolean; label: string } | { error: string }> {
  try {
    const result = await runVanishedLandmarkWithFallback({
      baselinePath: c.baselinePath,
      stagedPath: c.stagedPath,
      semanticRef: (c as any)._semanticRef,
      ctx: { jobId: c.jobId, imageId: `${c.jobId}-vanish-run${run}` },
    });
    console.log(`  [VANISH run${run}] combined=${result.combined.verdict} usedFallback=${result.combined.usedFallback} | strict=${result.strictVerdict.verdict} | (${result.combined.reason})`);
    return { fail: result.combined.verdict.startsWith("fail"), label: result.combined.verdict };
  } catch (e: any) {
    console.log(`  [VANISH run${run}] ERROR: ${e?.message || e}`);
    return { error: e?.message || String(e) };
  }
}

async function runWallGapOnce(c: Case, run: number): Promise<{ fail: boolean; label: string } | { error: string }> {
  try {
    const [baselineObs, stagedObs] = await Promise.all([
      observeWallGapStructure({ imagePath: c.baselinePath, semanticRef: (c as any)._semanticRef, itemType: (c as any)._itemType, ctx: { jobId: c.jobId, imageId: `${c.jobId}-wallgap-run${run}`, callLabel: `baseline_run${run}` } }),
      observeWallGapStructure({ imagePath: c.stagedPath, semanticRef: (c as any)._semanticRef, itemType: (c as any)._itemType, ctx: { jobId: c.jobId, imageId: `${c.jobId}-wallgap-run${run}`, callLabel: `staged_run${run}` } }),
    ]);
    const verdict = compareWallGapObservations(baselineObs, stagedObs);
    console.log(
      `  [WALLGAP run${run}] verdict=${verdict.verdict} boundaryShift=${verdict.boundaryShiftDetected}(${verdict.boundaryDelta}) qualifiedByNewObject=${verdict.boundaryQualifiedByNewObject} | baseline presence=${baselineObs.itemPresenceState} boundary=${baselineObs.boundarySizeCategory}(${baselineObs.boundaryDefinedBy}) count=${baselineObs.itemStructureCount} ("${baselineObs.itemStructureDescription}") | staged presence=${stagedObs.itemPresenceState} boundary=${stagedObs.boundarySizeCategory}(${stagedObs.boundaryDefinedBy}) loc=("${stagedObs.itemLocationDescription}") trace=("${stagedObs.structuralTraceDescription}") count=${stagedObs.itemStructureCount} ("${stagedObs.itemStructureDescription}")`
    );
    return { fail: verdict.verdict.startsWith("fail"), label: verdict.verdict };
  } catch (e: any) {
    console.log(`  [WALLGAP run${run}] ERROR: ${e?.message || e}`);
    return { error: e?.message || String(e) };
  }
}

async function main() {
  console.log(`Validator model: ${process.env.STAGE2_VALIDATOR_MODEL}`);
  const tableRows: string[] = [];

  const casesToRun = process.env.ONLY_JOB_IDS ? CASES.filter((c) => process.env.ONLY_JOB_IDS!.split(",").includes(c.jobId)) : CASES;
  for (const c of casesToRun) {
    console.log(`\n${"=".repeat(80)}\n${c.label} (expectFail=${c.expectFail}, designCase=${c.designCase})\n${"=".repeat(80)}`);

    let item: PickedItem | null = null;
    try {
      const baseline: any = await extractStructuralBaseline(c.baselinePath, { jobId: c.jobId, imageId: c.jobId });
      item = c.pick(baseline);
    } catch (e: any) {
      console.log(`  BASELINE EXTRACTION FAILED: ${e?.message || e}`);
    }

    if (!item) {
      console.log(`  Could not pick a target item from baseline extraction — SKIPPING this case entirely.`);
      tableRows.push(`${c.label} | expectFail=${c.expectFail} | SKIPPED (no item found)`);
      continue;
    }

    const semanticRef = buildSemanticReference(item);
    (c as any)._semanticRef = semanticRef;
    (c as any)._itemType = item.type;
    console.log(`  item.type="${item.type}" | semantic reference: "${semanticRef}"`);

    let vanishFails = 0,
      vanishErrors = 0,
      wallGapFails = 0,
      wallGapErrors = 0,
      combinedFails = 0;

    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      const [vanish, wallGap] = await Promise.all([runVanishOnce(c, run), runWallGapOnce(c, run)]);

      const vanishFailed = "fail" in vanish && vanish.fail;
      const wallGapFailed = "fail" in wallGap && wallGap.fail;
      if ("error" in vanish) vanishErrors++;
      else if (vanishFailed) vanishFails++;
      if ("error" in wallGap) wallGapErrors++;
      else if (wallGapFailed) wallGapFails++;
      if (vanishFailed || wallGapFailed) combinedFails++;
    }

    const line = `${c.label} | expectFail=${c.expectFail} | designCase=${c.designCase} | VANISH: ${vanishFails}/${RUNS_PER_CASE} fail (${vanishErrors} errors) | WALLGAP: ${wallGapFails}/${RUNS_PER_CASE} fail (${wallGapErrors} errors) | COMBINED: ${combinedFails}/${RUNS_PER_CASE} fail`;
    console.log(`\n  SUMMARY: ${line}`);
    tableRows.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL REGRESSION TABLE\n${"=".repeat(80)}`);
  for (const r of tableRows) console.log(r);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
