/**
 * Stage 2 Baseline Wiring Tests
 *
 * Validates that Stage 2 structural validation uses the correct baseline:
 * - Stage 2 should use Stage1B output as baseline when declutter ran (NOT Stage1A)
 * - Stage 2 should use Stage1A output as baseline when declutter didn't run
 * - Missing stage1APath in block mode should return null (error)
 * - Missing stage1APath in log mode should warn and fallback to basePath
 *
 * Run with: npx tsx src/pipeline/__tests__/stage2BaselineWiring.test.ts
 */

import { chooseStage2Baseline } from "../../validators/stageAwareConfig";

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
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${testName} (expected ${expected}, got ${actual})`);
  } else {
    failed++;
    console.log(`  ✗ ${testName} (expected ${expected}, got ${actual})`);
  }
}

// Reset env before each test group
function resetEnv() {
  delete process.env.STRUCT_VALIDATION_STAGE_AWARE;
  delete process.env.STRUCTURE_VALIDATOR_MODE;
}

console.log("=== Stage 2 Baseline Wiring Tests ===\n");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: resolveValidationBaseline logic
// ═══════════════════════════════════════════════════════════════════════════════
console.log("resolveValidationBaseline:");

/**
 * Simulates the baseline resolution logic from stage2.ts
 * This is extracted to test the logic in isolation
 */
function resolveValidationBaseline(opts: {
  stage1APath?: string;
  basePath: string;
  stageAwareEnabled: boolean;
  validationMode: "log" | "block";
}): { baseline: string; error: string | null; warning: string | null } {
  const { stage1APath, basePath, stageAwareEnabled, validationMode } = opts;

  // If stage1APath provided, use it
  if (stage1APath) {
    return { baseline: stage1APath, error: null, warning: null };
  }

  // No stage1APath provided
  if (stageAwareEnabled) {
    if (validationMode === "block") {
      return {
        baseline: basePath,
        error: "No stage1APath provided for Stage2 validation in block mode",
        warning: null,
      };
    } else {
      return {
        baseline: basePath,
        error: null,
        warning: "No stage1APath provided - using basePath as validation baseline",
      };
    }
  }

  // Stage-aware disabled, just use basePath
  return { baseline: basePath, error: null, warning: null };
}

// Test 1: stage1APath provided - should use it
resetEnv();
let result = resolveValidationBaseline({
  stage1APath: "/tmp/stage1a-output.webp",
  basePath: "/tmp/original.jpg",
  stageAwareEnabled: true,
  validationMode: "block",
});
assertEqual(result.baseline, "/tmp/stage1a-output.webp", "uses stage1APath when provided");
assertEqual(result.error, null, "no error when stage1APath provided");
assertEqual(result.warning, null, "no warning when stage1APath provided");

// Test 2: stage1APath missing in block mode - should error
result = resolveValidationBaseline({
  stage1APath: undefined,
  basePath: "/tmp/original.jpg",
  stageAwareEnabled: true,
  validationMode: "block",
});
assertEqual(result.baseline, "/tmp/original.jpg", "falls back to basePath when stage1APath missing");
assert(result.error !== null, "returns error when stage1APath missing in block mode");
assertEqual(result.warning, null, "no warning in block mode (error instead)");

// Test 3: stage1APath missing in log mode - should warn but continue
result = resolveValidationBaseline({
  stage1APath: undefined,
  basePath: "/tmp/original.jpg",
  stageAwareEnabled: true,
  validationMode: "log",
});
assertEqual(result.baseline, "/tmp/original.jpg", "falls back to basePath in log mode");
assertEqual(result.error, null, "no error in log mode");
assert(result.warning !== null, "returns warning when stage1APath missing in log mode");

// Test 4: stage-aware disabled - no warning/error regardless of stage1APath
result = resolveValidationBaseline({
  stage1APath: undefined,
  basePath: "/tmp/original.jpg",
  stageAwareEnabled: false,
  validationMode: "block",
});
assertEqual(result.baseline, "/tmp/original.jpg", "uses basePath when stage-aware disabled");
assertEqual(result.error, null, "no error when stage-aware disabled");
assertEqual(result.warning, null, "no warning when stage-aware disabled");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Stage 1B baseline semantics (declutter compares vs Stage1A, NOT original)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nStage 1B baseline semantics:");

interface Stage1BValidationContext {
  originalPath: string;
  stage1APath: string;
  stage1BCandidatePath: string;
}

function getCorrectBaselineForStage1B(ctx: Stage1BValidationContext): string {
  // Stage 1B validation baseline should ALWAYS be Stage1A output
  // Comparing 1B vs original would inflate diffs since 1A already changed lighting/contrast
  return ctx.stage1APath;
}

const ctx1B: Stage1BValidationContext = {
  originalPath: "/tmp/uploads/photo.jpg",
  stage1APath: "/tmp/outputs/photo-1A.webp",
  stage1BCandidatePath: "/tmp/outputs/photo-1B.webp",
};

assertEqual(
  getCorrectBaselineForStage1B(ctx1B),
  ctx1B.stage1APath,
  "Stage 1B baseline is Stage1A output (not original)"
);

assert(
  getCorrectBaselineForStage1B(ctx1B) !== ctx1B.originalPath,
  "Stage 1B baseline must NOT be original path"
);

// ═══════════════════════════════════════════════════════════════════════════════
// Test: chooseStage2Baseline helper function
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nchooseStage2Baseline helper:");

// Test 1: Stage1B provided and different from Stage1A - should use Stage1B
let baselineChoice = chooseStage2Baseline({
  stage1APath: "/tmp/outputs/photo-1A.webp",
  stage1BPath: "/tmp/outputs/photo-1B.webp",
});
assertEqual(baselineChoice.baselinePath, "/tmp/outputs/photo-1B.webp", "uses Stage1B when provided and different from 1A");
assertEqual(baselineChoice.baselineStage, "1B", "reports baselineStage as 1B");

// Test 2: Stage1B not provided - should use Stage1A
baselineChoice = chooseStage2Baseline({
  stage1APath: "/tmp/outputs/photo-1A.webp",
  stage1BPath: undefined,
});
assertEqual(baselineChoice.baselinePath, "/tmp/outputs/photo-1A.webp", "uses Stage1A when Stage1B not provided");
assertEqual(baselineChoice.baselineStage, "1A", "reports baselineStage as 1A");

// Test 3: Stage1B is null - should use Stage1A
baselineChoice = chooseStage2Baseline({
  stage1APath: "/tmp/outputs/photo-1A.webp",
  stage1BPath: null,
});
assertEqual(baselineChoice.baselinePath, "/tmp/outputs/photo-1A.webp", "uses Stage1A when Stage1B is null");
assertEqual(baselineChoice.baselineStage, "1A", "reports baselineStage as 1A when 1B null");

// Test 4: Stage1B same as Stage1A (edge case) - should use Stage1A
baselineChoice = chooseStage2Baseline({
  stage1APath: "/tmp/outputs/photo-1A.webp",
  stage1BPath: "/tmp/outputs/photo-1A.webp", // Same path
});
assertEqual(baselineChoice.baselinePath, "/tmp/outputs/photo-1A.webp", "uses Stage1A when Stage1B is same path");
assertEqual(baselineChoice.baselineStage, "1A", "reports baselineStage as 1A when paths match");

// Test 5: Empty string Stage1B - should use Stage1A
baselineChoice = chooseStage2Baseline({
  stage1APath: "/tmp/outputs/photo-1A.webp",
  stage1BPath: "",
});
assertEqual(baselineChoice.baselinePath, "/tmp/outputs/photo-1A.webp", "uses Stage1A when Stage1B is empty string");
assertEqual(baselineChoice.baselineStage, "1A", "reports baselineStage as 1A when 1B empty");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Stage 2 baseline semantics (integration test)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nStage 2 baseline semantics (integration):");

// Simulate the worker passing paths correctly
interface Stage2ValidationContext {
  originalPath: string;
  stage1APath: string;
  stage1BPath: string | null;
  stage2CandidatePath: string;
}

function getCorrectBaselineForStage2(ctx: Stage2ValidationContext): { path: string; stage: "1A" | "1B" } {
  // Use the actual helper function to determine baseline
  const choice = chooseStage2Baseline({
    stage1APath: ctx.stage1APath,
    stage1BPath: ctx.stage1BPath,
  });
  return { path: choice.baselinePath, stage: choice.baselineStage };
}

// Test: Declutter ran - should use Stage1B
let ctx: Stage2ValidationContext = {
  originalPath: "/tmp/uploads/photo.jpg",
  stage1APath: "/tmp/outputs/photo-1A.webp",
  stage1BPath: "/tmp/outputs/photo-1B.webp",
  stage2CandidatePath: "/tmp/outputs/photo-2.webp",
};

let baseline = getCorrectBaselineForStage2(ctx);
assertEqual(
  baseline.path,
  ctx.stage1BPath!,
  "Stage 2 baseline is Stage1B output when declutter ran"
);
assertEqual(
  baseline.stage,
  "1B",
  "Stage 2 reports baselineStage=1B when declutter ran"
);

assert(
  baseline.path !== ctx.originalPath,
  "Stage 2 baseline must NOT be original path"
);

assert(
  baseline.path !== ctx.stage1APath,
  "Stage 2 baseline should be Stage1B (not Stage1A) when declutter ran"
);

// Test: Declutter did NOT run - should use Stage1A
ctx = {
  originalPath: "/tmp/uploads/photo.jpg",
  stage1APath: "/tmp/outputs/photo-1A.webp",
  stage1BPath: null,
  stage2CandidatePath: "/tmp/outputs/photo-2.webp",
};

baseline = getCorrectBaselineForStage2(ctx);
assertEqual(
  baseline.path,
  ctx.stage1APath,
  "Stage 2 baseline is Stage1A output when declutter didn't run"
);
assertEqual(
  baseline.stage,
  "1A",
  "Stage 2 reports baselineStage=1A when declutter didn't run"
);

assert(
  baseline.path !== ctx.originalPath,
  "Stage 2 baseline must NOT be original path (no declutter case)"
);

// ═══════════════════════════════════════════════════════════════════════════════
// Test: STRUCT_BASELINE log format (updated to use baselineStage)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nSTRUCT_BASELINE log format:");

function formatStructBaselineLog(opts: {
  stage: number;
  jobId: string;
  baseline: string;
  candidate: string;
  baselineStage: "1A" | "1B" | "unknown";
  mode: string;
}): string {
  return (
    `[STRUCT_BASELINE] stage=${opts.stage} jobId=${opts.jobId} ` +
    `baseline=${opts.baseline} candidate=${opts.candidate} ` +
    `baselineStage=${opts.baselineStage} mode=${opts.mode}`
  );
}

// Test log format with baselineStage=1A
let logLine = formatStructBaselineLog({
  stage: 2,
  jobId: "job-123",
  baseline: "/tmp/stage1a.webp",
  candidate: "/tmp/stage2.webp",
  baselineStage: "1A",
  mode: "block",
});

assert(logLine.includes("[STRUCT_BASELINE]"), "log contains STRUCT_BASELINE tag");
assert(logLine.includes("stage=2"), "log contains stage number");
assert(logLine.includes("jobId=job-123"), "log contains jobId");
assert(logLine.includes("baselineStage=1A"), "log indicates baseline source as 1A");
assert(logLine.includes("mode=block"), "log contains validation mode");

// Test log format with baselineStage=1B (declutter ran)
logLine = formatStructBaselineLog({
  stage: 2,
  jobId: "job-456",
  baseline: "/tmp/stage1b.webp",
  candidate: "/tmp/stage2.webp",
  baselineStage: "1B",
  mode: "log",
});

assert(logLine.includes("baselineStage=1B"), "log indicates baseline source as 1B when declutter ran");
assert(logLine.includes("mode=log"), "log contains log mode");

// Test log format with baselineStage=unknown (fallback case)
logLine = formatStructBaselineLog({
  stage: 2,
  jobId: "job-789",
  baseline: "/tmp/original.jpg",
  candidate: "/tmp/stage2.webp",
  baselineStage: "unknown",
  mode: "log",
});

assert(logLine.includes("baselineStage=unknown"), "log indicates unknown baseline when fallback used");

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
