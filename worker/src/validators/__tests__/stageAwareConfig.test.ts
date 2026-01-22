/**
 * Stage-Aware Config Unit Tests
 *
 * Tests env parsing helpers and configuration loading.
 * Run with: npx tsx src/validators/__tests__/stageAwareConfig.test.ts
 */

import {
  parseEnvFloat01,
  parseEnvBool,
  parseEnvInt,
  parseEnvFloat,
  loadStage1AThresholds,
  loadStage1BThresholds,
  loadStage1BHardFailSwitches,
  loadStage2Thresholds,
  loadHardFailSwitches,
  loadStageAwareConfig,
} from "../stageAwareConfig";

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
  assert(actual === expected, `${testName} (expected ${expected}, got ${actual})`);
}

// Store original env vars
const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
}

console.log("\n=== stageAwareConfig Tests ===\n");

// ═══════════════════════════════════════════════════════════════════════════════
// parseEnvFloat01 tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("parseEnvFloat01:");

resetEnv();
delete process.env.TEST_VAR;
assertEqual(parseEnvFloat01("TEST_VAR", 0.5), 0.5, "returns default when undefined");

resetEnv();
process.env.TEST_VAR = "";
assertEqual(parseEnvFloat01("TEST_VAR", 0.5), 0.5, "returns default when empty");

resetEnv();
process.env.TEST_VAR = "0.75";
assertEqual(parseEnvFloat01("TEST_VAR", 0.5), 0.75, "parses valid float");

resetEnv();
process.env.TEST_VAR = "0";
assertEqual(parseEnvFloat01("TEST_VAR", 0.5), 0, "parses 0");

resetEnv();
process.env.TEST_VAR = "1";
assertEqual(parseEnvFloat01("TEST_VAR", 0.5), 1, "parses 1");

resetEnv();
process.env.TEST_VAR = "1.5";
assertEqual(parseEnvFloat01("TEST_VAR", 0.5), 1, "clamps values above 1");

resetEnv();
process.env.TEST_VAR = "-0.5";
assertEqual(parseEnvFloat01("TEST_VAR", 0.5), 0, "clamps negative values");

resetEnv();
process.env.TEST_VAR = "not-a-number";
assertEqual(parseEnvFloat01("TEST_VAR", 0.5), 0.5, "returns default for invalid float");

// ═══════════════════════════════════════════════════════════════════════════════
// parseEnvBool tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nparseEnvBool:");

resetEnv();
delete process.env.TEST_BOOL;
assertEqual(parseEnvBool("TEST_BOOL", false), false, "returns default false when undefined");
assertEqual(parseEnvBool("TEST_BOOL", true), true, "returns default true when undefined");

resetEnv();
process.env.TEST_BOOL = "";
assertEqual(parseEnvBool("TEST_BOOL", true), true, "returns default when empty");

resetEnv();
process.env.TEST_BOOL = "1";
assertEqual(parseEnvBool("TEST_BOOL", false), true, "returns true for '1'");

resetEnv();
process.env.TEST_BOOL = "true";
assertEqual(parseEnvBool("TEST_BOOL", false), true, "returns true for 'true'");

resetEnv();
process.env.TEST_BOOL = "TRUE";
assertEqual(parseEnvBool("TEST_BOOL", false), true, "returns true for 'TRUE'");

resetEnv();
process.env.TEST_BOOL = "0";
assertEqual(parseEnvBool("TEST_BOOL", true), false, "returns false for '0'");

resetEnv();
process.env.TEST_BOOL = "false";
assertEqual(parseEnvBool("TEST_BOOL", true), false, "returns false for 'false'");

// ═══════════════════════════════════════════════════════════════════════════════
// parseEnvInt tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nparseEnvInt:");

resetEnv();
delete process.env.TEST_INT;
assertEqual(parseEnvInt("TEST_INT", 3), 3, "returns default when undefined");

resetEnv();
process.env.TEST_INT = "5";
assertEqual(parseEnvInt("TEST_INT", 3), 5, "parses valid integer");

