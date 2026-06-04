import fs from "node:fs/promises";
import path from "node:path";

import {
  extractStructuralBaseline,
  getStructuralBaselineGraphHash,
  type BaselineArchitectureMode,
  type StructuralBaseline,
} from "../validators/openingPreservationValidator";

type BenchmarkMode = "graph_consensus" | "extraction_verification" | "both";

type RunRecord = {
  run: number;
  ms: number;
  error: string | null;
  openingCount: number;
  inventoryHash: string | null;
  graphHash: string | null;
  graphStable: boolean | null;
  graphConfidence: number | null;
  extractionAgreement: number | null;
  openingCountVariance: number | null;
  baselineAccepted: boolean | null;
  geminiCalls: number | null;
  verificationAttempted: boolean;
  verificationAccepted: boolean | null;
  fallbackUsed: boolean;
  verificationAdditionalOpenings: number;
  verificationMissingOpenings: number;
  verificationMateriallyDifferent: number;
  verificationNotPresent: number;
  verificationMinorDifferences: number;
  verificationDisagreements: number;
  verificationRejectedReasonCodes: string[];
};

type ModeSummary = {
  mode: BaselineArchitectureMode;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  benchmarkScope: {
    openingPreservationAccuracyMeasured: boolean;
    note: string;
  };
  latencyMs: {
    min: number;
    max: number;
    avg: number;
  };
  primaryMetrics: {
    openingCountConsistency: number;
    openingInventoryConsistency: number;
    baselineAcceptanceRate: number;
    avgGeminiCallsPerBaseline: number;
  };
  verificationEvidence: {
    attemptedRuns: number;
    acceptedRuns: number;
    fallbackRuns: number;
    fallbackRate: number;
    runsWithDisagreement: number;
    disagreementRunRate: number;
    totalAdditionalOpenings: number;
    totalMissingOpenings: number;
    totalMateriallyDifferent: number;
    totalNotPresent: number;
    totalDisagreements: number;
    suspiciousNoDisagreement: boolean;
  };
  legacyGraphDiagnostics: {
    stableRate: number;
    avgGraphConfidence: number;
    avgExtractionAgreement: number;
    avgOpeningCountVariance: number;
    uniqueGraphHashes: number;
  };
};

type ModeResult = {
  summary: ModeSummary;
  runs: RunRecord[];
};

type BenchmarkReport = {
  generatedAt: string;
  imagePath: string;
  runsPerMode: number;
  mode: BenchmarkMode;
  results: Record<BaselineArchitectureMode, ModeResult>;
};

