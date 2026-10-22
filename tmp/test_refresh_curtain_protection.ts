// Verifies the fix: does refresh mode (what 2 Valentine Street, an
// already-furnished room, actually goes through in production) now
// include the curtain-concealed-window protection sentence?
process.env.OPENING_BASELINE_SINGLE_PASS = "1";
process.env.STAGE2_DEBUG_DUMP_PROMPT = "1";
import fs from "node:fs";
import path from "node:path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runStage2GenerationAttempt } from "../worker/src/pipeline/stage2";

async function main() {
  const imagePath = path.resolve(__dirname, "../Test Images/Validator Testing Images/2 Valentine Street - Image 01.jpg");
  const outputPath = path.resolve(__dirname, "../Test Images/Grok Skill Prompt Test/ValentineSt01-refresh-output.webp");

  console.log("Extracting baseline...");
  const baseline = await extractStructuralBaseline(imagePath, { jobId: "test_refresh", imageId: "img_refresh" });
  const windows = baseline.openings.filter((o) => o.type === "window");
  console.log(`Windows found: ${windows.length}`);
  windows.forEach((w) => console.log(`  - ${w.id}: confidence=${w.confidence} desc="${w.description}"`));

  fs.rmSync("/tmp/stage2_debug_prompt.txt", { force: true });

  console.log("\nRunning Stage 2 generation, forced to REFRESH mode (matching an already-furnished room in real production)...");
  const result = await runStage2GenerationAttempt(imagePath, {
    roomType: "bedroom",
    jobId: "test_refresh",
    imageId: "img_refresh",
    outputPath,
    stagingStyle: "standard_listing",
    attempt: 1,
    promptMode: "refresh",
    structuralBaseline: baseline,
  });

  console.log("\nReturned path:", result);

  const dumped = fs.readFileSync("/tmp/stage2_debug_prompt.txt", "utf-8");
  console.log(`\nFinal prompt length: ${dumped.length} chars`);
  const hasCurtainProtection = dumped.includes("Closed curtain fully covering wall") || dumped.includes("W_curtain");
  const hasProtectedFeaturesSection = dumped.includes("ROOM-SPECIFIC PROTECTED FEATURES");
  console.log("Has 'ROOM-SPECIFIC PROTECTED FEATURES' section:", hasProtectedFeaturesSection);
  console.log("Mentions the curtain-concealed window specifically:", hasCurtainProtection);

  if (hasProtectedFeaturesSection) {
    const idx = dumped.indexOf("ROOM-SPECIFIC PROTECTED FEATURES");
    console.log("\n=== PROTECTED FEATURES SECTION ===");
    console.log(dumped.slice(idx, idx + 2000));
  }
}

main().catch((err) => {
  console.error("ERROR:", err?.message || err, err?.stack);
  process.exit(1);
});