resetEnv();
process.env.TEST_INT = "-10";
assertEqual(parseEnvInt("TEST_INT", 0), -10, "parses negative integer");

resetEnv();
process.env.TEST_INT = "5.7";
assertEqual(parseEnvInt("TEST_INT", 0), 5, "truncates float to integer");

resetEnv();
process.env.TEST_INT = "abc";
assertEqual(parseEnvInt("TEST_INT", 3), 3, "returns default for invalid input");

// ═══════════════════════════════════════════════════════════════════════════════
// loadStage1AThresholds tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nloadStage1AThresholds:");

resetEnv();
delete process.env.STRUCT_VALIDATION_STAGE1A_EDGE_IOU_MIN;
delete process.env.STRUCT_VALIDATION_STAGE1A_STRUCT_IOU_MIN;

let stage1AThresholds = loadStage1AThresholds();
assertEqual(stage1AThresholds.edgeIouMin, 0.60, "defaults edgeIouMin to 0.60");
assertEqual(stage1AThresholds.structIouMin, 0.30, "defaults structIouMin to 0.30");

resetEnv();
process.env.STRUCT_VALIDATION_STAGE1A_EDGE_IOU_MIN = "0.55";
process.env.STRUCT_VALIDATION_STAGE1A_STRUCT_IOU_MIN = "0.25";
stage1AThresholds = loadStage1AThresholds();
assertEqual(stage1AThresholds.edgeIouMin, 0.55, "uses custom edgeIouMin");
assertEqual(stage1AThresholds.structIouMin, 0.25, "uses custom structIouMin");

resetEnv();
process.env.STRUCT_VALIDATION_STAGE1A_EDGE_IOU_MIN = "1.5";
stage1AThresholds = loadStage1AThresholds();
assertEqual(stage1AThresholds.edgeIouMin, 1, "clamps edgeIouMin above 1");

resetEnv();
process.env.STRUCT_VALIDATION_STAGE1A_STRUCT_IOU_MIN = "-0.1";
stage1AThresholds = loadStage1AThresholds();
assertEqual(stage1AThresholds.structIouMin, 0, "clamps structIouMin below 0");

// ═══════════════════════════════════════════════════════════════════════════════
// loadStage1BThresholds tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nloadStage1BThresholds:");

resetEnv();
delete process.env.STRUCT_VALIDATION_STAGE1B_EDGE_IOU_MIN;
delete process.env.STRUCT_VALIDATION_STAGE1B_STRUCT_IOU_MIN;
delete process.env.STRUCT_VALIDATION_STAGE1B_LINEEDGE_MIN;
delete process.env.STRUCT_VALIDATION_STAGE1B_UNIFIED_MIN;
delete process.env.STRUCT_VALIDATION_STAGE1B_EDGE_MODE;
delete process.env.STRUCT_VALIDATION_STAGE1B_EXCLUDE_LOWER_PCT;

let stage1BThresholds = loadStage1BThresholds();
assertEqual(stage1BThresholds.edgeIouMin, 0.50, "defaults edgeIouMin to 0.50");
assertEqual(stage1BThresholds.structIouMin, 0.40, "defaults structIouMin to 0.40");
assertEqual(stage1BThresholds.lineEdgeMin, 0.60, "defaults lineEdgeMin to 0.60");
assertEqual(stage1BThresholds.unifiedMin, 0.55, "defaults unifiedMin to 0.55");
assertEqual(stage1BThresholds.edgeMode, "structure_only", "defaults edgeMode to structure_only");
assertEqual(stage1BThresholds.excludeLowerPct, 0.20, "defaults excludeLowerPct to 0.20");

