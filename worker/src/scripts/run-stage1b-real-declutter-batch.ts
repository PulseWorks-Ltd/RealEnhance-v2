import fs from "fs";
import path from "path";
import { runStage1BUnifiedGate } from "../validators/stage1BUnifiedGate";

type PairRecord = {
  caseId: string;
  imageNo: number | null;
  baselinePath: string;
  declutteredPath: string;
  expected: "PASS" | "FAIL";
  cohort: "declutter_batch" | "karaka_reference";
};

type PerImageResult = {
  caseId: string;
  cohort: "declutter_batch" | "karaka_reference";
  imageNo: number | null;
  baselinePath: string;
  declutteredPath: string;
  expected: "PASS" | "FAIL";
  actual: "PASS" | "FAIL";
  overallUnifiedResult: "PASS" | "FAIL";
  issueType: string | null;
  violationType: string | null;
  hardFail: boolean;
  confidence: number | null;
  consensusResult: string | null;
  semanticResult: string | null;
  structuralReviewResult: string | null;
  durationMs: number;
  blockSource: "local" | "gemini" | "none";
  failedValidators: string[];
  failedValidatorDetails: Array<{ validator: string; message: string }>;
  unifiedReasons: string[];
  unifiedWarnings: string[];
  geminiReasons: string[];
  geminiRawText: string | null;
};

function parsePairs(folderPath: string): PairRecord[] {
  const files = fs.readdirSync(folderPath);
  const map = new Map<number, { baseline?: string; decluttered?: string }>();

  for (const file of files) {
    const match = file.match(/^Stage\s+1B\s+-\s+Image\s+(\d+)\s+-\s+(Baseline|Decluttered)\.(jpg|jpeg|png|webp)$/i);
    if (!match) continue;
    const imageNo = Number(match[1]);
    const kind = match[2].toLowerCase();
    const entry = map.get(imageNo) || {};
    const absolutePath = path.join(folderPath, file);
    if (kind === "baseline") entry.baseline = absolutePath;
    if (kind === "decluttered") entry.decluttered = absolutePath;
    map.set(imageNo, entry);
  }

  const pairs: PairRecord[] = [];
  for (const [imageNo, entry] of map.entries()) {
    if (!entry.baseline || !entry.decluttered) {
      throw new Error(`Missing baseline/decluttered pair for image ${imageNo}`);
    }
    pairs.push({
      caseId: `image_${String(imageNo).padStart(2, "0")}`,
      imageNo,
      baselinePath: entry.baseline,
      declutteredPath: entry.decluttered,
      expected: "PASS",
      cohort: "declutter_batch",
    });
  }

  return pairs.sort((a, b) => a.imageNo - b.imageNo);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx];
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry));
}

