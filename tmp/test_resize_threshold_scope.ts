import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const REPO_ROOT = path.resolve(__dirname, "..");

async function runOnce(label: string, baselinePath: string, stagedPath: string, focusId: string, jobId: string, runIdx: number) {
  const ctx = { jobId: `${jobId}-r${runIdx}`, imageId: `${jobId}-r${runIdx}` };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const result = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  const item = result.itemResults.find((r: any) => r.id === focusId || r.description?.toLowerCase().includes(focusId.toLowerCase()));
  console.log(`\n########## ${label} run ${runIdx} ##########`);
  if (!item) {
    console.log(`NO MATCHING ITEM for focusId=${focusId}. All items: ${result.itemResults.map((r: any) => `${r.id}(${r.type})`).join(", ")}`);
    // fall back: print all items' resize/reposition classification
    for (const it of result.itemResults as any[]) {
      console.log(`  ${it.id} verdict=${it.verdict} resized=${it.classification.resized.value} repositioned=${it.classification.repositioned.value}`);
      console.log(`    extentComparisonDescription: ${it.rawObservation.extentComparisonDescription}`);
    }
    return { label, runIdx, verdict: "NO_ITEM" };
  }
  console.log(`verdict=${item.verdict} resized=${item.classification.resized.value} repositioned=${item.classification.repositioned.value}`);
  console.log(`extentComparisonDescription: ${item.rawObservation.extentComparisonDescription}`);
  return { label, runIdx, verdict: item.verdict, resized: item.classification.resized.value, repositioned: item.classification.repositioned.value };
}

async function main() {
  const which = process.argv[2];
  const runIdx = process.argv[3] ? Number(process.argv[3]) : null;
  const results = [];
  const runs = runIdx ? [runIdx] : [1, 2, 3];
  for (const r of runs) {
    try {
      if (which === "bedroom12") {
        const baselinePath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");
        const stagedPath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12-2.webp");
        results.push(await runOnce("Bedroom 12 sliding door (D1)", baselinePath, stagedPath, "sliding", "resize-scope-bedroom12", r));
      } else if (which === "bedroom09") {
        const baselinePath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 09.jpg");
        const stagedPath = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)/Bedroom 09 (Enhanced).webp");
        results.push(await runOnce("Bedroom 09 window (genuine resize)", baselinePath, stagedPath, "window", "resize-scope-bedroom09", r));
      }
    } catch (e: any) {
      console.error(`ERROR run ${r}:`, e?.message || e);
      results.push({ label: which, runIdx: r, error: String(e?.message || e) });
    }
  }
  console.log("\n\n================ SUMMARY ================");
  for (const r of results) console.log(JSON.stringify(r));
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
