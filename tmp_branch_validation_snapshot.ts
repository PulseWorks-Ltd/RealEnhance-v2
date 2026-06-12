import fs from "fs";
import path from "path";
import { runOpeningValidator } from "./worker/src/validators/openingValidator";
import { runFixtureValidator } from "./worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "./worker/src/validators/floorIntegrityValidator";
import { runEnvelopeValidator } from "./worker/src/validators/envelopeValidator";
import { runUnifiedValidation } from "./worker/src/validators/runValidation";

function collectSignals(r: any): string[] {
  const out: string[] = [];
  if (Array.isArray(r?.advisorySignals)) out.push(...r.advisorySignals.filter((x: any) => typeof x === "string"));
  if (typeof r?.issueType === "string" && r.issueType !== "none") out.push(r.issueType);
  return [...new Set(out)];
}

function openingSummary(opening: any) {
  const reason = String(opening?.reason || "");
  const resize = reason.match(/opening_size_reduction_ge_[0-9.]+:([0-9.]+)/)?.[1]
    || reason.match(/opening_resized_minor:([0-9.]+)/)?.[1]
    || null;
  return {
    status: opening?.status ?? null,
    issueType: opening?.issueType ?? null,
    issueTier: opening?.issueTier ?? null,
    confidence: opening?.confidence ?? null,
    resizePercentApprox: resize ? Math.round(Number(resize) * 1000) / 10 : null,
    openingCount: Array.isArray(opening?.findings) ? opening.findings.length : null,
    openingLocations: Array.isArray(opening?.findings) ? opening.findings.map((f: any) => f?.location ?? null) : [],
    overlapScores: Array.isArray(opening?.findings) ? opening.findings.map((f: any) => f?.overlapToBaseline ?? null) : [],
  };
}

async function main() {
  const label = process.argv[2] || "branch";
  const baselineImage = "/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/baseline.jpg";
  const candidateImage = "/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/candidate.jpg";
  const context = { jobId: `branch-${label}`, imageId: "window-shift-pair", attempt: 1 };

  const opening = await runOpeningValidator(baselineImage, candidateImage, context as any);
  const fixture = await runFixtureValidator(baselineImage, candidateImage, context as any);
  const floor = await runFloorIntegrityValidator(baselineImage, candidateImage, context as any);
  const envelope = await runEnvelopeValidator(baselineImage, candidateImage, context as any);

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
    jobId: `unified-${label}-${Date.now()}`,
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
    opening: openingSummary(opening),
    specialistSignals,
    unified: {
      passed: unified?.passed ?? null,
      hardFail: unified?.hardFail ?? null,
      score: unified?.score ?? null,
      issueType: unified?.issueType ?? null,
      issueTier: unified?.issueTier ?? null,
      warnings: unified?.warnings ?? [],
      reasons: unified?.reasons ?? [],
    },
    raw: { opening, fixture, floor, envelope }
  };

  const outPath = path.join("/workspaces/RealEnhance-v2/analysis/window_shift_regression", `branch_snapshot_${label}_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`REPORT=${outPath}`);
  console.log(JSON.stringify({ label, opening: report.opening, specialistSignalCount: specialistSignals.length, unified: report.unified }, null, 2));
}

main().catch((err) => {
  console.error("BRANCH_RUN_FAILED", err?.message || String(err));
  process.exit(1);
});
