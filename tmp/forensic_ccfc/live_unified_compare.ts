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

function loadSignals(path: string): string[] {
  const j = JSON.parse(fs.readFileSync(path, "utf8"));
  return Array.isArray(j?.specialistSignals) ? j.specialistSignals : [];
}

async function runOne(label: string, signals: string[], runIndex: number) {
  const result = await runUnifiedValidation({
    originalPath: baselinePath,
    enhancedPath: candidatePath,
    stage: "2",
    sceneType: "interior",
    roomType: "living",
    mode: "enforce",
    jobId: `live-${label}-${runIndex}`,
    imageId: `live-${label}-${runIndex}`,
    stagingStyle: "standard_listing",
    stage1APath: baselinePath,
    sourceStage: "1A",
    validationMode: "FULL_STAGE_ONLY",
    geminiPolicy: "always",
    specialistAdvisorySignals: signals,
  } as any);

  const gemini = (result as any)?.raw?.geminiSemantic;
  const details = gemini?.details ?? {};
  return {
    label,
    runIndex,
    inputSignals: signals,
    unified: {
      passed: result.passed,
      hardFail: result.hardFail,
      blockSource: result.blockSource,
      score: result.score,
      issueType: result.issueType,
      issueTier: result.issueTier,
      modelUsed: result.modelUsed ?? null,
      profile: result.profile,
      warnings: result.warnings,
      reasons: result.reasons,
    },
    geminiSemantic: {
      passed: gemini?.passed ?? null,
      score: gemini?.score ?? null,
      message: gemini?.message ?? null,
      details: {
        category: details.category ?? null,
        reasons: details.reasons ?? null,
        confidence: details.confidence ?? null,
        mode: details.mode ?? null,
        consensusMode: details.consensusMode ?? null,
        derivedWarnings: details.derivedWarnings ?? null,
        rawText: details.rawText ?? null,
        validator_results: details.validator_results ?? null,
      },
    },
  };
}

async function main() {
  const report: any[] = [];
  for (const c of cases) {
    const signals = loadSignals(c.path);
    for (let i = 1; i <= 2; i++) {
      console.log(`\n=== LIVE_RUN_START ${c.label}#${i} ===`);
      console.log(JSON.stringify({ label: c.label, runIndex: i, inputSignals: signals }, null, 2));
      const row = await runOne(c.label, signals, i);
      report.push(row);
      console.log(JSON.stringify(row, null, 2));
      console.log(`=== LIVE_RUN_END ${c.label}#${i} ===`);
    }
  }
  fs.writeFileSync(
    "/workspaces/RealEnhance-v2/analysis/window_shift_regression/live_unified_compare_report.json",
    JSON.stringify(report, null, 2),
  );
}

main().catch((e) => {
  console.error("LIVE_COMPARE_FAILED", e?.message || String(e));
  process.exit(1);
});