function readArg(name: string): string | null {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function resolveWorkspaceRoot(): string {
  const cwd = process.cwd();
  if (cwd.endsWith("/worker")) return path.resolve(cwd, "..");
  return cwd;
}

function resolveMode(): BenchmarkMode {
  const modeArg = readArg("--mode");
  if (!modeArg) return "both";
  if (modeArg === "graph_consensus" || modeArg === "extraction_verification" || modeArg === "both") {
    return modeArg;
  }
  throw new Error(`OPENING_BASELINE_BENCHMARK_INVALID_MODE: ${modeArg}`);
}

function resolveRuns(): number {
  const runsArg = Number(readArg("--runs") || "20");
  if (!Number.isFinite(runsArg) || runsArg <= 0) {
    throw new Error(`OPENING_BASELINE_BENCHMARK_INVALID_RUN_COUNT: ${runsArg}`);
  }
  return Math.floor(runsArg);
}

function inventoryHash(baseline: StructuralBaseline): string {
  const tokens = baseline.openings
    .map((opening) => [opening.type, opening.wallIndex, opening.horizontalBand, opening.verticalBand].join("|"))
    .sort((left, right) => left.localeCompare(right));
  return tokens.join("::");
}

function round(value: number, precision = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(part: number, total: number): number {
  if (total <= 0) return 0;
  return part / total;
}

function modalAgreement<T extends string | number>(values: T[]): number {
  if (values.length === 0) return 0;
  const histogram = new Map<T, number>();
  for (const value of values) {
    histogram.set(value, (histogram.get(value) || 0) + 1);
  }
  const maxCount = Math.max(...Array.from(histogram.values()));
  return ratio(maxCount, values.length);
}

async function runMode(
  imagePath: string,
  runs: number,
  mode: BaselineArchitectureMode,
): Promise<ModeResult> {
  const records: RunRecord[] = [];

  for (let index = 0; index < runs; index += 1) {
    const startedAt = Date.now();
    try {
      const baseline = await extractStructuralBaseline(imagePath, {
        jobId: `opening-baseline-benchmark-${mode}`,
        imageId: path.basename(imagePath),
        attempt: index + 1,
        baselineMode: mode,
        disableCache: true,
      });

      records.push({
        run: index + 1,
        ms: Date.now() - startedAt,
        error: null,
        openingCount: baseline.openings.length,
        inventoryHash: inventoryHash(baseline),
        graphHash: getStructuralBaselineGraphHash(baseline),
        graphStable: baseline.graphMeta?.graphStable ?? null,
        graphConfidence: Number.isFinite(Number(baseline.graphMeta?.graphConfidence))
          ? Number(baseline.graphMeta?.graphConfidence)
          : null,
        extractionAgreement: Number.isFinite(Number(baseline.graphMeta?.extractionAgreement))
          ? Number(baseline.graphMeta?.extractionAgreement)
          : null,
        openingCountVariance: Number.isFinite(Number(baseline.graphMeta?.openingCountVariance))
          ? Number(baseline.graphMeta?.openingCountVariance)
          : null,
        baselineAccepted: baseline.graphMeta?.verification
          ? baseline.graphMeta.verification.accepted
          : (baseline.graphMeta?.graphStable ?? null),
        geminiCalls: Number.isFinite(Number(baseline.graphMeta?.geminiCalls))
          ? Number(baseline.graphMeta?.geminiCalls)
          : (Number.isFinite(Number(baseline.graphMeta?.passCount)) ? Number(baseline.graphMeta?.passCount) : null),
        verificationAttempted: baseline.graphMeta?.verification?.attempted === true,
        verificationAccepted: baseline.graphMeta?.verification
          ? baseline.graphMeta.verification.accepted === true
          : null,
        fallbackUsed:
          baseline.graphMeta?.verification?.attempted === true &&
          baseline.graphMeta?.verification?.accepted !== true,
        verificationAdditionalOpenings: Number(baseline.graphMeta?.verification?.additionalOpeningCount || 0),
        verificationMissingOpenings: Number(baseline.graphMeta?.verification?.missingOpeningCount || 0),
        verificationMateriallyDifferent: Number(baseline.graphMeta?.verification?.materiallyDifferentCount || 0),
        verificationNotPresent: Number(baseline.graphMeta?.verification?.notPresentCount || 0),
        verificationMinorDifferences: Number(baseline.graphMeta?.verification?.minorDifferenceCount || 0),
        verificationDisagreements:
          Number(baseline.graphMeta?.verification?.additionalOpeningCount || 0) +
          Number(baseline.graphMeta?.verification?.missingOpeningCount || 0) +
          Number(baseline.graphMeta?.verification?.materiallyDifferentCount || 0) +
          Number(baseline.graphMeta?.verification?.notPresentCount || 0),
        verificationRejectedReasonCodes: Array.isArray(baseline.graphMeta?.verification?.rejectedReasonCodes)
          ? baseline.graphMeta?.verification?.rejectedReasonCodes
          : [],
      });
    } catch (error) {
      records.push({
        run: index + 1,
        ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        openingCount: 0,
        inventoryHash: null,
        graphHash: null,
        graphStable: null,
        graphConfidence: null,
        extractionAgreement: null,
        openingCountVariance: null,
        baselineAccepted: null,
        geminiCalls: null,
        verificationAttempted: false,
        verificationAccepted: null,
        fallbackUsed: false,
        verificationAdditionalOpenings: 0,
        verificationMissingOpenings: 0,
        verificationMateriallyDifferent: 0,
        verificationNotPresent: 0,
        verificationMinorDifferences: 0,
        verificationDisagreements: 0,
        verificationRejectedReasonCodes: [],
      });
    }
  }

  const successful = records.filter((record) => !record.error);
  const latencies = records.map((record) => record.ms);
  const openingCounts = successful.map((record) => record.openingCount);
  const inventoryHashes = successful
    .map((record) => record.inventoryHash)
    .filter((value: string | null): value is string => Boolean(value));
  const acceptedCount = successful.filter((record) => record.baselineAccepted === true).length;
  const geminiCalls = successful
    .map((record) => record.geminiCalls)
    .filter((value: number | null): value is number => typeof value === "number");
  const stableCount = successful.filter((record) => record.graphStable === true).length;
  const graphConfidenceValues = successful
    .map((record) => record.graphConfidence)
    .filter((value: number | null): value is number => typeof value === "number");
  const extractionAgreementValues = successful
    .map((record) => record.extractionAgreement)
    .filter((value: number | null): value is number => typeof value === "number");
  const openingCountVarianceValues = successful
    .map((record) => record.openingCountVariance)
    .filter((value: number | null): value is number => typeof value === "number");
  const uniqueGraphHashes = new Set(
    successful
      .map((record) => record.graphHash)
      .filter((value: string | null): value is string => Boolean(value)),
  );

  const verificationAttempted = successful.filter((record) => record.verificationAttempted).length;
  const verificationAccepted = successful.filter((record) => record.verificationAccepted === true).length;
  const fallbackRuns = successful.filter((record) => record.fallbackUsed).length;
  const runsWithDisagreement = successful.filter((record) => record.verificationDisagreements > 0).length;
  const totalAdditionalOpenings = successful.reduce((sum, record) => sum + record.verificationAdditionalOpenings, 0);
  const totalMissingOpenings = successful.reduce((sum, record) => sum + record.verificationMissingOpenings, 0);
  const totalMateriallyDifferent = successful.reduce((sum, record) => sum + record.verificationMateriallyDifferent, 0);
  const totalNotPresent = successful.reduce((sum, record) => sum + record.verificationNotPresent, 0);
  const totalDisagreements = successful.reduce((sum, record) => sum + record.verificationDisagreements, 0);

  return {
    summary: {
      mode,
      totalRuns: runs,
      successfulRuns: successful.length,
      failedRuns: runs - successful.length,
      benchmarkScope: {
        openingPreservationAccuracyMeasured: false,
        note: "This benchmark evaluates baseline extraction consistency only; use paired before/after opening regression fixtures to measure preservation accuracy.",
      },
      latencyMs: {
        min: latencies.length > 0 ? Math.min(...latencies) : 0,
        max: latencies.length > 0 ? Math.max(...latencies) : 0,
        avg: round(average(latencies), 2),
      },
      primaryMetrics: {
        openingCountConsistency: round(modalAgreement(openingCounts), 4),
        openingInventoryConsistency: round(modalAgreement(inventoryHashes), 4),
        baselineAcceptanceRate: round(ratio(acceptedCount, successful.length), 4),
        avgGeminiCallsPerBaseline: round(average(geminiCalls), 3),
      },
      verificationEvidence: {
        attemptedRuns: verificationAttempted,
        acceptedRuns: verificationAccepted,
        fallbackRuns,
        fallbackRate: round(ratio(fallbackRuns, verificationAttempted), 4),
        runsWithDisagreement,
        disagreementRunRate: round(ratio(runsWithDisagreement, verificationAttempted), 4),
        totalAdditionalOpenings,
        totalMissingOpenings,
        totalMateriallyDifferent,
        totalNotPresent,
        totalDisagreements,
        suspiciousNoDisagreement: verificationAttempted > 0 && runsWithDisagreement === 0,
      },
      legacyGraphDiagnostics: {
        stableRate: round(ratio(stableCount, successful.length), 4),
        avgGraphConfidence: round(average(graphConfidenceValues), 4),
        avgExtractionAgreement: round(average(extractionAgreementValues), 4),
        avgOpeningCountVariance: round(average(openingCountVarianceValues), 4),
        uniqueGraphHashes: uniqueGraphHashes.size,
      },
    },
    runs: records,
  };
}

async function main(): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot();
  const workerRoot = path.join(workspaceRoot, "worker");
  const mode = resolveMode();
  const runs = resolveRuns();
  const imagePath = readArg("--image") || path.join(workerRoot, "test-data", "Rental 03.jpg");
  const outputPath = readArg("--output")
    || path.join(workerRoot, "artifacts", `opening_baseline_architecture_benchmark_${runs}runs.json`);

  if (!process.env.GEMINI_API_KEY) {
    throw new Error("OPENING_BASELINE_BENCHMARK_REQUIRES_GEMINI_API_KEY");
  }

  const modes: BaselineArchitectureMode[] =
    mode === "both"
      ? ["graph_consensus", "extraction_verification"]
      : [mode];

  const results = {} as Record<BaselineArchitectureMode, ModeResult>;
  for (const item of modes) {
    results[item] = await runMode(imagePath, runs, item);
  }

  const verificationSummary = results.extraction_verification?.summary.verificationEvidence;
  if (verificationSummary?.suspiciousNoDisagreement) {
    console.warn("[BASELINE_BENCHMARK_SUSPICIOUS] verification reported zero disagreements across all attempted runs");
  }

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    imagePath,
    runsPerMode: runs,
    mode,
    results,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    outputPath,
    mode,
    runs,
    summary: Object.fromEntries(
      Object.entries(results).map(([key, value]) => [key, value.summary]),
    ),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
