// Runs the REAL planning system anchor_locked/combined actually use for
// living_dining (buildAnchorLockedStage2Prompt -> extractZoning +
// planMultiAnchor in anchorLockedStaging.ts), not the separate simpler
// pipeline/layoutPlanner.ts system tested earlier by mistake.
process.env.OPENING_BASELINE_SINGLE_PASS = "1";
import path from "node:path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { buildAnchorLockedStage2Prompt } from "../worker/src/pipeline/anchorLockedStaging";

async function main() {
  const imagePath = path.resolve(__dirname, "../Test Images/Kitchen/Kitchen 01.jpg");
  const jobId = "test_living_dining_real";
  const imageId = "img_kitchen01_real";

  const baseline = await extractStructuralBaseline(imagePath, { jobId, imageId });
  console.log(`\nBaseline: ${baseline.openings.length} openings, ${(baseline.anchorFixtures || []).length} fixtures`);
  console.log("Anchor fixtures detected:");
  for (const f of baseline.anchorFixtures || []) {
    console.log(`  - ${f.id}: type=${f.type} wallIndex=${f.wallIndex} desc="${f.description || ""}"`);
  }

  const result = await buildAnchorLockedStage2Prompt({
    imagePath,
    roomType: "living_dining",
    jobId,
    imageId,
    structuralBaseline: baseline,
  });

  console.log("\n=== DIAGNOSTICS ===");
  console.log(JSON.stringify(result.diagnostics, null, 2));
  console.log("\nfallbackReason:", result.fallbackReason);

  console.log("\n=== FULL PROMPT ===");
  console.log(result.prompt);
}

main().catch((err) => {
  console.error("ERROR:", err?.message || err, err?.stack);
  process.exit(1);
});