resetEnv();
process.env.STRUCT_VALIDATION_STAGE1B_EDGE_IOU_MIN = "0.45";
process.env.STRUCT_VALIDATION_STAGE1B_STRUCT_IOU_MIN = "0.35";
process.env.STRUCT_VALIDATION_STAGE1B_LINEEDGE_MIN = "0.55";
process.env.STRUCT_VALIDATION_STAGE1B_UNIFIED_MIN = "0.50";
process.env.STRUCT_VALIDATION_STAGE1B_EDGE_MODE = "exclude_lower";
process.env.STRUCT_VALIDATION_STAGE1B_EXCLUDE_LOWER_PCT = "0.30";
stage1BThresholds = loadStage1BThresholds();
assertEqual(stage1BThresholds.edgeIouMin, 0.45, "uses custom edgeIouMin");
assertEqual(stage1BThresholds.structIouMin, 0.35, "uses custom structIouMin");
assertEqual(stage1BThresholds.lineEdgeMin, 0.55, "uses custom lineEdgeMin");
assertEqual(stage1BThresholds.unifiedMin, 0.50, "uses custom unifiedMin");
assertEqual(stage1BThresholds.edgeMode, "exclude_lower", "uses custom edgeMode");
assertEqual(stage1BThresholds.excludeLowerPct, 0.30, "uses custom excludeLowerPct");

// ═══════════════════════════════════════════════════════════════════════════════
// loadStage1BHardFailSwitches tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nloadStage1BHardFailSwitches:");

resetEnv();
delete process.env.STRUCT_VALIDATION_STAGE1B_BLOCK_ON_WINDOW_COUNT_CHANGE;
delete process.env.STRUCT_VALIDATION_STAGE1B_BLOCK_ON_WINDOW_POSITION_CHANGE;
delete process.env.STRUCT_VALIDATION_STAGE1B_BLOCK_ON_OPENINGS_DELTA;

let stage1BSwitches = loadStage1BHardFailSwitches();
assertEqual(stage1BSwitches.blockOnWindowCountChange, true, "defaults blockOnWindowCountChange to true (ON for 1B)");
assertEqual(stage1BSwitches.blockOnWindowPositionChange, false, "defaults blockOnWindowPositionChange to false");
assertEqual(stage1BSwitches.blockOnOpeningsDelta, false, "defaults blockOnOpeningsDelta to false");

resetEnv();
process.env.STRUCT_VALIDATION_STAGE1B_BLOCK_ON_WINDOW_COUNT_CHANGE = "0";
process.env.STRUCT_VALIDATION_STAGE1B_BLOCK_ON_WINDOW_POSITION_CHANGE = "1";
process.env.STRUCT_VALIDATION_STAGE1B_BLOCK_ON_OPENINGS_DELTA = "1";
stage1BSwitches = loadStage1BHardFailSwitches();
assertEqual(stage1BSwitches.blockOnWindowCountChange, false, "disables blockOnWindowCountChange with '0'");
assertEqual(stage1BSwitches.blockOnWindowPositionChange, true, "enables blockOnWindowPositionChange with '1'");
assertEqual(stage1BSwitches.blockOnOpeningsDelta, true, "enables blockOnOpeningsDelta with '1'");

// ═══════════════════════════════════════════════════════════════════════════════
// loadStage2Thresholds tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nloadStage2Thresholds:");

resetEnv();
delete process.env.STRUCT_VALIDATION_STAGE2_EDGE_IOU_MIN;
delete process.env.STRUCT_VALIDATION_STAGE2_STRUCT_IOU_MIN;
delete process.env.STRUCT_VALIDATION_STAGE2_LINEEDGE_MIN;
delete process.env.STRUCT_VALIDATION_STAGE2_UNIFIED_MIN;

let thresholds = loadStage2Thresholds();
assertEqual(thresholds.edgeIouMin, 0.60, "defaults edgeIouMin to 0.60");
assertEqual(thresholds.structIouMin, 0.55, "defaults structIouMin to 0.55");
assertEqual(thresholds.lineEdgeMin, 0.70, "defaults lineEdgeMin to 0.70");
assertEqual(thresholds.unifiedMin, 0.65, "defaults unifiedMin to 0.65");

resetEnv();
process.env.STRUCT_VALIDATION_STAGE2_EDGE_IOU_MIN = "0.45";
process.env.STRUCT_VALIDATION_STAGE2_STRUCT_IOU_MIN = "0.40";
thresholds = loadStage2Thresholds();
assertEqual(thresholds.edgeIouMin, 0.45, "uses custom edgeIouMin");
assertEqual(thresholds.structIouMin, 0.40, "uses custom structIouMin");