async function run(): Promise<void> {
  const repoRoot = path.resolve(process.cwd(), "..");
  const folderPath = path.join(repoRoot, "Test Images", "Declutter Validator Testing");
  const pairs = parsePairs(folderPath);

  const karakaPair: PairRecord = {
    caseId: "karaka_image_02",
    imageNo: null,
    baselinePath: path.join(repoRoot, "Test Images", "Kitchen", "Karaka - Image 02 Baseline.jpg"),
    declutteredPath: path.join(repoRoot, "Test Images", "Kitchen", "Karaka - Image 02 Decluttered.jpg"),
    expected: "FAIL",
    cohort: "karaka_reference",
  };

  const allPairs: PairRecord[] = [...pairs, karakaPair];

  console.log("PAIR_DISCOVERY_TABLE_START");
  for (const pair of allPairs) {
    console.log(JSON.stringify({
      caseId: pair.caseId,
      cohort: pair.cohort,
      imageNo: pair.imageNo,
      baselinePath: pair.baselinePath,
      declutteredPath: pair.declutteredPath,
      expected: pair.expected,
    }));
  }
  console.log("PAIR_DISCOVERY_TABLE_END");

  const perImage: PerImageResult[] = [];

  for (const pair of allPairs) {
    const gate = await runStage1BUnifiedGate({
      baselinePath: pair.baselinePath,
      candidatePath: pair.declutteredPath,
      sceneType: "interior",
      stage1BValidationMode: "LIGHT_DECLUTTER",
      roomType: pair.cohort === "karaka_reference" ? "kitchen" : undefined,
      jobId: `stage1b-real-declutter-${pair.caseId}`,
      imageId: `stage1b-real-declutter-${pair.caseId}`,
    });

    const unified = gate.result;
    const raw = unified.raw || {};
    const geminiSemantic = raw.geminiSemantic;
    const geminiDetails = (geminiSemantic?.details || {}) as Record<string, unknown>;
    const validatorResults = (geminiDetails.validator_results || {}) as Record<string, string>;
    const consensusMode = geminiDetails.consensusMode ? String(geminiDetails.consensusMode) : null;

    const failedValidators = Object.entries(raw)
      .filter(([, value]) => value && value.passed === false)
      .map(([name]) => name);

    const failedValidatorDetails = Object.entries(raw)
      .filter(([, value]) => value && value.passed === false)
      .map(([name, value]) => ({
        validator: name,
        message: String(value.message || "failed"),
      }));

    const geminiReasons = asStringArray(geminiDetails.reasons);
    const violationType = unified.issueType ? String(unified.issueType) : null;

    const result: PerImageResult = {
      caseId: pair.caseId,
      cohort: pair.cohort,
      imageNo: pair.imageNo,
      baselinePath: pair.baselinePath,
      declutteredPath: pair.declutteredPath,
      expected: pair.expected,
      actual: gate.passed ? "PASS" : "FAIL",
      overallUnifiedResult: unified.passed ? "PASS" : "FAIL",
      issueType: unified.issueType ? String(unified.issueType) : null,
      violationType,
      hardFail: unified.hardFail === true,
      confidence:
        typeof geminiSemantic?.score === "number" && Number.isFinite(geminiSemantic.score)
          ? geminiSemantic.score
          : null,
      consensusResult: consensusMode || (Object.keys(validatorResults).length ? "single_pass" : null),
      semanticResult: geminiSemantic?.message ? String(geminiSemantic.message) : null,
      structuralReviewResult: "not_executed_in_stage1b_unified_gate_path",
      durationMs: gate.durationMs,
      blockSource: unified.blockSource || "none",
      failedValidators,
      failedValidatorDetails,
      unifiedReasons: asStringArray(unified.reasons),
      unifiedWarnings: asStringArray(unified.warnings),
      geminiReasons,
      geminiRawText: typeof geminiDetails.rawText === "string" ? geminiDetails.rawText : null,
    };

    perImage.push(result);

    console.log("PER_IMAGE_RESULT_START");
    console.log(JSON.stringify(result));
    console.log("PER_IMAGE_RESULT_END");
  }

  const expectedPasses = perImage.filter((item) => item.expected === "PASS").length;
  const actualPasses = perImage.filter((item) => item.actual === "PASS" && item.expected === "PASS").length;
  const actualFails = perImage.filter((item) => item.actual === "FAIL" && item.expected === "PASS").length;

  const passRate = expectedPasses ? actualPasses / expectedPasses : 0;
  const failRate = expectedPasses ? actualFails / expectedPasses : 0;

  const falsePositives = perImage.filter((item) => item.expected === "FAIL" && item.actual === "PASS").length;
  const falseNegatives = perImage.filter((item) => item.expected === "PASS" && item.actual === "FAIL").length;

  const durations = perImage.map((item) => item.durationMs);
  const summary = {
    expectedPasses,
    totalCases: perImage.length,
    actualPasses,
    actualFails,
    passRate,
    failRate,
    falsePositives,
    falseNegatives,
    blockedLegitimateDecluttersIfDeployedNow: falseNegatives,
    productionSafeNow: falseNegatives === 0,
    latency: {
      avgAddedLatencyMs: average(durations),
      p95AddedLatencyMs: percentile(durations, 0.95),
    },
  };

  const failureAttribution = perImage
    .filter((item) => item.actual === "FAIL")
    .map((item) => ({
      imageNo: item.imageNo,
      blockSource: item.blockSource,
      failedValidators: item.failedValidators,
      failedValidatorDetails: item.failedValidatorDetails,
      issueType: item.issueType,
      violationType: item.violationType,
      hardFail: item.hardFail,
      confidence: item.confidence,
      consensusResult: item.consensusResult,
      semanticResult: item.semanticResult,
      unifiedReasons: item.unifiedReasons,
      unifiedWarnings: item.unifiedWarnings,
      geminiReasons: item.geminiReasons,
      whyNotSameRoom: item.unifiedReasons,
    }));

  console.log("FAILURE_ATTRIBUTION_START");
  console.log(JSON.stringify(failureAttribution, null, 2));
  console.log("FAILURE_ATTRIBUTION_END");

  console.log("BATCH_SUMMARY_START");
  console.log(JSON.stringify(summary, null, 2));
  console.log("BATCH_SUMMARY_END");
}

run().catch((error) => {
  console.error("STAGE1B_REAL_DECLUTTER_BATCH_ERROR", error);
  process.exit(1);
});
