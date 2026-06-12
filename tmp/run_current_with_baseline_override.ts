import fs from "fs";
import path from "path";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";
import { runUnifiedValidation } from "../worker/src/validators/runValidation";

type Name = "opening" | "fixture" | "floor" | "envelope";

function collectSignals(r: any): string[] {
  const out: string[] = [];
  if (Array.isArray(r?.advisorySignals)) out.push(...r.advisorySignals.filter((x: any) => typeof x === "string"));
  if (typeof r?.issueType === "string" && r.issueType !== "none") out.push(r.issueType);
  return [...new Set(out)];
}

function parseOpeningMetrics(opening: any) {
  const reason = String(opening?.reason || "");
  const resize = reason.match(/opening_size_reduction_ge_[0-9.]+:([0-9.]+)/)?.[1]
    || reason.match(/opening_resized_minor:([0-9.]+)/)?.[1]
    || null;
  const visibility = reason.match(/opening_visibility_reduction:([0-9.]+)/)?.[1] || null;
  const findings = Array.isArray(opening?.findings) ? opening.findings : [];
  return {
    issueType: opening?.issueType ?? null,
    issueTier: opening?.issueTier ?? null,
    status: opening?.status ?? null,
    hardFail: opening?.hardFail ?? null,
    confidence: opening?.confidence ?? null,
    resizePercentApprox: resize ? Math.round(Number(resize) * 1000) / 10 : null,
    visibilityReductionApprox: visibility ? Math.round(Number(visibility) * 1000) / 10 : null,
    findingCount: findings.length,
    findingLocations: findings.map((f: any) => f?.location || null),
    findingClassifications: findings.map((f: any) => f?.status || null),
    overlapScores: findings.map((f: any) => f?.overlapToBaseline ?? null),
  };
}

async function main() {
  const baselineJsonPath = process.argv[2];
  const label = process.argv[3] || "unknown";
  if (!baselineJsonPath) throw new Error("usage: tsx run_current_with_baseline_override.ts <baseline-json> <label>");

  const baselineImage = "/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/baseline.jpg";
  const candidateImage = "/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/candidate.jpg";
  const baselineObj = JSON.parse(fs.readFileSync(baselineJsonPath, "utf8"));
  const context = { jobId: `rca-${label}`, imageId: "window-shift-pair", attempt: 1 };

  const opening = await runOpeningValidator(baselineImage, candidateImage, { ...context, baseline: baselineObj });
  const fixture = await runFixtureValidator(baselineImage, candidateImage, context);
  const floor = await runFloorIntegrityValidator(baselineImage, candidateImage, context);
  const envelope = await runEnvelopeValidator(baselineImage, candidateImage, context);

  const specialistSignals = [...new Set([
    ...collectSignals(opening),
    ...collectSignals(fixture),
    ...collectSignals(floor),
    ...collectSignals(envelope),
  ])];

  const unified = await runUnifiedValidation({
    originalPath: baselineImage,
    enhancedPath: candidateImage,
    stage: "2",
    sceneType: "interior",
    roomType: "living",
    mode: "enforce",
    jobId: `rca-unified-${label}-${Date.now()}`,
    imageId: "window-shift-pair",
    stagingStyle: "standard_listing",
    stage1APath: baselineImage,
    sourceStage: "1A",
    validationMode: "FULL_STAGE_ONLY",
    geminiPolicy: "always",
    specialistAdvisorySignals: specialistSignals,
  } as any);

  const report = {
    label,
    baselineJsonPath,
    openingBaselineCount: Array.isArray(baselineObj?.openings) ? baselineObj.openings.length : null,
    openingBaselineLocations: Array.isArray(baselineObj?.openings)
      ? baselineObj.openings.map((o: any) => ({ id: o?.id ?? null, wallIndex: o?.wallIndex ?? null, bbox: o?.bbox ?? null, horizontalBand: o?.horizontalBand ?? null }))
      : [],
    openingMetrics: parseOpeningMetrics(opening),
    specialistSignals,
    unified: {
      passed: unified?.passed ?? null,
      hardFail: unified?.hardFail ?? null,
      blockSource: (unified as any)?.blockSource ?? null,
      score: unified?.score ?? null,
      issueType: unified?.issueType ?? null,
      issueTier: unified?.issueTier ?? null,
      warnings: unified?.warnings ?? [],
      reasons: unified?.reasons ?? [],
    },
    raw: { opening, fixture, floor, envelope },
  };

  const outPath = path.join("/workspaces/RealEnhance-v2/analysis/window_shift_regression", `current_stack_with_${label}_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`REPORT=${outPath}`);
  console.log(JSON.stringify({
    label,
    openingMetrics: report.openingMetrics,
    specialistSignals: report.specialistSignals,
    unified: report.unified,
  }, null, 2));
}

main().catch((err) => {
  console.error("RUN_FAILED", err?.message || String(err));
  process.exit(1);
});