// ═══════════════════════════════════════════════════════════════════════════════
// loadHardFailSwitches tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nloadHardFailSwitches:");

resetEnv();
delete process.env.STRUCT_VALIDATION_BLOCK_ON_WINDOW_COUNT_CHANGE;
delete process.env.STRUCT_VALIDATION_BLOCK_ON_WINDOW_POSITION_CHANGE;
delete process.env.STRUCT_VALIDATION_BLOCK_ON_OPENINGS_DELTA;

let switches = loadHardFailSwitches();
assertEqual(switches.blockOnWindowCountChange, false, "defaults blockOnWindowCountChange to false");
assertEqual(switches.blockOnWindowPositionChange, false, "defaults blockOnWindowPositionChange to false");
assertEqual(switches.blockOnOpeningsDelta, false, "defaults blockOnOpeningsDelta to false");

resetEnv();
process.env.STRUCT_VALIDATION_BLOCK_ON_WINDOW_COUNT_CHANGE = "1";
process.env.STRUCT_VALIDATION_BLOCK_ON_WINDOW_POSITION_CHANGE = "true";
process.env.STRUCT_VALIDATION_BLOCK_ON_OPENINGS_DELTA = "1";
switches = loadHardFailSwitches();
assertEqual(switches.blockOnWindowCountChange, true, "enables blockOnWindowCountChange with '1'");
assertEqual(switches.blockOnWindowPositionChange, true, "enables blockOnWindowPositionChange with 'true'");
assertEqual(switches.blockOnOpeningsDelta, true, "enables blockOnOpeningsDelta with '1'");

// ═══════════════════════════════════════════════════════════════════════════════
// loadStageAwareConfig tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nloadStageAwareConfig:");

resetEnv();
const config = loadStageAwareConfig();
assert(config.enabled !== undefined, "has enabled field");
assert(config.stage2EdgeMode !== undefined, "has stage2EdgeMode field");
assert(config.gateMinSignals !== undefined, "has gateMinSignals field");
assert(config.stage1AThresholds !== undefined, "has stage1AThresholds field");
assert(config.stage1AThresholds.edgeIouMin !== undefined, "has stage1A nested edgeIouMin");
assert(config.stage1AThresholds.structIouMin !== undefined, "has stage1A nested structIouMin");
assert(config.stage1BThresholds !== undefined, "has stage1BThresholds field");
assert(config.stage1BThresholds.edgeIouMin !== undefined, "has stage1B nested edgeIouMin");
assert(config.stage1BThresholds.structIouMin !== undefined, "has stage1B nested structIouMin");
assert(config.stage1BThresholds.lineEdgeMin !== undefined, "has stage1B nested lineEdgeMin");
assert(config.stage1BThresholds.unifiedMin !== undefined, "has stage1B nested unifiedMin");
assert(config.stage1BThresholds.edgeMode !== undefined, "has stage1B nested edgeMode");
assert(config.stage1BHardFailSwitches !== undefined, "has stage1BHardFailSwitches field");
assert(config.stage1BHardFailSwitches.blockOnWindowCountChange !== undefined, "has stage1B nested blockOnWindowCountChange");
assert(config.stage2Thresholds !== undefined, "has stage2Thresholds field");
assert(config.stage2Thresholds.edgeIouMin !== undefined, "has stage2 nested edgeIouMin");
assert(config.hardFailSwitches !== undefined, "has hardFailSwitches field");
assert(config.hardFailSwitches.blockOnWindowCountChange !== undefined, "has nested blockOnWindowCountChange");
assert(config.dimAspectRatioTolerance !== undefined, "has dimAspectRatioTolerance field");
assert(config.dimLargeDeltaPct !== undefined, "has dimLargeDeltaPct field");
assert(config.dimSmallDeltaPct !== undefined, "has dimSmallDeltaPct field");
assert(config.dimStrideMultiple !== undefined, "has dimStrideMultiple field");

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
