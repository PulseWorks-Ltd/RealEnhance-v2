import fs from "node:fs";
import path from "node:path";

import { runOpeningValidator, type OpeningValidatorResult } from "../worker/src/validators/openingValidator";
import {
  extractStructuralBaseline,
  type StructuralBaseline,
  validateOpeningPreservation,
} from "../worker/src/validators/openingPreservationValidator";

type BenchmarkRun = {
  run: number;
  graphHash: string;
};

type PartialOpening = Partial<StructuralBaseline["openings"][number]> & {
  id?: string;
  type?: string;
  wallIndex?: number;
  horizontalBand?: string;
  verticalBand?: string;
  wallCoverageBand?: string;
  orientation?: string;
  paneStructure?: string;
  heightClass?: string;
  doorLeafState?: string;
  confidence?: number;
};

type PartialAnchor = {
  id?: string;
  type?: string;
  wallIndex?: number;
  horizontalBand?: string;
  confidence?: number;
};

type PartialBaseline = {
  openings?: PartialOpening[];
  anchorFixtures?: PartialAnchor[];
  wallCount?: number;
  cameraOrientation?: string;
};

type ScenarioConfig = {
  id: "A" | "B" | "C";
  name: string;
  baselineImagePath: string;
  comparisonImagePath: string;
};

type ScenarioRow = {
  baselineNumber: number;
  verdict: "PASS" | "FAIL";
  issueType: string;
  confidence: number;
  matchedOpenings: number;
  missingOpenings: number;
  additionalOpenings: number;
  reconciliationScore: number | null;
};

type ScenarioResult = {
  id: "A" | "B" | "C";
  name: string;
  baselineImagePath: string;
  comparisonImagePath: string;
  rows: ScenarioRow[];
  summary: {
    totalRuns: number;
    passCount: number;
    failCount: number;
    passRate: number;
    failRate: number;
    verdictConsistencyRate: number;
    uniqueVerdictCount: number;
    confidenceMean: number;
    confidenceVariance: number;
    confidenceStdDev: number;
  };
};

type ExperimentReport = {
  generatedAt: string;
  baselineVariantCount: number;
  sources: {
    benchmarkArtifact: string;
    benchmarkDetailLog: string;
  };
  scenarios: ScenarioResult[];
  finalAnswers: {
    baselineVariationChangedVerdicts: boolean;
    stabilizationNeededForConsistentOutcomes: boolean;
    confidenceVarianceByTest: Record<string, number>;
    latencyImprovementEstimate: {
      benchmarkAvgLatencyMs: number | null;
      instabilityRateAcrossTests: number;
      estimatedLatencyContributingToOutcomeMs: number | null;
      note: string;
    };
  };
};

function parseJsonAfterPrefix<T>(line: string, prefix: string): T | null {
  const idx = line.indexOf(prefix);
  if (idx < 0) return null;
  const jsonPart = line.slice(idx + prefix.length).trim();
  if (!jsonPart.startsWith("{")) return null;
  return JSON.parse(jsonPart) as T;
}

