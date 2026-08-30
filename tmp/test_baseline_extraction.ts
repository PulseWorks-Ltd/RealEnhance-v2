// Read-only test: calls the EXISTING, real, exported production baseline
// extractor (worker/src/validators/openingPreservationValidator.ts's
// extractStructuralBaseline, which wraps stabilizeStructuralBaseline) as-is,
// against the Bedroom 12 baseline image. No modification to the function —
// this is the same mechanism proven reliable earlier tonight (it's what
// correctly caught the real doorway-infill failure in production).
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const baselinePath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");

  console.log("=== calling extractStructuralBaseline (real production function) on Bedroom 12 ===");
  const startedAt = Date.now();
  const baseline = await extractStructuralBaseline(baselinePath, {
    jobId: "baseline_extraction_test",
    imageId: "baseline_extraction_test",
    attempt: 1,
  });
  const durationMs = Date.now() - startedAt;

  console.log(`\n=== RESULT (${durationMs}ms) ===`);
  console.log(JSON.stringify(baseline, null, 2));
}

main().catch((e) => {
  console.error("test_baseline_extraction failed:", e);
  process.exit(1);
});
