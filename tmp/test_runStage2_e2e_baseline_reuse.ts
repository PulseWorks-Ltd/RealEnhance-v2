import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runStage2 } from "../worker/src/pipeline/stage2";

const REPO_ROOT = path.resolve(__dirname, "..");
const imagePath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");

async function main() {
  const jobId = "test-runStage2-e2e-reuse";

  console.log("### Resolving baseline ONCE, as worker.ts's Stage1A-parallel trigger would ###");
  const baseline: any = await extractStructuralBaseline(imagePath, { jobId, imageId: jobId });
  console.log(`baseline graphHash=${baseline.graphMeta?.graphHash} openings=${baseline.openings.length}`);

  console.log("\n### Calling runStage2 with the pre-resolved baseline (as worker.ts now does) ###");
  const result = await runStage2(imagePath, "1A", {
    roomType: "bedroom",
    sceneType: "interior",
    stagingStyle: "standard_listing",
    sourceStage: "1A",
    promptMode: "full",
    jobId,
    imageId: jobId,
    structuralBaseline: baseline,
  });
  console.log(`\nresult.outputPath=${result.outputPath}`);
  console.log(`result.attempts=${result.attempts} result.fallbackUsed=${result.fallbackUsed}`);
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
