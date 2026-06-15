import fs from "fs";
import path from "path";
import { runOpeningValidator } from "../../worker/src/validators/openingValidator";
import { runUnifiedValidation } from "../../worker/src/validators/runValidation";

function uniqueSignals(r: any): string[] {
  const out: string[] = [];
  if (Array.isArray(r?.advisorySignals)) out.push(...r.advisorySignals.filter((x: any) => typeof x === "string"));
  if (typeof r?.issueType === "string" && r.issueType !== "none") out.push(r.issueType);
  return [...new Set(out)];
}

async function main() {
  const baselinePath = "/workspaces/RealEnhance-v2/tmp/forensic_ccfc/baseline.jpg";
  const candidatePath = "/workspaces/RealEnhance-v2/tmp/forensic_ccfc/candidate.webp";
  const baselineJsonPath = "/workspaces/RealEnhance-v2/analysis/window_shift_regression/baseline_extract_current_head.json";
  const baseline = JSON.parse(fs.readFileSync(baselineJsonPath, "utf8"));

  const opening = await runOpeningValidator(baselinePath, candidatePath, {
    jobId: "job_ccfc5e12_ab_opening",
    imageId: "img_4ffd6659_ab",
    attempt: 1,
    baseline,
  } as any);
  const openingSignals = uniqueSignals(opening);

  const common = {
    originalPath: baselinePath,
    enhancedPath: candidatePath,
    stage: "2",
    sceneType: "interior",
    roomType: "bedroom",
    mode: "enforce",
    imageId: "img_4ffd6659_ab",
    stagingStyle: "standard_listing",
    stage1APath: baselinePath,
    sourceStage: "1A",
    validationMode: "FULL_STAGE_ONLY",
    geminiPolicy: "always",
  } as any;

  const noHandoff = await runUnifiedValidation({
    ...common,
    jobId: "job_ccfc5e12_ab_no_handoff",
    specialistAdvisorySignals: [],
  });

  const withHandoff = await runUnifiedValidation({
    ...common,
    jobId: "job_ccfc5e12_ab_with_handoff",
    specialistAdvisorySignals: openingSignals,
  });

  const report = {
    pair: { baselinePath, candidatePath, baselineJsonPath },
    opening: {
      status: opening?.status,
      reason: opening?.reason,
      issueType: opening?.issueType,
      issueTier: opening?.issueTier,
      confidence: opening?.confidence,
      advisorySignals: opening?.advisorySignals ?? [],
      derivedSignals: openingSignals,
    },
    noHandoff: {
      passed: noHandoff?.passed,
      hardFail: noHandoff?.hardFail,
      blockSource: (noHandoff as any)?.blockSource ?? null,
      score: noHandoff?.score,
      issueType: noHandoff?.issueType,
      issueTier: noHandoff?.issueTier,
      warnings: noHandoff?.warnings ?? [],
      reasons: noHandoff?.reasons ?? [],
    },
    withHandoff: {
      passed: withHandoff?.passed,
      hardFail: withHandoff?.hardFail,
      blockSource: (withHandoff as any)?.blockSource ?? null,
      score: withHandoff?.score,
      issueType: withHandoff?.issueType,
      issueTier: withHandoff?.issueTier,
      warnings: withHandoff?.warnings ?? [],
      reasons: withHandoff?.reasons ?? [],
    },
  };

  const outPath = path.join(
    "/workspaces/RealEnhance-v2/analysis/window_shift_regression",
    `job_ccfc5e12_orchestration_ab_${Date.now()}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`REPORT=${outPath}`);
  console.log(JSON.stringify({
    openingSignals,
    noHandoff: report.noHandoff,
    withHandoff: report.withHandoff,
  }, null, 2));
}

main().catch((e) => {
  console.error("AB_REPLAY_FAILED", e?.message || String(e));
  process.exit(1);
});
