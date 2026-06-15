#!/usr/bin/env tsx
/**
 * PHASE 5: REPEATABILITY TEST HARNESS
 * 
 * Compares current vs experimental baseline extraction prompts
 * across 10 runs each on the same baseline image.
 * 
 * Usage:
 * pnpm tsx analysis/window_shift_regression/test-experimental-prompt.ts
 * 
 * Output:
 * - analysis/window_shift_regression/experimental_prompt_comparison_{timestamp}.json
 * - Metrics: uniqueGraphCount, uniqueLayoutCount, bbox variance, resize variance
 */

import fs from 'fs';
import path from 'path';

// Import the validator (you may need to adjust the import path)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const openingPreservationModule = require('./worker/src/validators/openingPreservationValidator.ts');
const { extractStructuralBaseline } = openingPreservationModule.default;

const BASELINE_IMAGE = '/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/baseline.jpg';
const OUT_DIR = '/workspaces/RealEnhance-v2/analysis/window_shift_regression';
const RUNS = 10;

interface BaselineExtraction {
  openings: Array<{
    id: string;
    bbox: [number, number, number, number];
    wallIndex: number;
    area_pct: number;
  }>;
}

interface RunResult {
  runIndex: number;
  promptVersion: 'current' | 'experimental';
  extraction: BaselineExtraction;
  graphHash: string;
  layoutKey: string;
  resizePercent: number;
  extractionTimeMs: number;
}

interface ComparisonMetrics {
  promptVersion: 'current' | 'experimental';
  totalRuns: number;
  uniqueGraphCount: number;
  uniqueLayoutCount: number;
  bboxVariance: {
    [openingId: string]: {
      x1: { min: number; max: number; mean: number; stddev: number };
      y1: { min: number; max: number; mean: number; stddev: number };
      x2: { min: number; max: number; mean: number; stddev: number };
      y2: { min: number; max: number; mean: number; stddev: number };
    };
  };
  resizePercent: {
    min: number;
    max: number;
    mean: number;
    stddev: number;
    values: number[];
  };
  openingCountStability: { stable: boolean; count: number; variance: number[] };
  wallAssignmentStability: {
    [openingId: string]: { counts: { [wallIndex: number]: number }; mostCommon: number; consistency: number };
  };
  idStability: { stable: boolean; variations: number };
  extractionTimeMs: { min: number; max: number; mean: number };
}

function computeHash(obj: any): string {
  // Simple hash for comparison; in production use crypto.createHash
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function layoutKey(baseline: BaselineExtraction): string {
  const sorted = [...(baseline.openings || [])].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(sorted.map((o) => ({ id: o.id, bbox: o.bbox })));
}

function bboxVariance(runs: RunResult[]): ComparisonMetrics['bboxVariance'] {
  const variance: ComparisonMetrics['bboxVariance'] = {};

  const openingIds = new Set<string>();
  runs.forEach((r) => r.extraction.openings.forEach((o) => openingIds.add(o.id)));

  openingIds.forEach((id) => {
    const coords = { x1: [], y1: [], x2: [], y2: [] } as {
      x1: number[];
      y1: number[];
      x2: number[];
      y2: number[];
    };

    runs.forEach((r) => {
      const opening = r.extraction.openings.find((o) => o.id === id);
      if (opening) {
        coords.x1.push(opening.bbox[0]);
        coords.y1.push(opening.bbox[1]);
        coords.x2.push(opening.bbox[2]);
        coords.y2.push(opening.bbox[3]);
      }
    });

    variance[id] = {
      x1: computeStats(coords.x1),
      y1: computeStats(coords.y1),
      x2: computeStats(coords.x2),
      y2: computeStats(coords.y2),
    };
  });

  return variance;
}

function computeStats(values: number[]): { min: number; max: number; mean: number; stddev: number } {
  const sorted = values.sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(mean * 10000) / 10000,
    stddev: Math.round(stddev * 10000) / 10000,
  };
}

