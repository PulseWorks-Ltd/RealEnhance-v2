// Read-only test: calls the EXISTING, real production layout planner
// (worker/src/pipeline/layoutPlanner.ts's planStage2Layout) directly, as-is,
// against the Bedroom 12 baseline image. No modification to the function.
import path from "path";
import { planStage2Layout } from "../worker/src/pipeline/layoutPlanner";

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const baselinePath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");

  console.log("=== calling planStage2Layout (real production function) on Bedroom 12 ===");
  const startedAt = Date.now();
  const plan = await planStage2Layout(baselinePath, {
    jobId: "layout_planner_test",
    roomType: "bedroom",
    stagingStyle: "standard_listing",
    // deliberately omitting anchorPlannerEnabled so it skips the deterministic
    // branch and actually calls Gemini (useGeminiFallback defaults to true)
  });
  const durationMs = Date.now() - startedAt;

  console.log(`\n=== RESULT (${durationMs}ms) ===`);
  console.log(JSON.stringify(plan, null, 2));
}

main().catch((e) => {
  console.error("test_layout_planner failed:", e);
  process.exit(1);
});
