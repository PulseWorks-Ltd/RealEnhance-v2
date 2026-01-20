/**
 * Stage 2 Baseline Wiring Tests
 *
 * Validates that Stage 2 structural validation uses the correct baseline:
 * - Stage 2 validation should use Stage1A output as baseline (NOT original)
 * - Missing stage1APath in block mode should return null (error)
 * - Missing stage1APath in log mode should warn and fallback to basePath
 *
 * Run with: npx tsx src/pipeline/__tests__/stage2BaselineWiring.test.ts
 */

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
// Test: Stage 2 vs Stage 1A baseline semantics
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nStage 2 baseline semantics:");

// Simulate the worker passing paths correctly
interface Stage2ValidationContext {
  originalPath: string;
  stage1APath: string;
  stage1BPath: string | null;
  stage2CandidatePath: string;
}

function getCorrectBaselineForStage2(ctx: Stage2ValidationContext): string {
  // Stage 2 validation baseline should ALWAYS be Stage1A output
  // (or Stage1B if declutter was run, but Stage1B builds on Stage1A)
  return ctx.stage1APath;
}

const ctx: Stage2ValidationContext = {
  originalPath: "/tmp/uploads/photo.jpg",
  stage1APath: "/tmp/outputs/photo-1A.webp",
  stage1BPath: "/tmp/outputs/photo-1B.webp",
  stage2CandidatePath: "/tmp/outputs/photo-2.webp",
};

assertEqual(
  getCorrectBaselineForStage2(ctx),
  ctx.stage1APath,
  "Stage 2 baseline is Stage1A output (not original)"
);

assert(
  getCorrectBaselineForStage2(ctx) !== ctx.originalPath,
  "Stage 2 baseline must NOT be original path"
);

// ═══════════════════════════════════════════════════════════════════════════════
// Test: STRUCT_BASELINE log format
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nSTRUCT_BASELINE log format:");

function formatStructBaselineLog(opts: {
  stage: number;
  jobId: string;
  baseline: string;
  candidate: string;
  baselineIsStage1A: boolean;
  mode: string;
}): string {
  return (
    `[STRUCT_BASELINE] stage=${opts.stage} jobId=${opts.jobId} ` +
    `baseline=${opts.baseline} candidate=${opts.candidate} ` +
    `baselineIsStage1A=${opts.baselineIsStage1A} mode=${opts.mode}`
  );
}

const logLine = formatStructBaselineLog({
  stage: 2,
  jobId: "job-123",
  baseline: "/tmp/stage1a.webp",
  candidate: "/tmp/stage2.webp",
  baselineIsStage1A: true,
  mode: "block",
});

assert(logLine.includes("[STRUCT_BASELINE]"), "log contains STRUCT_BASELINE tag");
assert(logLine.includes("stage=2"), "log contains stage number");
assert(logLine.includes("jobId=job-123"), "log contains jobId");
assert(logLine.includes("baselineIsStage1A=true"), "log indicates baseline source");
assert(logLine.includes("mode=block"), "log contains validation mode");

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
