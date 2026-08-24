// Direct question from the user: does the EXISTING production Gemini
// baseline-extraction paneStructure field (categorical, already used in
// opening reconciliation/matching logic) show the same instability the
// Grok-based fine-grained pane COUNT just showed on f53669f1, or is it more
// stable? Only ever called on the baseline image in every test tonight —
// this is the first time it's called on the staged image too, specifically
// to get a same-model, same-mechanism baseline-vs-staged comparison.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const PRODIMG = path.join(__dirname, "prodimg");
const baselinePath = path.join(PRODIMG, "baseline_f53669f1.jpg");
const stagedPath = path.join(PRODIMG, "attempt2_f53669f1.webp");

async function main() {
  for (let run = 1; run <= 3; run++) {
    console.log(`\n--- Run ${run}/3 ---`);
    const [baseline, staged]: [any, any] = await Promise.all([
      extractStructuralBaseline(baselinePath, { jobId: `pane-crosscheck-run${run}`, imageId: `baseline-run${run}` }),
      extractStructuralBaseline(stagedPath, { jobId: `pane-crosscheck-run${run}`, imageId: `staged-run${run}` }),
    ]);
    const baseWindow = (baseline.openings || []).find((o: any) => o.type === "window");
    const stagedWindow = (staged.openings || []).find((o: any) => o.type === "window");
    console.log(`  BASELINE window: paneStructure="${baseWindow?.paneStructure}" orientation="${baseWindow?.orientation}" wallCoverageBand="${baseWindow?.wallCoverageBand}" description="${baseWindow?.description}"`);
    console.log(`  STAGED window:   paneStructure="${stagedWindow?.paneStructure}" orientation="${stagedWindow?.orientation}" wallCoverageBand="${stagedWindow?.wallCoverageBand}" description="${stagedWindow?.description}"`);
    console.log(`  MATCH: ${baseWindow?.paneStructure === stagedWindow?.paneStructure ? "MATCH (consistent)" : "MISMATCH"}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});
