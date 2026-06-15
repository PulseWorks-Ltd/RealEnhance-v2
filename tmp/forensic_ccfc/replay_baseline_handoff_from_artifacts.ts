import fs from "fs";
import { runUnifiedValidation } from "../../worker/src/validators/runValidation";

const baselinePath = "/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/baseline.jpg";
const candidatePath = "/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/candidate.jpg";

const cases = [
  {
    label: "old_extract",
    path: "/workspaces/RealEnhance-v2/analysis/window_shift_regression/current_stack_with_old_extract_1781222013340.json",
  },
  {
    label: "new_extract",
    path: "/workspaces/RealEnhance-v2/analysis/window_shift_regression/current_stack_with_new_extract_1781222113801.json",
  },
] as const;

async function main() {
  for (const c of cases) {
    const j = JSON.parse(fs.readFileSync(c.path, "utf8"));
    const signals = Array.isArray(j?.specialistSignals) ? j.specialistSignals : [];

    console.log(`\n=== HANDOFF_REPLAY_START ${c.label} ===`);
    console.log(JSON.stringify({ label: c.label, sourceSpecialistSignals: signals }, null, 2));

    try {
      await runUnifiedValidation({
        originalPath: baselinePath,
        enhancedPath: candidatePath,
        stage: "2",
        sceneType: "interior",
        roomType: "living",
        mode: "enforce",
        jobId: `handoff-${c.label}`,
        imageId: `handoff-${c.label}`,
        stagingStyle: "standard_listing",
        stage1APath: baselinePath,
        sourceStage: "1A",
        validationMode: "FULL_STAGE_ONLY",
        geminiPolicy: "always",
        specialistAdvisorySignals: signals,
      } as any);
    } catch (e: any) {
      console.log(
        JSON.stringify(
          { label: c.label, expectedError: String(e?.message || e) },
          null,
          2,
        ),
      );
    }

    console.log(`=== HANDOFF_REPLAY_END ${c.label} ===`);
  }
}

main().catch((e) => {
  console.error("HANDOFF_REPLAY_FAILED", e?.message || String(e));
  process.exit(1);
});
