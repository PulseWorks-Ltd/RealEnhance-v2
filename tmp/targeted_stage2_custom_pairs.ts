import fs from "fs";
import path from "path";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";
import { runUnifiedValidation } from "../worker/src/validators/runValidation";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { CRITICAL_ISSUES, ISSUE_TYPES } from "../worker/src/validators/issueTypes";

type ValidatorResult = {
  status?: string;
  reason?: string;
  confidence?: number;
  hardFail?: boolean;
  issueType?: string;
  advisorySignals?: string[];
};

type Pair = {
  id: string;
  baselinePath: string;
  enhancedPath: string;
  roomType: string;
};

function parseDotEnv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function passLike(res: ValidatorResult | undefined): boolean {
  return !!res && res.status === "pass" && res.hardFail !== true;
}

function summarizeSpecialist(res: ValidatorResult | undefined) {
  const pass = passLike(res);
  const confidence = Number.isFinite(res?.confidence) ? Math.max(0, Math.min(1, Number(res?.confidence))) : 0;
  const issueType = pass ? ISSUE_TYPES.NONE : res?.issueType || ISSUE_TYPES.UNIFIED_FAILURE;
  return {
    pass,
    confidence,
    issueType,
  };
}

async function main() {
  const root = process.cwd();
  const envPath = path.join(root, "server", ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }
  const env = parseDotEnv(envPath);
  for (const [key, value] of Object.entries(env)) {
    if (!process.env[key]) process.env[key] = value;
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not found in server/.env");
  }

  const pairs: Pair[] = [
    {
      id: "bedroom11-01",
      baselinePath: path.join(root, "Test Images", "Bedroom (Baseline)", "Bedroom 11.jpg"),
      enhancedPath: path.join(root, "Test Images", "Bedroom (Staged 2)", "enhanced_Bedroom 11-01.jpg"),
      roomType: "bedroom",
    },
    {
      id: "bedroom14-02",
      baselinePath: path.join(root, "Test Images", "Bedroom (Baseline)", "Bedroom 14.jpg"),
      enhancedPath: path.join(root, "Test Images", "Bedroom (Staged 2)", "enhanced_Bedroom 14-02.jpg"),
      roomType: "bedroom",
    },
    {
      id: "bedroom14-03",
      baselinePath: path.join(root, "Test Images", "Bedroom (Baseline)", "Bedroom 14.jpg"),
      enhancedPath: path.join(root, "Test Images", "Bedroom (Staged 2)", "enhanced_Bedroom 14-03.jpg"),
      roomType: "bedroom",
    },
  ];

  const hardFailThreshold = 0.9;
  const results: any[] = [];

  for (const pair of pairs) {
    console.log(`\n[PAIR] ${pair.id}`);
    console.log(`baseline=${path.basename(pair.baselinePath)}`);
    console.log(`enhanced=${path.basename(pair.enhancedPath)}`);

    const baseline = await extractStructuralBaseline(pair.baselinePath).catch(() => null);

    const openings = await runOpeningValidator(pair.baselinePath, pair.enhancedPath, baseline).catch((err: any) => ({
      status: "error",
      reason: err?.message || String(err),
      confidence: 0,
      hardFail: true,
      issueType: ISSUE_TYPES.UNIFIED_FAILURE,
    }));

    const fixtures = await runFixtureValidator(pair.baselinePath, pair.enhancedPath).catch((err: any) => ({
      status: "error",
      reason: err?.message || String(err),
      confidence: 0,
      hardFail: true,
      issueType: ISSUE_TYPES.UNIFIED_FAILURE,
    }));

    const floor = await runFloorIntegrityValidator(pair.baselinePath, pair.enhancedPath).catch((err: any) => ({
      status: "error",
      reason: err?.message || String(err),
      confidence: 0,
      hardFail: true,
      issueType: ISSUE_TYPES.UNIFIED_FAILURE,
    }));

    const envelope = await runEnvelopeValidator(pair.baselinePath, pair.enhancedPath).catch((err: any) => ({
      status: "error",
      reason: err?.message || String(err),
      confidence: 0,
      hardFail: true,
      issueType: ISSUE_TYPES.UNIFIED_FAILURE,
    }));

    const specialistResults = {
      openings: summarizeSpecialist(openings),
      fixtures: summarizeSpecialist(fixtures),
      floor: summarizeSpecialist(floor),
      envelope: summarizeSpecialist(envelope),
    };

    const specialistHardFailSignals = Object.entries(specialistResults)
      .filter(([, value]) => !value.pass && value.confidence >= hardFailThreshold && CRITICAL_ISSUES.has(value.issueType as any))
      .map(([validator, value]) => ({
        validator,
        issueType: value.issueType,
        confidence: value.confidence,
      }));

    const unified = await runUnifiedValidation({
      originalPath: pair.baselinePath,
      enhancedPath: pair.enhancedPath,
      stage: "2",
      sceneType: "interior",
      roomType: pair.roomType,
      mode: "enforce",
      jobId: `targeted-stage2-${pair.id}`,
      imageId: pair.id,
      stagingStyle: "standard_listing",
      stage1APath: pair.baselinePath,
      sourceStage: "1A",
      validationMode: "FULL_STAGE_ONLY",
      geminiPolicy: "always",
    }).catch((err: any) => ({
      passed: false,
      hardFail: true,
      issueType: ISSUE_TYPES.UNIFIED_FAILURE,
      reasons: [err?.message || String(err)],
      warnings: [],
      error: err?.message || String(err),
      raw: {},
    }));

    const geminiDetails = (unified as any)?.raw?.geminiSemantic?.details || (unified as any)?.raw?.gemini || {};
    const unifiedSummary = {
      passed: unified?.passed === true,
      hardFail: unified?.hardFail === true,
      issueType: unified?.issueType || null,
      blockSource: unified?.blockSource || null,
      score: typeof unified?.score === "number" ? unified.score : null,
      riskLevel: unified?.riskLevel || null,
      reasons: Array.isArray(unified?.reasons) ? unified.reasons : [],
      warnings: Array.isArray(unified?.warnings) ? unified.warnings : [],
      gemini: {
        category: geminiDetails?.category || null,
        violationType: geminiDetails?.violationType || null,
        confidence: typeof geminiDetails?.confidence === "number" ? geminiDetails.confidence : null,
        hardFail: geminiDetails?.hardFail === true,
        reasons: Array.isArray(geminiDetails?.reasons) ? geminiDetails.reasons : [],
      },
    };

    const overallDecision = specialistHardFailSignals.length > 0
      ? {
          finalStatus: "fail",
          failedAt: "specialist",
          reasons: specialistHardFailSignals.map((signal) => `${signal.validator}:${signal.issueType}:${signal.confidence}`),
        }
      : unifiedSummary.passed && !unifiedSummary.hardFail
        ? {
            finalStatus: "pass",
            failedAt: null,
            reasons: [],
          }
        : {
            finalStatus: "fail",
            failedAt: "unified",
            reasons: unifiedSummary.reasons.length > 0 ? unifiedSummary.reasons : [unifiedSummary.issueType || "unified_failed"],
          };

    const result = {
      pairId: pair.id,
      baseline: path.basename(pair.baselinePath),
      enhanced: path.basename(pair.enhancedPath),
      specialists: { openings, fixtures, floor, envelope },
      specialistResults,
      specialistHardFailSignals,
      unified: unifiedSummary,
      overallDecision,
    };

    results.push(result);
    console.log(JSON.stringify({
      pairId: result.pairId,
      specialistResults: result.specialistResults,
      specialistHardFailSignals: result.specialistHardFailSignals,
      unified: result.unified,
      overallDecision: result.overallDecision,
    }, null, 2));
  }

  const outPath = path.join(root, "tmp", `targeted-stage2-bedroom-custom-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ results }, null, 2));
  console.log(`\n[OUTPUT] ${outPath}`);
}

main().catch((err) => {
  console.error("[targeted-stage2] fatal", err);
  process.exit(1);
});