async function runExtractionPass(
  imageUrl: string,
  promptVersion: 'current' | 'experimental',
  runIndex: number,
): Promise<RunResult> {
  const startTime = Date.now();
  try {
    // TODO: Create a mechanism to switch between prompt versions
    // For now, this uses the current prompt
    // You'll need to modify extractStructuralBaseline to accept a promptVersion parameter
    const extraction = await extractStructuralBaseline(imageUrl, {
      // Add prompt version when available
      promptVersion,
    });

    const extractionTimeMs = Date.now() - startTime;
    const graphHash = computeHash(extraction);
    const layout = layoutKey(extraction);

    // Calculate resize percent (for compatibility with prior tests)
    const totalArea = (extraction.openings || []).reduce((sum, o) => sum + o.area_pct, 0);
    const resizePercent = totalArea;

    return {
      runIndex,
      promptVersion,
      extraction,
      graphHash,
      layoutKey: layout,
      resizePercent,
      extractionTimeMs,
    };
  } catch (error) {
    console.error(`ERROR in run ${runIndex} (${promptVersion}):`, error);
    throw error;
  }
}

function analyzeRuns(runs: RunResult[]): ComparisonMetrics {
  const graphHashes = new Set(runs.map((r) => r.graphHash));
  const layoutKeys = new Set(runs.map((r) => r.layoutKey));
  const resizeValues = runs.map((r) => r.resizePercent);
  const openingCounts = runs.map((r) => r.extraction.openings.length);

  const variance = bboxVariance(runs);

  // Wall assignment stability
  const wallStability: ComparisonMetrics['wallAssignmentStability'] = {};
  const openingIds = new Set<string>();
  runs.forEach((r) => r.extraction.openings.forEach((o) => openingIds.add(o.id)));

  openingIds.forEach((id) => {
    const wallIndices: { [key: number]: number } = {};
    runs.forEach((r) => {
      const opening = r.extraction.openings.find((o) => o.id === id);
      if (opening) {
        wallIndices[opening.wallIndex] = (wallIndices[opening.wallIndex] || 0) + 1;
      }
    });

    const mostCommon = Object.entries(wallIndices).sort((a, b) => b[1] - a[1])[0]?.[0];
    const consistency = (wallIndices[mostCommon] || 0) / runs.length;

    wallStability[id] = {
      counts: wallIndices as any,
      mostCommon: Number(mostCommon),
      consistency: Math.round(consistency * 10000) / 10000,
    };
  });

  // ID stability
  const idVariations = new Set(runs.map((r) => r.extraction.openings.map((o) => o.id).join(','))).size;

  return {
    promptVersion: runs[0].promptVersion,
    totalRuns: runs.length,
    uniqueGraphCount: graphHashes.size,
    uniqueLayoutCount: layoutKeys.size,
    bboxVariance: variance,
    resizePercent: computeStats(resizeValues),
    openingCountStability: {
      stable: new Set(openingCounts).size === 1,
      count: openingCounts[0],
      variance: Array.from(new Set(openingCounts)),
    },
    wallAssignmentStability: wallStability,
    idStability: {
      stable: idVariations === 1,
      variations: idVariations,
    },
    extractionTimeMs: {
      min: Math.min(...runs.map((r) => r.extractionTimeMs)),
      max: Math.max(...runs.map((r) => r.extractionTimeMs)),
      mean: Math.round((runs.reduce((sum, r) => sum + r.extractionTimeMs, 0) / runs.length) * 100) / 100,
    },
  };
}

