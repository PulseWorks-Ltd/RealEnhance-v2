import fs from "fs";
import path from "path";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";
import { runUnifiedValidation } from "../worker/src/validators/runValidation";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { checkCompliance } from "../worker/src/ai/compliance";
import { confirmWithGeminiStructure } from "../worker/src/validators/confirmWithGeminiStructure";
import { toBase64 } from "../worker/src/utils/images";

type Pair = {
  id: string;
  baselinePath: string;
  enhancedPath: string;
  stagedSet: "Bedroom (Staged)" | "Bedroom (Staged 2)";
};

type PairResult = {
  id: string;
  stagedSet: string;
  baseline: string;
  enhanced: string;
  finalStatus: "pass" | "fail" | "error";
  failedAt?: string;
  reasons: string[];
  warnings: string[];
  steps: Record<string, any>;
  elapsedMs: number;
};

function isImage(name: string): boolean {
  return /\.(jpg|jpeg|png|webp)$/i.test(name);
}

function idFromName(name: string): string | null {
  const m = name.match(/Bedroom\s+(\d+)/i);
  return m ? m[1].padStart(2, "0") : null;
}

function listPairs(root: string): Pair[] {
  const baselineDir = path.join(root, "Test Images", "Bedroom (Baseline)");
  const stagedDirs: Array<Pair["stagedSet"]> = ["Bedroom (Staged)", "Bedroom (Staged 2)"];

  const baselineById = new Map<string, string>();
  for (const name of fs.readdirSync(baselineDir)) {
    if (!isImage(name)) continue;
    const id = idFromName(name);
    if (!id) continue;
    baselineById.set(id, path.join(baselineDir, name));
  }

  const pairs: Pair[] = [];
  for (const stagedSet of stagedDirs) {
    const stagedDir = path.join(root, "Test Images", stagedSet);
    for (const name of fs.readdirSync(stagedDir)) {
      if (!isImage(name)) continue;
      const id = idFromName(name);
      if (!id) continue;
      const baselinePath = baselineById.get(id);
      if (!baselinePath) continue;
      pairs.push({
        id,
        baselinePath,
        enhancedPath: path.join(stagedDir, name),
        stagedSet,
      });
    }
  }

  return pairs.sort((a, b) => {
    const idCmp = a.id.localeCompare(b.id);
    if (idCmp !== 0) return idCmp;
    return a.stagedSet.localeCompare(b.stagedSet);
  });
}

function stepPassLike(res: any): boolean {
  return !!res && res.status === "pass" && res.hardFail !== true;
}