function toFixedNum(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function variance(values: number[]): number {
  if (!values.length) return 0;
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
}

function summarizeScenario(rows: ScenarioRow[]) {
  const totalRuns = rows.length;
  const passCount = rows.filter((row) => row.verdict === "PASS").length;
  const failCount = totalRuns - passCount;
  const passRate = totalRuns ? passCount / totalRuns : 0;
  const failRate = totalRuns ? failCount / totalRuns : 0;
  const uniqueVerdicts = new Set(rows.map((row) => row.verdict));
  const verdictConsistencyRate = totalRuns ? Math.max(passCount, failCount) / totalRuns : 0;
  const confidences = rows.map((row) => row.confidence);
  const confVar = variance(confidences);
  const confMean = mean(confidences);
  return {
    totalRuns,
    passCount,
    failCount,
    passRate: toFixedNum(passRate),
    failRate: toFixedNum(failRate),
    verdictConsistencyRate: toFixedNum(verdictConsistencyRate),
    uniqueVerdictCount: uniqueVerdicts.size,
    confidenceMean: toFixedNum(confMean),
    confidenceVariance: toFixedNum(confVar),
    confidenceStdDev: toFixedNum(Math.sqrt(confVar)),
  };
}

function markdownTable(rows: ScenarioRow[]): string {
  const header = [
    "Baseline #",
    "Verdict",
    "Issue Type",
    "Confidence",
    "Matched",
    "Missing",
    "Additional",
    "Reconciliation Score",
  ];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.baselineNumber} | ${row.verdict} | ${row.issueType} | ${row.confidence.toFixed(3)} | ${row.matchedOpenings} | ${row.missingOpenings} | ${row.additionalOpenings} | ${row.reconciliationScore === null ? "n/a" : row.reconciliationScore.toFixed(3)} |`,
    );
  }

  return lines.join("\n");
}

function approxBboxFromBands(horizontalBand?: string, verticalBand?: string): [number, number, number, number] {
  const h = String(horizontalBand || "center_third");
  const v = String(verticalBand || "mid_zone");
  let x1 = 0.35;
  let x2 = 0.65;
  let y1 = 0.3;
  let y2 = 0.7;

  if (h === "left_third") {
    x1 = 0.05;
    x2 = 0.35;
  } else if (h === "right_third") {
    x1 = 0.65;
    x2 = 0.95;
  }

  if (v === "full_height") {
    y1 = 0.05;
    y2 = 0.95;
  } else if (v === "floor_zone") {
    y1 = 0.6;
    y2 = 0.95;
  } else if (v === "ceiling_zone") {
    y1 = 0.05;
    y2 = 0.35;
  }

  return [x1, y1, x2, y2];
}

function structuralClassForType(type: string): "circulation" | "storage" | "exterior" | "unknown" {
  if (type === "walkthrough" || type === "door") return "circulation";
  if (type === "closet_door") return "storage";
  if (type === "window") return "exterior";
  return "unknown";
}

function normalizeBaseline(partial: PartialBaseline): StructuralBaseline {
  const normalizedOpenings = (partial.openings || []).map((opening, idx) => {
    const typeRaw = String(opening.type || "window").toLowerCase();
    const type = (typeRaw === "door" || typeRaw === "walkthrough" || typeRaw === "closet_door" || typeRaw === "window")
      ? typeRaw
      : "window";
    const horizontalBand = (opening.horizontalBand === "left_third" || opening.horizontalBand === "center_third" || opening.horizontalBand === "right_third")
      ? opening.horizontalBand
      : "center_third";
    const verticalBand = (opening.verticalBand === "floor_zone" || opening.verticalBand === "mid_zone" || opening.verticalBand === "ceiling_zone" || opening.verticalBand === "full_height")
      ? opening.verticalBand
      : "mid_zone";
    const wallCoverageBand = (opening.wallCoverageBand === "5-10" || opening.wallCoverageBand === "10-20" || opening.wallCoverageBand === "20-40" || opening.wallCoverageBand === "40-60" || opening.wallCoverageBand === "60+")
      ? opening.wallCoverageBand
      : "20-40";
    const bbox = Array.isArray((opening as any).bbox) && (opening as any).bbox.length === 4
      ? (opening as any).bbox as [number, number, number, number]
      : approxBboxFromBands(horizontalBand, verticalBand);
    const width = Math.max(0.01, Number(bbox[2]) - Number(bbox[0]));
    const height = Math.max(0.01, Number(bbox[3]) - Number(bbox[1]));

    return {
      id: String(opening.id || `${type.toUpperCase()}_${idx + 1}`),
      type,
      bbox,
      area_pct: Math.max(0.01, Math.min(1, Number((opening as any).area_pct ?? width * height))),
      aspect_ratio: Math.max(0.01, Number((opening as any).aspect_ratio ?? width / height)),
      structuralClass: structuralClassForType(type),
      wallIndex: (Number.isInteger(opening.wallIndex) && Number(opening.wallIndex) >= 0 && Number(opening.wallIndex) <= 3
        ? Number(opening.wallIndex)
        : 0) as 0 | 1 | 2 | 3,
      horizontalBand,
      verticalBand,
      widthBand: width >= 0.5 ? "wide" : width >= 0.3 ? "double" : width >= 0.15 ? "single" : "narrow",
      wallCoverageBand,
      orientation: (opening.orientation === "portrait" || opening.orientation === "landscape" || opening.orientation === "square")
        ? opening.orientation
        : "landscape",
      paneStructure: (opening.paneStructure === "single_fixed" || opening.paneStructure === "double_fixed" || opening.paneStructure === "fixed_plus_opening" || opening.paneStructure === "sliding_panel" || opening.paneStructure === "multi_pane_grid" || opening.paneStructure === "unknown")
        ? opening.paneStructure
        : "unknown",
      heightClass: (opening.heightClass === "standard" || opening.heightClass === "floor_to_ceiling" || opening.heightClass === "transom")
        ? opening.heightClass
        : (verticalBand === "full_height" ? "floor_to_ceiling" : "standard"),
      doorLeafState: (opening.doorLeafState === "closed" || opening.doorLeafState === "open" || opening.doorLeafState === "ajar" || opening.doorLeafState === "unknown")
        ? opening.doorLeafState
        : "unknown",
      approxAspectRatio: Math.max(0.01, Number((opening as any).approxAspectRatio ?? width / height)),
      confidence: Number.isFinite(Number(opening.confidence)) ? Number(opening.confidence) : 0.8,
      wallPosition: "far_wall",
      relativeHorizontalPosition: horizontalBand === "center_third" ? "center" : horizontalBand,
      shape: type === "window" ? "rectangular" : "opening",
      touchesFloor: verticalBand === "full_height" || verticalBand === "floor_zone",
      touchesCeiling: verticalBand === "full_height" || verticalBand === "ceiling_zone",
      approxCount: 1,
    } as StructuralBaseline["openings"][number];
  });

  const normalizedAnchors = (partial.anchorFixtures || []).map((fixture, idx) => {
    const horizontalBand = (fixture.horizontalBand === "left_third" || fixture.horizontalBand === "center_third" || fixture.horizontalBand === "right_third")
      ? fixture.horizontalBand
      : "center_third";
    return {
      id: String(fixture.id || `AF_${idx + 1}`),
      type: (fixture.type === "ac_unit" || fixture.type === "fireplace" || fixture.type === "built_in_cabinet" || fixture.type === "kitchen_island" || fixture.type === "staircase" || fixture.type === "other")
        ? fixture.type
        : "other",
      wallIndex: (Number.isInteger(fixture.wallIndex) && Number(fixture.wallIndex) >= 0 && Number(fixture.wallIndex) <= 3
        ? Number(fixture.wallIndex)
        : 0) as 0 | 1 | 2 | 3,
      horizontalBand,
      bbox: approxBboxFromBands(horizontalBand, "mid_zone"),
      confidence: Number.isFinite(Number(fixture.confidence)) ? Number(fixture.confidence) : 0.8,
    };
  });

  return {
    cameraOrientation: partial.cameraOrientation,
    openings: normalizedOpenings,
    anchorFixtures: normalizedAnchors,
    wallCount: Number.isFinite(Number(partial.wallCount)) ? Number(partial.wallCount) : 4,
  };
}

async function main() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  const root = "/workspaces/RealEnhance-v2";
  const artifactPath = path.join(root, "worker/artifacts/opening_baseline_architecture_benchmark_20runs.json");
  const detailedLogPath = path.join(root, "worker/artifacts/opening_baseline_architecture_benchmark_20runs_detailed.log");

  const baselineImage = path.join(root, "worker/test-data/Rental 03.jpg");
  const stage2Image = path.join(root, "tmp/rental03-stage2-1780536305731.png");
  const openingCoveredImage = path.join(root, "Test Images/Declutter Validator Testing/Rental 03 - Opening Covered.jpg");

  for (const requiredPath of [artifactPath, detailedLogPath, baselineImage, stage2Image, openingCoveredImage]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Required path missing: ${requiredPath}`);
    }
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
    results: { extraction_verification: { runs: BenchmarkRun[]; summary?: { latencyMs?: { avg?: number } } } };
  };

  const runs = artifact?.results?.extraction_verification?.runs || [];
  if (runs.length !== 20) {
    throw new Error(`Expected 20 runs in benchmark artifact, got ${runs.length}`);
  }

  const logLines = fs.readFileSync(detailedLogPath, "utf8").split(/\r?\n/);
  let pendingBaseline: PartialBaseline | null = null;
  const baselineByGraphHash = new Map<string, StructuralBaseline>();
  const sequentialBaselines: StructuralBaseline[] = [];

  for (const line of logLines) {
    if (line.includes("[OPENING_BASELINE]")) {
      const parsed = parseJsonAfterPrefix<PartialBaseline>(line, "[OPENING_BASELINE]");
      pendingBaseline = parsed;
      continue;
    }

    if (line.includes("[BASELINE_EXTRACTION_RESULT]")) {
      const extraction = parseJsonAfterPrefix<{ graphHash?: string }>(line, "[BASELINE_EXTRACTION_RESULT]");
      const graphHash = extraction?.graphHash;
      if (pendingBaseline && graphHash) {
        const normalized = normalizeBaseline(pendingBaseline);
        baselineByGraphHash.set(graphHash, normalized);
        sequentialBaselines.push(normalized);
      }
      pendingBaseline = null;
    }
  }

  let baselineVariants: StructuralBaseline[] = [];
  const mappedVariants: StructuralBaseline[] = [];
  let mappingComplete = true;
  for (const run of runs) {
    const baseline = baselineByGraphHash.get(run.graphHash);
    if (!baseline) {
      mappingComplete = false;
      break;
    }
    mappedVariants.push(baseline);
  }

  if (mappingComplete && mappedVariants.length === 20) {
    baselineVariants = mappedVariants;
  } else {
    if (sequentialBaselines.length < 20) {
      throw new Error(`Could not source 20 baseline variants from existing artifacts/logs. Found only ${sequentialBaselines.length}.`);
    }
    baselineVariants = sequentialBaselines.slice(0, 20);
    // Intentionally silent here; report file includes sources and variant count.
  }

  const scenarios: ScenarioConfig[] = [
    {
      id: "A",
      name: "Test A: Same Image Against Itself",
      baselineImagePath: baselineImage,
      comparisonImagePath: baselineImage,
    },
    {
      id: "B",
      name: "Test B: Known Good Stage 2 Output",
      baselineImagePath: baselineImage,
      comparisonImagePath: stage2Image,
    },
    {
      id: "C",
      name: "Test C: Known Opening Failure Fixture",
      baselineImagePath: baselineImage,
      comparisonImagePath: openingCoveredImage,
    },
  ];

  const scenarioResults: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const fixedDetectedBaseline = await extractStructuralBaseline(scenario.comparisonImagePath, {
      jobId: `opening-baseline-variation-${scenario.id.toLowerCase()}-fixed-candidate`,
      imageId: path.basename(scenario.comparisonImagePath),
      attempt: 1,
    });

    const rows: ScenarioRow[] = [];

    for (let index = 0; index < baselineVariants.length; index += 1) {
      const baselineVariant = baselineVariants[index]!;
      const baselineNumber = index + 1;

      const result: OpeningValidatorResult = await runOpeningValidator(
        scenario.baselineImagePath,
        scenario.comparisonImagePath,
        {
          jobId: `opening-baseline-variation-${scenario.id.toLowerCase()}`,
          imageId: `baseline-${baselineNumber}`,
          attempt: baselineNumber,
          microChecks: false,
          baseline: baselineVariant,
          detectedBaseline: fixedDetectedBaseline,
        },
      );

      const deterministic = await validateOpeningPreservation(
        baselineVariant,
        scenario.comparisonImagePath,
        {
          jobId: `opening-baseline-variation-${scenario.id.toLowerCase()}-deterministic`,
          imageId: `baseline-${baselineNumber}`,
          attempt: baselineNumber,
          detectedBaseline: fixedDetectedBaseline,
        },
      );

      const findings = Array.isArray(result.findings) ? result.findings : [];
      const missingOpenings = findings.filter((finding) => finding.status === "missing" || finding.status === "infilled").length;
      const beforeCount = Number(deterministic.summary.openingCount?.before ?? baselineVariant.openings.length);
      const afterCount = Number(deterministic.summary.openingCount?.after ?? fixedDetectedBaseline.openings.length);
      const additionalOpenings = Math.max(0, afterCount - beforeCount);
      const matchedOpenings = Array.isArray(deterministic.reconciledMatches)
        ? deterministic.reconciledMatches.length
        : Math.max(0, beforeCount - missingOpenings);
      const reconciliationScore = beforeCount > 0 ? matchedOpenings / beforeCount : null;

      rows.push({
        baselineNumber,
        verdict: result.status === "pass" ? "PASS" : "FAIL",
        issueType: result.issueType || "none",
        confidence: Number(result.confidence ?? 0),
        matchedOpenings,
        missingOpenings,
        additionalOpenings,
        reconciliationScore,
      });
    }

    scenarioResults.push({
      id: scenario.id,
      name: scenario.name,
      baselineImagePath: scenario.baselineImagePath,
      comparisonImagePath: scenario.comparisonImagePath,
      rows,
      summary: summarizeScenario(rows),
    });
  }

  const baselineVariationChangedVerdicts = scenarioResults.some((scenario) => scenario.summary.uniqueVerdictCount > 1);
  const stabilizationNeededForConsistentOutcomes = baselineVariationChangedVerdicts;
  const confidenceVarianceByTest = Object.fromEntries(
    scenarioResults.map((scenario) => [scenario.id, scenario.summary.confidenceVariance]),
  );

  const avgLatencyMs = Number(
    artifact?.results?.extraction_verification?.summary?.latencyMs?.avg ?? Number.NaN,
  );
  const benchmarkAvgLatencyMs = Number.isFinite(avgLatencyMs) ? avgLatencyMs : null;
  const instabilityRates = scenarioResults.map((scenario) => 1 - scenario.summary.verdictConsistencyRate);
  const instabilityRateAcrossTests = toFixedNum(mean(instabilityRates));
  const estimatedLatencyContributingToOutcomeMs = benchmarkAvgLatencyMs === null
    ? null
    : toFixedNum(benchmarkAvgLatencyMs * instabilityRateAcrossTests, 2);

  const report: ExperimentReport = {
    generatedAt: new Date().toISOString(),
    baselineVariantCount: baselineVariants.length,
    sources: {
      benchmarkArtifact: artifactPath,
      benchmarkDetailLog: detailedLogPath,
    },
    scenarios: scenarioResults,
    finalAnswers: {
      baselineVariationChangedVerdicts,
      stabilizationNeededForConsistentOutcomes,
      confidenceVarianceByTest,
      latencyImprovementEstimate: {
        benchmarkAvgLatencyMs,
        instabilityRateAcrossTests,
        estimatedLatencyContributingToOutcomeMs,
        note: "Estimated as benchmark avg baseline stabilization latency multiplied by observed verdict instability rate across Tests A/B/C.",
      },
    },
  };

  const outputJsonPath = path.join(root, "analysis/opening_validator_baseline_variation_experiment_rental03.json");
  const outputMdPath = path.join(root, "analysis/opening_validator_baseline_variation_experiment_rental03.md");

  fs.writeFileSync(outputJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const mdParts: string[] = [];
  mdParts.push("# Opening Validator Baseline Variation Experiment (Rental 03)");
  mdParts.push("");
  mdParts.push(`Generated at: ${report.generatedAt}`);
  mdParts.push("");

  for (const scenario of scenarioResults) {
    mdParts.push(`## ${scenario.name}`);
    mdParts.push("");
    mdParts.push(`Baseline image: ${scenario.baselineImagePath}`);
    mdParts.push(`Comparison image: ${scenario.comparisonImagePath}`);
    mdParts.push("");
    mdParts.push(markdownTable(scenario.rows));
    mdParts.push("");
    mdParts.push("Summary:");
    mdParts.push(`- Total runs: ${scenario.summary.totalRuns}`);
    mdParts.push(`- PASS: ${scenario.summary.passCount}`);
    mdParts.push(`- FAIL: ${scenario.summary.failCount}`);
    mdParts.push(`- Verdict consistency rate: ${scenario.summary.verdictConsistencyRate.toFixed(4)}`);
    mdParts.push(`- Unique verdict count: ${scenario.summary.uniqueVerdictCount}`);
    mdParts.push(`- Confidence mean: ${scenario.summary.confidenceMean.toFixed(4)}`);
    mdParts.push(`- Confidence variance: ${scenario.summary.confidenceVariance.toFixed(4)}`);
    mdParts.push(`- Confidence std dev: ${scenario.summary.confidenceStdDev.toFixed(4)}`);
    mdParts.push("");
  }

  mdParts.push("## Final Answers");
  mdParts.push("");
  mdParts.push(`A. Did baseline variation change Opening Validator verdicts? ${report.finalAnswers.baselineVariationChangedVerdicts ? "Yes" : "No"}`);
  mdParts.push(`B. Did baseline stabilization appear necessary to achieve consistent outcomes? ${report.finalAnswers.stabilizationNeededForConsistentOutcomes ? "Yes" : "No"}`);
  mdParts.push(`C. Confidence variance by test: A=${report.finalAnswers.confidenceVarianceByTest.A ?? "n/a"}, B=${report.finalAnswers.confidenceVarianceByTest.B ?? "n/a"}, C=${report.finalAnswers.confidenceVarianceByTest.C ?? "n/a"}`);
  mdParts.push(
    `D. Estimated latency contributing to outcome improvements: ${
      report.finalAnswers.latencyImprovementEstimate.estimatedLatencyContributingToOutcomeMs === null
        ? "n/a"
        : `${report.finalAnswers.latencyImprovementEstimate.estimatedLatencyContributingToOutcomeMs.toFixed(2)} ms`
    } (instability rate=${report.finalAnswers.latencyImprovementEstimate.instabilityRateAcrossTests.toFixed(4)}, benchmark avg latency=${report.finalAnswers.latencyImprovementEstimate.benchmarkAvgLatencyMs ?? "n/a"} ms)`,
  );
  mdParts.push("");

  fs.writeFileSync(outputMdPath, `${mdParts.join("\n")}\n`, "utf8");

  console.log = originalLog;
  console.warn = originalWarn;
  process.stdout.write(`${JSON.stringify({
    outputJsonPath,
    outputMdPath,
    baselineVariantCount: baselineVariants.length,
    scenarioSummaries: scenarioResults.map((scenario) => ({
      id: scenario.id,
      pass: scenario.summary.passCount,
      fail: scenario.summary.failCount,
      verdictConsistencyRate: scenario.summary.verdictConsistencyRate,
      confidenceVariance: scenario.summary.confidenceVariance,
    })),
    finalAnswers: report.finalAnswers,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error("OPENING_BASELINE_VARIATION_EXPERIMENT_FAILED", error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
