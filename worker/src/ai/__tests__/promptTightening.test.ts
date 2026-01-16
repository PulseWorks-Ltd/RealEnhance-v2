/**
 * Prompt Tightening & Sampling Backoff Unit Tests
 *
 * Run with: npx tsx src/ai/__tests__/promptTightening.test.ts
 */

import {
  applySamplingBackoff,
  formatSamplingParams,
  SamplingParams,
  SamplingBackoffLimits,
} from "../promptTightening";

// Simple test runner
let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    console.log(`  ✗ ${testName}`);
  }
}

function assertEqual<T>(actual: T, expected: T, testName: string) {
  const match = actual === expected;
  if (!match) {
    console.log(`  ✗ ${testName} (expected ${expected}, got ${actual})`);
    failed++;
  } else {
    passed++;
    console.log(`  ✓ ${testName}`);
  }
}

function assertApproxEqual(actual: number, expected: number, tolerance: number, testName: string) {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    passed++;
    console.log(`  ✓ ${testName} (${actual.toFixed(4)} ≈ ${expected.toFixed(4)})`);
  } else {
    failed++;
    console.log(`  ✗ ${testName} (expected ≈${expected.toFixed(4)}, got ${actual.toFixed(4)}, diff=${diff.toFixed(4)})`);
  }
}

console.log("\n=== applySamplingBackoff Tests ===\n");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: attempt 0 returns unchanged params
// ═══════════════════════════════════════════════════════════════════════════════
console.log("attempt 0 (first attempt):");

const baseParams: SamplingParams = { temperature: 0.10, topP: 0.90, topK: 30 };

const result0 = applySamplingBackoff(baseParams, 0);
assertEqual(result0.temperature, 0.10, "temperature unchanged at attempt 0");
assertEqual(result0.topP, 0.90, "topP unchanged at attempt 0");
assertEqual(result0.topK, 30, "topK unchanged at attempt 0");

// Verify it doesn't mutate original
assertEqual(baseParams.temperature, 0.10, "original baseParams not mutated");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: attempt 1 reduces by 10%
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nattempt 1 (first retry, 10% reduction):");

const result1 = applySamplingBackoff(baseParams, 1);
// factor = 0.9^1 = 0.9
// temp: 0.10 * 0.9 = 0.09
// topP: 0.90 * 0.9 = 0.81
// topK: round(30 * 0.9) = round(27) = 27
assertApproxEqual(result1.temperature!, 0.09, 0.0001, "temperature reduced by 10%");
assertApproxEqual(result1.topP!, 0.81, 0.0001, "topP reduced by 10%");
assertEqual(result1.topK, 27, "topK reduced by 10% (rounded)");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: attempt 2 reduces by compounded 19% (0.9^2 = 0.81)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nattempt 2 (second retry, ~19% compound reduction):");

const result2 = applySamplingBackoff(baseParams, 2);
// factor = 0.9^2 = 0.81
// temp: 0.10 * 0.81 = 0.081
// topP: 0.90 * 0.81 = 0.729
// topK: round(30 * 0.81) = round(24.3) = 24
assertApproxEqual(result2.temperature!, 0.081, 0.0001, "temperature reduced by ~19%");
assertApproxEqual(result2.topP!, 0.729, 0.0001, "topP reduced by ~19%");
assertEqual(result2.topK, 24, "topK reduced by ~19% (rounded)");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: attempt 3 reduces by compounded 27% (0.9^3 = 0.729)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nattempt 3 (third retry, ~27% compound reduction):");

const result3 = applySamplingBackoff(baseParams, 3);
// factor = 0.9^3 = 0.729
// temp: 0.10 * 0.729 = 0.0729
// topP: 0.90 * 0.729 = 0.6561
// topK: round(30 * 0.729) = round(21.87) = 22
assertApproxEqual(result3.temperature!, 0.0729, 0.0001, "temperature reduced by ~27%");
assertApproxEqual(result3.topP!, 0.6561, 0.0001, "topP reduced by ~27%");
assertEqual(result3.topK, 22, "topK reduced by ~27% (rounded)");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: clamps work correctly
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nclamp behavior:");

// With very low baseline, clamps should kick in
const lowBaseParams: SamplingParams = { temperature: 0.05, topP: 0.20, topK: 8 };
const resultLow = applySamplingBackoff(lowBaseParams, 3);
// factor = 0.729
// temp: 0.05 * 0.729 = 0.03645 → clamp to 0.02 (minTemp)
// topP: 0.20 * 0.729 = 0.1458 → clamp to 0.15 (minTopP)
// topK: round(8 * 0.729) = round(5.832) = 6 → stays at 6 (above minTopK=5)
assertApproxEqual(resultLow.temperature!, 0.03645, 0.0001, "temperature clamped above minimum");
assertEqual(resultLow.topP, 0.15, "topP clamped to minimum 0.15");
assertEqual(resultLow.topK, 6, "topK stays above minimum");