async function runOne(pair: Pair): Promise<PairResult> {
  const t0 = Date.now();
  const steps: Record<string, any> = {};
  const reasons: string[] = [];
  const warnings: string[] = [];

  const baseline = path.basename(pair.baselinePath);
  const enhanced = path.basename(pair.enhancedPath);

  try {
    steps.openings = await runOpeningValidator(pair.baselinePath, pair.enhancedPath);
    if (!stepPassLike(steps.openings)) reasons.push(`openings: ${steps.openings?.reason || "failed"}`);
  } catch (err: any) {
    steps.openings = { status: "error", reason: err?.message || String(err) };
    reasons.push(`openings_error: ${steps.openings.reason}`);
  }

  if (stepPassLike(steps.openings)) {
    try {
      steps.fixtures = await runFixtureValidator(pair.baselinePath, pair.enhancedPath);
      if (!stepPassLike(steps.fixtures)) reasons.push(`fixtures: ${steps.fixtures?.reason || "failed"}`);
    } catch (err: any) {
      steps.fixtures = { status: "error", reason: err?.message || String(err) };
      reasons.push(`fixtures_error: ${steps.fixtures.reason}`);
    }
  } else {
    steps.fixtures = { status: "skipped", reason: "openings_failed" };
  }

  if (stepPassLike(steps.fixtures)) {
    try {
      steps.floor = await runFloorIntegrityValidator(pair.baselinePath, pair.enhancedPath);
      if (!stepPassLike(steps.floor)) reasons.push(`floor: ${steps.floor?.reason || "failed"}`);
    } catch (err: any) {
      steps.floor = { status: "error", reason: err?.message || String(err) };
      reasons.push(`floor_error: ${steps.floor.reason}`);
    }
  } else {
    steps.floor = { status: "skipped", reason: "fixtures_failed" };
  }

  if (stepPassLike(steps.floor)) {
    try {
      steps.envelope = await runEnvelopeValidator(pair.baselinePath, pair.enhancedPath);
      if (!stepPassLike(steps.envelope)) reasons.push(`envelope: ${steps.envelope?.reason || "failed"}`);
    } catch (err: any) {
      steps.envelope = { status: "error", reason: err?.message || String(err) };
      reasons.push(`envelope_error: ${steps.envelope.reason}`);
    }
  } else {
    steps.envelope = { status: "skipped", reason: "floor_failed" };
  }

  const domainPass = [steps.openings, steps.fixtures, steps.floor, steps.envelope].every((s) => stepPassLike(s));

  if (!domainPass) {
    return {
      id: pair.id,
      stagedSet: pair.stagedSet,
      baseline,
      enhanced,
      finalStatus: "fail",
      failedAt: "domain_gate",
      reasons,
      warnings,
      steps,
      elapsedMs: Date.now() - t0,
    };
  }

  try {
    steps.unified = await runUnifiedValidation({
      originalPath: pair.baselinePath,
      enhancedPath: pair.enhancedPath,
      stage: "2",
      sceneType: "interior",
      roomType: "bedroom",
      mode: "enforce",
      jobId: `full-stage2-${pair.stagedSet}-${pair.id}`,
      imageId: `bedroom-${pair.id}`,
      stagingStyle: "standard_listing",
      stage1APath: pair.baselinePath,
      sourceStage: "1A",
      validationMode: "FULL_STAGE_ONLY",
      geminiPolicy: "always",
    });

    if (steps.unified?.warnings?.length) warnings.push(...steps.unified.warnings);

    if (steps.unified?.hardFail) {
      reasons.push(...(steps.unified.reasons || []));
      return {
        id: pair.id,
        stagedSet: pair.stagedSet,
        baseline,
        enhanced,
        finalStatus: "fail",
        failedAt: `unified_${steps.unified.blockSource || "unknown"}`,
        reasons,
        warnings,
        steps,
        elapsedMs: Date.now() - t0,
      };
    }
  } catch (err: any) {
    steps.unified = { status: "error", reason: err?.message || String(err) };
    reasons.push(`unified_error: ${steps.unified.reason}`);
    return {
      id: pair.id,
      stagedSet: pair.stagedSet,
      baseline,
      enhanced,
      finalStatus: "error",
      failedAt: "unified_error",
      reasons,
      warnings,
      steps,
      elapsedMs: Date.now() - t0,
    };
  }

  try {
    const ai = getGeminiClient();
    const base = toBase64(pair.baselinePath).data;
    const cand = toBase64(pair.enhancedPath).data;
    steps.compliance = await checkCompliance(ai as any, base, cand, {
      validationMode: "FULL_STAGE_ONLY",
      modelOverride: process.env.GEMINI_COMPLIANCE_MODEL || "gemini-2.5-pro",
    });

    if (steps.compliance?.ok === false) {
      reasons.push(...(steps.compliance?.reasons || [steps.compliance?.reason || "compliance_failed"]));
      return {
        id: pair.id,
        stagedSet: pair.stagedSet,
        baseline,
        enhanced,
        finalStatus: "fail",
        failedAt: "compliance",
        reasons,
        warnings,
        steps,
        elapsedMs: Date.now() - t0,
      };
    }
  } catch (err: any) {
    steps.compliance = { status: "error", reason: err?.message || String(err) };
    reasons.push(`compliance_error: ${steps.compliance.reason}`);
    return {
      id: pair.id,
      stagedSet: pair.stagedSet,
      baseline,
      enhanced,
      finalStatus: "error",
      failedAt: "compliance_error",
      reasons,
      warnings,
      steps,
      elapsedMs: Date.now() - t0,
    };
  }

  try {
    steps.finalConfirm = await confirmWithGeminiStructure({
      baselinePathOrUrl: pair.baselinePath,
      candidatePathOrUrl: pair.enhancedPath,
      stage: "stage2",
      roomType: "bedroom",
      sceneType: "interior",
      localReasons: (steps.unified?.reasons || []).concat(steps.unified?.warnings || []),
      sourceStage: "1A",
      validationMode: "FULL_STAGE_ONLY",
      evidence: steps.unified?.evidence,
      riskLevel: steps.unified?.riskLevel,
    });

    if (steps.finalConfirm?.status === "fail") {
      reasons.push(...(steps.finalConfirm?.reasons || ["final_confirm_failed"]));
      return {
        id: pair.id,
        stagedSet: pair.stagedSet,
        baseline,
        enhanced,
        finalStatus: "fail",
        failedAt: "final_confirm",
        reasons,
        warnings,
        steps,
        elapsedMs: Date.now() - t0,
      };
    }

    if (steps.finalConfirm?.status === "error") {
      reasons.push(...(steps.finalConfirm?.reasons || ["final_confirm_error"]));
      return {
        id: pair.id,
        stagedSet: pair.stagedSet,
        baseline,
        enhanced,
        finalStatus: "error",
        failedAt: "final_confirm_error",
        reasons,
        warnings,
        steps,
        elapsedMs: Date.now() - t0,
      };
    }
  } catch (err: any) {
    steps.finalConfirm = { status: "error", reason: err?.message || String(err) };
    reasons.push(`final_confirm_error: ${steps.finalConfirm.reason}`);
    return {
      id: pair.id,
      stagedSet: pair.stagedSet,
      baseline,
      enhanced,
      finalStatus: "error",
      failedAt: "final_confirm_error",
      reasons,
      warnings,
      steps,
      elapsedMs: Date.now() - t0,
    };
  }

  return {
    id: pair.id,
    stagedSet: pair.stagedSet,
    baseline,
    enhanced,
    finalStatus: "pass",
    reasons,
    warnings,
    steps,
    elapsedMs: Date.now() - t0,
  };
}

