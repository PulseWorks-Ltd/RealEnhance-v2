// Live verification of the NEWLY-BATCHED production checks
// (worker/src/validators/windowArtworkCheck.ts,
// worker/src/validators/vanishedLandmarkCheck.ts), called through their
// actual production orchestration functions
// (runWindowArtworkCheckForOpenings, runVanishedLandmarkCheckForItems)
// against real baseline extractions (multi-item, exercising the itemId
// array-matching logic the tmp/ per-item tests never touched) — and across
// BOTH models, since production defaults to Gemini and tonight's tmp/
// testing was exclusively Grok. This is an engineering verification of the
// batching restructure, not a fresh statistical re-measurement of the
// underlying mechanism (already established via extensive per-item testing
// earlier tonight).
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runWindowArtworkCheckForOpenings } from "../worker/src/validators/windowArtworkCheck";
import { runVanishedLandmarkCheckForItems } from "../worker/src/validators/vanishedLandmarkCheck";
import type { PickedItem } from "../worker/src/validators/semanticItemRef";

const ROOT = path.join(__dirname, "..");
const PRODIMG = path.join(__dirname, "prodimg");
const BEDROOM_BASE = path.join(ROOT, "Test Images", "Bedroom (Baseline)");

function toPicked(items: any[]): PickedItem[] {
  return (items || []).map((o: any) => ({ id: o.id, type: o.type, description: o.description, wallIndex: o.wallIndex, horizontalBand: o.horizontalBand, verticalBand: o.verticalBand, bbox: o.bbox }));
}

const WINDOW_ARTWORK_CASES = [
  { label: "Living 10 (window replaced by painting — should FAIL)", baselinePath: path.join(PRODIMG, "baseline_9f64fe2a.jpg"), stagedPath: path.join(PRODIMG, "attempt1_9f64fe2a.webp"), jobId: "batch-windowart-living10", expectFail: true },
  { label: "f53669f1 (window genuinely intact — must NOT fail)", baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"), stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"), jobId: "batch-windowart-f53669f1", expectFail: false },
];

const VANISH_CASES = [
  { label: "Bedroom 12 (KNOWN VIOLATION — AC unit removed + door relocated — should FAIL)", baselinePath: path.join(BEDROOM_BASE, "Bedroom 12.jpg"), stagedPath: path.join(BEDROOM_BASE, "Bedroom 12-2.webp"), jobId: "batch-vanish-b12", expectFail: true },
  { label: "Bedroom 11 FIXED (confirmed clean — must NOT fail)", baselinePath: path.join(BEDROOM_BASE, "Bedroom 11.jpg"), stagedPath: path.join(BEDROOM_BASE, "Bedroom 11-staged-FIXED-controlled.webp"), jobId: "batch-vanish-b11fixed", expectFail: false },
];

const MODELS = ["grok", "gemini"];

async function main() {
  const summary: string[] = [];

  for (const model of MODELS) {
    process.env.STAGE2_VALIDATOR_MODEL = model;
    console.log(`\n\n${"#".repeat(80)}\nMODEL: ${model}\n${"#".repeat(80)}`);

    console.log(`\n${"=".repeat(80)}\nWINDOW-ARTWORK CHECK (batched, production function)\n${"=".repeat(80)}`);
    for (const c of WINDOW_ARTWORK_CASES) {
      const jobId = `${c.jobId}-${model}`;
      console.log(`\n[${model}] ${c.label}`);
      try {
        const baseline: any = await extractStructuralBaseline(c.baselinePath, { jobId, imageId: jobId });
        console.log(`  openings extracted: ${baseline.openings.length} (${baseline.openings.map((o: any) => `${o.id}:${o.type}`).join(", ")})`);
        const results = await runWindowArtworkCheckForOpenings(baseline.openings, c.stagedPath, { jobId, imageId: jobId, attempt: 1 });
        console.log(`  results: ${JSON.stringify(results, null, 2)}`);
        const anyFail = results.some((r) => r.verdict === "fail_window_replaced_by_artwork");
        const anyError = results.some((r) => r.verdict === "error");
        const line = `[${model}] ${c.label}: anyFail=${anyFail} anyError=${anyError} windowCount=${results.length} (expected fail=${c.expectFail})`;
        console.log(`  SUMMARY: ${line}`);
        summary.push(line);
      } catch (e: any) {
        const line = `[${model}] ${c.label}: FATAL ERROR ${e?.message || e}`;
        console.log(`  ${line}`);
        summary.push(line);
      }
    }

    console.log(`\n${"=".repeat(80)}\nVANISHED-LANDMARK CHECK (batched, production function)\n${"=".repeat(80)}`);
    for (const c of VANISH_CASES) {
      const jobId = `${c.jobId}-${model}`;
      console.log(`\n[${model}] ${c.label}`);
      try {
        const baseline: any = await extractStructuralBaseline(c.baselinePath, { jobId, imageId: jobId });
        console.log(`  openings: ${baseline.openings.length} (${baseline.openings.map((o: any) => `${o.id}:${o.type}`).join(", ")}) | fixtures: ${(baseline.anchorFixtures || []).length} (${(baseline.anchorFixtures || []).map((f: any) => `${f.id}:${f.type}`).join(", ")})`);
        const openingResults = await runVanishedLandmarkCheckForItems(toPicked(baseline.openings), c.baselinePath, c.stagedPath, { jobId, imageId: jobId, attempt: 1 }, "openings");
        const fixtureResults = await runVanishedLandmarkCheckForItems(toPicked(baseline.anchorFixtures || []), c.baselinePath, c.stagedPath, { jobId, imageId: jobId, attempt: 1 }, "fixtures");
        console.log(`  opening results: ${JSON.stringify(openingResults, null, 2)}`);
        console.log(`  fixture results: ${JSON.stringify(fixtureResults, null, 2)}`);
        const all = [...openingResults, ...fixtureResults];
        const anyFail = all.some((r) => r.verdict.startsWith("fail_"));
        const anyError = all.some((r) => r.verdict === "error");
        const line = `[${model}] ${c.label}: anyFail=${anyFail} anyError=${anyError} itemCount=${all.length} (expected fail=${c.expectFail})`;
        console.log(`  SUMMARY: ${line}`);
        summary.push(line);
      } catch (e: any) {
        const line = `[${model}] ${c.label}: FATAL ERROR ${e?.message || e}`;
        console.log(`  ${line}`);
        summary.push(line);
      }
    }
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (batched production checks, cross-model)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