async function main() {
  console.log('PHASE 5: REPEATABILITY TEST');
  console.log(`Image: ${BASELINE_IMAGE}`);
  console.log(`Runs per prompt: ${RUNS}`);
  console.log('');

  // Check if image exists
  if (!fs.existsSync(BASELINE_IMAGE)) {
    console.error(`ERROR: Image not found: ${BASELINE_IMAGE}`);
    process.exit(1);
  }

  const allRuns: RunResult[] = [];
  const timestamp = Date.now();

  // Run current prompt 10 times
  console.log('Running CURRENT prompt (10 times)...');
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`  Run ${i + 1}/${RUNS}... `);
    try {
      const result = await runExtractionPass(BASELINE_IMAGE, 'current', i);
      allRuns.push(result);
      console.log(`OK (${result.extractionTimeMs}ms, hash=${result.graphHash.slice(0, 8)})`);
    } catch (error) {
      console.log(`FAILED: ${error}`);
      process.exit(1);
    }
  }

  console.log('');

  // Run experimental prompt 10 times
  console.log('Running EXPERIMENTAL prompt (10 times)...');
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`  Run ${i + 1}/${RUNS}... `);
    try {
      const result = await runExtractionPass(BASELINE_IMAGE, 'experimental', i);
      allRuns.push(result);
      console.log(`OK (${result.extractionTimeMs}ms, hash=${result.graphHash.slice(0, 8)})`);
    } catch (error) {
      console.log(`FAILED: ${error}`);
      process.exit(1);
    }
  }

  // Analyze results
  console.log('');
  console.log('Analyzing results...');

  const currentRuns = allRuns.filter((r) => r.promptVersion === 'current');
  const experimentalRuns = allRuns.filter((r) => r.promptVersion === 'experimental');

  const currentMetrics = analyzeRuns(currentRuns);
  const experimentalMetrics = analyzeRuns(experimentalRuns);

  // Generate comparison report
  const report = {
    timestamp,
    baseline_image: BASELINE_IMAGE,
    runs_per_version: RUNS,
    current: currentMetrics,
    experimental: experimentalMetrics,
    improvement: {
      uniqueGraphCount: Math.round(
        ((currentMetrics.uniqueGraphCount - experimentalMetrics.uniqueGraphCount) /
          currentMetrics.uniqueGraphCount) *
          100,
      ),
      uniqueLayoutCount: Math.round(
        ((currentMetrics.uniqueLayoutCount - experimentalMetrics.uniqueLayoutCount) /
          currentMetrics.uniqueLayoutCount) *
          100,
      ),
      resizeVariance: Math.round(
        ((currentMetrics.resizePercent.stddev - experimentalMetrics.resizePercent.stddev) /
          currentMetrics.resizePercent.stddev) *
          100,
      ),
      idStability:
        currentMetrics.idStability.variations === experimentalMetrics.idStability.variations ? 0 : 100,
    },
    all_runs: allRuns,
  };

  // Save report
  const outPath = path.join(OUT_DIR, `experimental_prompt_comparison_${timestamp}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\nReport saved to: ${outPath}`);
  console.log('');
  console.log('SUMMARY');
  console.log('-------');
  console.log(`Current prompt:`);
  console.log(`  uniqueGraphCount: ${currentMetrics.uniqueGraphCount}`);
  console.log(`  uniqueLayoutCount: ${currentMetrics.uniqueLayoutCount}`);
  console.log(`  resize stddev: ${currentMetrics.resizePercent.stddev}`);
  console.log(`  id variations: ${currentMetrics.idStability.variations}`);
  console.log('');
  console.log(`Experimental prompt:`);
  console.log(`  uniqueGraphCount: ${experimentalMetrics.uniqueGraphCount}`);
  console.log(`  uniqueLayoutCount: ${experimentalMetrics.uniqueLayoutCount}`);
  console.log(`  resize stddev: ${experimentalMetrics.resizePercent.stddev}`);
  console.log(`  id variations: ${experimentalMetrics.idStability.variations}`);
  console.log('');
  console.log(`Improvements:`);
  console.log(`  uniqueGraphCount: ${report.improvement.uniqueGraphCount}%`);
  console.log(`  uniqueLayoutCount: ${report.improvement.uniqueLayoutCount}%`);
  console.log(`  resizeVariance: ${report.improvement.resizeVariance}%`);
  console.log('');
}

main().catch((error) => {
  console.error('FATAL ERROR:', error);
  process.exit(1);
});
