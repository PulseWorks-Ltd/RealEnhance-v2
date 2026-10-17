import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runStage2 } from "../worker/src/pipeline/stage2";

const REPO_ROOT = path.resolve(__dirname, "..");

async function testCase(label: string, imagePath: string, roomType: string, jobId: string) {
  console.log(`\n\n########## ${label} ##########`);
  const baseline: any = await extractStructuralBaseline(imagePath, { jobId, imageId: jobId });
  console.log(`baseline graphHash=${baseline.graphMeta?.graphHash} openings=${baseline.openings.length}`);
  const result = await runStage2(imagePath, "1A", {
    roomType,
    sceneType: "interior",
    stagingStyle: "standard_listing",
    sourceStage: "1A",
    promptMode: "full",
    jobId,
    imageId: jobId,
    structuralBaseline: baseline,
  });
  console.log(`result.outputPath=${result.outputPath}`);
  console.log(`result.attempts=${result.attempts} result.fallbackUsed=${result.fallbackUsed}`);
  return { label, outputPath: result.outputPath };
}

async function main() {
  const which = process.argv[2];
  if (which === "bedroom14") {
    await testCase(
      "Bedroom 14 (regression)",
      path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 14.jpg"),
      "bedroom",
      "test-regress-bedroom14"
    );
  } else if (which === "livingdining") {
    await testCase(
      "Living/Dining (regression)",
      path.join(REPO_ROOT, "Test Images/Living (Baseline)/Diningroom 01.webp"),
      "living_dining",
      "test-regress-livingdining"
    );
  }
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
