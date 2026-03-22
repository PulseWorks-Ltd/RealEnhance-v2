import fs from "fs";
import path from "path";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";
import { runUnifiedValidation } from "../worker/src/validators/runValidation";
import { CRITICAL_ISSUES, ISSUE_TYPES, type ValidationIssueType } from "../worker/src/validators/issueTypes";

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

function toSpecialistDecision(res: any): {
  pass: boolean;
  confidence: number;
  issueType: ValidationIssueType;
} {
  const pass = !!res && res.status === "pass" && res.hardFail !== true;
  const rawConfidence = Number(res?.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(1, rawConfidence))
    : pass
      ? 0
      : 0;
  const issueType = pass
    ? ISSUE_TYPES.NONE
    : (res?.issueType as ValidationIssueType) || ISSUE_TYPES.UNIFIED_FAILURE;

  return {
    pass,
    confidence,
    issueType,
  };
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

  try {
    steps.fixtures = await runFixtureValidator(pair.baselinePath, pair.enhancedPath);
    if (!stepPassLike(steps.fixtures)) reasons.push(`fixtures: ${steps.fixtures?.reason || "failed"}`);
  } catch (err: any) {
    steps.fixtures = { status: "error", reason: err?.message || String(err) };
    reasons.push(`fixtures_error: ${steps.fixtures.reason}`);
  }

  try {
    steps.floor = await runFloorIntegrityValidator(pair.baselinePath, pair.enhancedPath);
    if (!stepPassLike(steps.floor)) reasons.push(`floor: ${steps.floor?.reason || "failed"}`);
  } catch (err: any) {
    steps.floor = { status: "error", reason: err?.message || String(err) };
    reasons.push(`floor_error: ${steps.floor.reason}`);
  }

  try {
    steps.envelope = await runEnvelopeValidator(pair.baselinePath, pair.enhancedPath);
    if (!stepPassLike(steps.envelope)) reasons.push(`envelope: ${steps.envelope?.reason || "failed"}`);
  } catch (err: any) {
    steps.envelope = { status: "error", reason: err?.message || String(err) };
    reasons.push(`envelope_error: ${steps.envelope.reason}`);
  }

  const specialistResults = {
    opening: toSpecialistDecision(steps.openings),
    fixture: toSpecialistDecision(steps.fixtures),
    envelope: toSpecialistDecision(steps.envelope),
    floor: toSpecialistDecision(steps.floor),
  };

  const HARD_FAIL_THRESHOLD = 0.9;
  const specialistHardFail = Object.values(specialistResults).some((v) =>
    !v.pass &&
    v.confidence >= HARD_FAIL_THRESHOLD &&
    CRITICAL_ISSUES.has(v.issueType)
  );

  if (specialistHardFail) {
    const specialistReasons = Object.values(specialistResults)
      .filter((v) => !v.pass && v.confidence >= HARD_FAIL_THRESHOLD)
      .map((v) => `${v.issueType} (conf=${v.confidence})`);

    console.log("[HARNESS_DECISION]", {
      specialistHardFail,
      unifiedPass: null,
      unifiedIssueType: null,
      stage: "specialist",
    });

    return {
      id: pair.id,
      stagedSet: pair.stagedSet,
      baseline,
      enhanced,
      finalStatus: "fail",
      failedAt: "specialist",
      reasons: specialistReasons,
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

    const unifiedPass = steps.unified?.passed === true && steps.unified?.hardFail !== true;
    const unifiedIssueType = (steps.unified?.issueType as ValidationIssueType) || ISSUE_TYPES.UNIFIED_FAILURE;

    console.log("[HARNESS_DECISION]", {
      specialistHardFail,
      unifiedPass,
      unifiedIssueType,
      stage: "unified",
    });

    if (!unifiedPass && CRITICAL_ISSUES.has(unifiedIssueType)) {
      const unifiedReason = steps.unified?.reasons?.[0] || unifiedIssueType;
      return {
        id: pair.id,
        stagedSet: pair.stagedSet,
        baseline,
        enhanced,
        finalStatus: "fail",
        failedAt: "unified_gemini",
        reasons: [unifiedReason],
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

  steps.compliance = { status: "skipped", reason: "harness_flow_specialist_unified_only" };
  steps.finalConfirm = { status: "skipped", reason: "harness_flow_specialist_unified_only" };

  return {
    id: pair.id,
    stagedSet: pair.stagedSet,
    baseline,
    enhanced,
    finalStatus: "pass",
    reasons: [],
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
