import { runUnifiedValidation } from "../../worker/src/validators/runValidation";

const baselinePath = "/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/baseline.jpg";
const candidatePath = "/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/candidate.jpg";

const cases = [
  {
    label: "resize_20",
    signals: [
      "opening_visibility_reduction:0.200",
      "opening_resized_minor:0.200",
      "opening_occlusion",
    ],
  },
  {
    label: "resize_60",
    signals: [
      "opening_visibility_reduction:0.600",
      "opening_resized_minor:0.600",
      "opening_occlusion",
    ],
  },
  {
    label: "resize_80",
    signals: [
      "opening_visibility_reduction:0.800",
      "opening_resized_minor:0.800",
      "opening_occlusion",
    ],
  },
] as const;

async function main() {
  for (const c of cases) {
    console.log(`\n=== MAGNITUDE_REPLAY_START ${c.label} ===`);
    console.log(JSON.stringify({ label: c.label, sourceSpecialistSignals: c.signals }, null, 2));

    try {
      await runUnifiedValidation({
        originalPath: baselinePath,
        enhancedPath: candidatePath,
        stage: "2",
        sceneType: "interior",
        roomType: "living",
        mode: "enforce",
        jobId: `magnitude-${c.label}`,
        imageId: `magnitude-${c.label}`,
        stagingStyle: "standard_listing",
        stage1APath: baselinePath,
        sourceStage: "1A",
        validationMode: "FULL_STAGE_ONLY",
        geminiPolicy: "always",
        specialistAdvisorySignals: c.signals,
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

    console.log(`=== MAGNITUDE_REPLAY_END ${c.label} ===`);
  }
}

main().catch((e) => {
  console.error("MAGNITUDE_REPLAY_FAILED", e?.message || String(e));
  process.exit(1);
});