// Test even more extreme case
const tinyBaseParams: SamplingParams = { temperature: 0.01, topP: 0.10, topK: 5 };
const resultTiny = applySamplingBackoff(tinyBaseParams, 5);
// factor = 0.9^5 = 0.59049
assertEqual(resultTiny.temperature, 0.02, "temperature clamped to minTemp=0.02");
assertEqual(resultTiny.topP, 0.15, "topP clamped to minTopP=0.15");
assertEqual(resultTiny.topK, 5, "topK clamped to minTopK=5");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: undefined fields remain undefined
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nundefined fields:");

const partialParams: SamplingParams = { temperature: 0.10 };
const resultPartial = applySamplingBackoff(partialParams, 1);
assertApproxEqual(resultPartial.temperature!, 0.09, 0.0001, "temperature reduced");
assertEqual(resultPartial.topP, undefined, "topP remains undefined");
assertEqual(resultPartial.topK, undefined, "topK remains undefined");

const emptyParams: SamplingParams = {};
const resultEmpty = applySamplingBackoff(emptyParams, 2);
assertEqual(resultEmpty.temperature, undefined, "temperature remains undefined");
assertEqual(resultEmpty.topP, undefined, "topP remains undefined");
assertEqual(resultEmpty.topK, undefined, "topK remains undefined");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: custom limits
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\ncustom limits:");

const customLimits: Partial<SamplingBackoffLimits> = { minTemp: 0.05, minTopP: 0.50, minTopK: 10 };
const resultCustom = applySamplingBackoff(lowBaseParams, 3, customLimits);
// With custom limits: minTemp=0.05, minTopP=0.50, minTopK=10
// temp: 0.05 * 0.729 = 0.03645 → clamp to 0.05
// topP: 0.20 * 0.729 = 0.1458 → clamp to 0.50
// topK: round(8 * 0.729) = 6 → clamp to 10
assertEqual(resultCustom.temperature, 0.05, "temperature clamped to custom minTemp=0.05");
assertEqual(resultCustom.topP, 0.50, "topP clamped to custom minTopP=0.50");
assertEqual(resultCustom.topK, 10, "topK clamped to custom minTopK=10");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: negative attempt index treated as 0
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nnegative attempt index:");

const resultNeg = applySamplingBackoff(baseParams, -1);
assertEqual(resultNeg.temperature, 0.10, "negative attempt returns unchanged temperature");
assertEqual(resultNeg.topP, 0.90, "negative attempt returns unchanged topP");
assertEqual(resultNeg.topK, 30, "negative attempt returns unchanged topK");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: formatSamplingParams
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nformatSamplingParams:");

const formatted1 = formatSamplingParams({ temperature: 0.123, topP: 0.85, topK: 30 });
assert(formatted1.includes("temp=0.123"), "formats temperature with 3 decimal places");
assert(formatted1.includes("topP=0.85"), "formats topP with 2 decimal places");
assert(formatted1.includes("topK=30"), "formats topK as integer");

const formatted2 = formatSamplingParams({ temperature: 0.1 });
assert(formatted2.includes("temp="), "partial params formats temperature");
assert(!formatted2.includes("topP="), "partial params omits undefined topP");
assert(!formatted2.includes("topK="), "partial params omits undefined topK");

const formatted3 = formatSamplingParams({});
assertEqual(formatted3, "(no sampling params)", "empty params returns placeholder");

// ═══════════════════════════════════════════════════════════════════════════════
// Integration test: simulated retry sequence
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nintegration: simulated retry sequence:");

// Simulate the baseline from NZ_REAL_ESTATE_PRESETS.stage2Interior
const nzInteriorBaseline: SamplingParams = { temperature: 0.10, topP: 0.90, topK: 30 };

// Simulate retry sequence like stage2.ts does
const attemptResults: { attempt: number; params: SamplingParams }[] = [];

for (let attempt = 0; attempt < 4; attempt++) {
  const params = applySamplingBackoff(nzInteriorBaseline, attempt);
  attemptResults.push({ attempt, params });
}

// Verify each attempt uses progressively lower values
assert(attemptResults[0].params.temperature === 0.10, "attempt 0: uses baseline temperature");
assert(attemptResults[1].params.temperature! < attemptResults[0].params.temperature!, "attempt 1: lower temp than 0");
assert(attemptResults[2].params.temperature! < attemptResults[1].params.temperature!, "attempt 2: lower temp than 1");
assert(attemptResults[3].params.temperature! < attemptResults[2].params.temperature!, "attempt 3: lower temp than 2");

// Verify the baseline is NEVER mutated during the sequence
assertEqual(nzInteriorBaseline.temperature, 0.10, "baseline temperature not mutated after sequence");
assertEqual(nzInteriorBaseline.topP, 0.90, "baseline topP not mutated after sequence");
assertEqual(nzInteriorBaseline.topK, 30, "baseline topK not mutated after sequence");

console.log("\nRetry sequence preview:");
for (const r of attemptResults) {
  console.log(`  Attempt ${r.attempt}: ${formatSamplingParams(r.params)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n=== Test Results ===");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