async function main() {
  const root = process.cwd();
  const pairs = listPairs(root);
  if (pairs.length === 0) {
    console.error("No matching bedroom pairs found");
    process.exit(1);
  }

  console.log(`[FULL_STAGE2_BATCH] pairs=${pairs.length}`);
  const started = Date.now();
  const results: PairResult[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    console.log(`\n[${i + 1}/${pairs.length}] ${p.stagedSet} Bedroom ${p.id}`);
    console.log(`  baseline=${path.basename(p.baselinePath)}`);
    console.log(`  enhanced=${path.basename(p.enhancedPath)}`);
    const r = await runOne(p);
    results.push(r);
    console.log(`  -> finalStatus=${r.finalStatus}${r.failedAt ? ` failedAt=${r.failedAt}` : ""}`);
    if (r.reasons.length) {
      console.log(`  -> reasons=${r.reasons.slice(0, 2).join(" | ")}${r.reasons.length > 2 ? " ..." : ""}`);
    }
  }

  const summary = {
    total: results.length,
    pass: results.filter((r) => r.finalStatus === "pass").length,
    fail: results.filter((r) => r.finalStatus === "fail").length,
    error: results.filter((r) => r.finalStatus === "error").length,
    bySet: {
      "Bedroom (Staged)": {
        total: results.filter((r) => r.stagedSet === "Bedroom (Staged)").length,
        pass: results.filter((r) => r.stagedSet === "Bedroom (Staged)" && r.finalStatus === "pass").length,
        fail: results.filter((r) => r.stagedSet === "Bedroom (Staged)" && r.finalStatus === "fail").length,
        error: results.filter((r) => r.stagedSet === "Bedroom (Staged)" && r.finalStatus === "error").length,
      },
      "Bedroom (Staged 2)": {
        total: results.filter((r) => r.stagedSet === "Bedroom (Staged 2)").length,
        pass: results.filter((r) => r.stagedSet === "Bedroom (Staged 2)" && r.finalStatus === "pass").length,
        fail: results.filter((r) => r.stagedSet === "Bedroom (Staged 2)" && r.finalStatus === "fail").length,
        error: results.filter((r) => r.stagedSet === "Bedroom (Staged 2)" && r.finalStatus === "error").length,
      },
    },
    elapsedMs: Date.now() - started,
  };

  const outDir = path.join(root, "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `full-stage2-bedroom-batch-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Saved report: ${outPath}`);
}

main().catch((err) => {
  console.error("BATCH_FATAL", err?.message || err);
  process.exit(1);
});
