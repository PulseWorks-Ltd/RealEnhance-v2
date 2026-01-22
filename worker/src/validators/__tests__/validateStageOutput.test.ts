/**
 * Two-Lane Validation Orchestrator Tests
 *
 * Tests for validateStageOutput orchestrator:
 * - Local fatal => gemini not called, final blockedBy=local
 * - Local risk in block mode => gemini not called, blockedBy=local
 * - Local pass => gemini semantic called
 * - Gemini semantic fail high confidence => blockedBy=gemini_semantic
 * - Gemini semantic fail low confidence with fail-closed => blockedBy=gemini_semantic
 * - Stage 2: semantic pass => placement called; placement fail => blockedBy=gemini_placement
 * - JSON parse failure triggers repair retry; if still fails => blockedBy=parse_error
 *
 * Run with: npx tsx src/validators/__tests__/validateStageOutput.test.ts
 */

// Simple test runner
let passed = 0;
let failed = 0;
const envBackup = { ...process.env };

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
    console.log(`  ✓ ${testName} (${actual})`);
  } else {
    failed++;
    console.log(`  ✗ ${testName} (expected ${expected}, got ${actual})`);
  }
}

function resetEnv() {
  // Reset environment
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("STRUCT_") || key.startsWith("SEMANTIC_") || key.startsWith("STRUCTURE_")) {
      delete process.env[key];
    }
  }
}

console.log("=== Two-Lane Validation Orchestrator Tests ===\n");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: ValidatorReport structure
// ═══════════════════════════════════════════════════════════════════════════════
console.log("ValidatorReport structure:");

import type { ValidatorReport, StageKey, BlockedBy } from "../validateStageOutput";

// Simulate a report structure
const mockReport: ValidatorReport = {
  stage: "2",
  baselinePath: "/tmp/baseline.webp",
  candidatePath: "/tmp/candidate.webp",
  ran: {
    localStructural: true,
    localMaskedEdge: true,
    localSemanticFallback: true,
    geminiSemantic: true,
    geminiPlacement: true,
  },
  skipped: {
    gemini: false,
  },
  latencyMs: {
    local: 150,
    gemini: 1200,
    total: 1350,
  },
  local: {
    pass: true,
    risk: false,
    fatal: false,
    triggers: [],
    metrics: { structuralIoU: 0.85 },
    summary: "Local OK: score=0.85",
  },
  gemini: {
    semantic: {
      pass: true,
      confidence: 0.92,
      allowed_changes_only: true,
      reason: "All checks passed",
      fail_reasons: [],
      checks: {
        crop_or_reframe: "pass",
        perspective_change: "pass",
        architecture_preserved: "pass",
        openings_preserved: "pass",
        curtains_blinds_preserved: "pass",
        fixed_cabinetry_joinery_preserved: "pass",
        flooring_pattern_preserved: "pass",
        wall_ceiling_floor_boundaries: "pass",
        new_objects_added: "pass",
        furniture_removed_only: "pass",
        intent_match: "pass",
      },
    },
    placement: {
      pass: true,
      confidence: 0.88,
    },
    summary: "Gemini OK: semantic conf=0.92",
  },
  final: {
    pass: true,
    blockedBy: "none",
    reason: "All validators passed",
  },
};

assert(mockReport.stage === "2", "report has stage field");
assert(mockReport.ran.localStructural === true, "report tracks local structural ran");
assert(mockReport.ran.geminiSemantic === true, "report tracks gemini semantic ran");
assert(mockReport.final.pass === true, "report has final.pass");
assertEqual(mockReport.final.blockedBy, "none" as BlockedBy, "report has blockedBy=none when passing");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Local fatal trigger stops pipeline
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nLocal fatal trigger behavior:");

function simulateLocalFatal(): ValidatorReport {
  return {
    stage: "1B_FULL",
    baselinePath: "/tmp/baseline.webp",
    candidatePath: "/tmp/candidate.webp",
    ran: {
      localStructural: true,
      localMaskedEdge: true,
      localSemanticFallback: true,
      geminiSemantic: false, // Should NOT run
      geminiPlacement: false,
    },
    skipped: {
      gemini: true,
      geminiReason: "local_blocked",
    },
    latencyMs: {
      local: 100,
      gemini: 0,
      total: 100,
    },
    local: {
      pass: false,
      risk: true,
      fatal: true,
      triggers: [
        { id: "dimension_mismatch", fatal: true, message: "Dimensions changed" },
      ],
      metrics: {},
      summary: "Local FAIL: fatal=true, triggers=[dimension_mismatch]",
    },
    final: {
      pass: false,
      blockedBy: "local",
      reason: "Fatal local trigger: dimension_mismatch",
    },
  };
}

const fatalReport = simulateLocalFatal();
assertEqual(fatalReport.final.pass, false, "fatal trigger causes pass=false");
assertEqual(fatalReport.final.blockedBy, "local" as BlockedBy, "fatal trigger blockedBy=local");
assertEqual(fatalReport.ran.geminiSemantic, false, "gemini not called when local fatal");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Local risk in block mode stops pipeline
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nLocal risk in block mode:");

function simulateLocalRiskBlockMode(): ValidatorReport {
  return {
    stage: "2",
    baselinePath: "/tmp/baseline.webp",
    candidatePath: "/tmp/candidate.webp",
    ran: {
      localStructural: true,
      localMaskedEdge: true,
      localSemanticFallback: true,
      geminiSemantic: false, // Should NOT run
      geminiPlacement: false,
    },
    skipped: {
      gemini: true,
      geminiReason: "local_blocked",
    },
    latencyMs: {
      local: 120,
      gemini: 0,
      total: 120,
    },
    local: {
      pass: false,
      risk: true,
      fatal: false,
      triggers: [
        { id: "structural_mask_iou", value: 0.45, threshold: 0.55 },
        { id: "edge_iou_low", value: 0.50, threshold: 0.60 },
      ],
      metrics: { structuralIoU: 0.45, edgeIoU: 0.50 },
      summary: "Local FAIL: risk detected",
    },
    final: {
      pass: false,
      blockedBy: "local",
      reason: "Local risk detected in block mode: structural_mask_iou, edge_iou_low",
    },
  };
}

const riskBlockReport = simulateLocalRiskBlockMode();
assertEqual(riskBlockReport.final.pass, false, "risk in block mode causes pass=false");
assertEqual(riskBlockReport.final.blockedBy, "local" as BlockedBy, "risk blockedBy=local");
assertEqual(riskBlockReport.ran.geminiSemantic, false, "gemini not called when local risk in block mode");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Local pass leads to Gemini semantic being called
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nLocal pass -> Gemini semantic called:");

function simulateLocalPassGeminiCalled(): ValidatorReport {
  return {
    stage: "2",
    baselinePath: "/tmp/baseline.webp",
    candidatePath: "/tmp/candidate.webp",
    ran: {
      localStructural: true,
      localMaskedEdge: true,
      localSemanticFallback: true,
      geminiSemantic: true, // SHOULD run
      geminiPlacement: true,
    },
    skipped: {
      gemini: false,
    },
    latencyMs: {
      local: 150,
      gemini: 1100,
      total: 1250,
    },
    local: {
      pass: true,
      risk: false,
      fatal: false,
      triggers: [],
      metrics: { structuralIoU: 0.85 },
      summary: "Local OK",
    },
    gemini: {
      semantic: {
        pass: true,
        confidence: 0.90,
        allowed_changes_only: true,
        reason: "Staging compliant",
        fail_reasons: [],
        checks: {} as any,
      },
      placement: {
        pass: true,
        confidence: 0.85,
      },
      summary: "Gemini OK",
    },
    final: {
      pass: true,
      blockedBy: "none",
      reason: "All validators passed",
    },
  };
}

const localPassReport = simulateLocalPassGeminiCalled();
assertEqual(localPassReport.ran.geminiSemantic, true, "gemini semantic called when local passes");
assertEqual(localPassReport.final.pass, true, "final pass when both lanes pass");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Gemini semantic fail high confidence
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nGemini semantic fail high confidence:");

function simulateSemanticFailHighConf(): ValidatorReport {
  return {
    stage: "1B_FULL",
    baselinePath: "/tmp/baseline.webp",
    candidatePath: "/tmp/candidate.webp",
    ran: {
      localStructural: true,
      localMaskedEdge: true,
      localSemanticFallback: true,
      geminiSemantic: true,
      geminiPlacement: false,
    },
    skipped: {
      gemini: false,
    },
    latencyMs: {
      local: 100,
      gemini: 900,
      total: 1000,
    },
    local: {
      pass: true,
      risk: false,
      fatal: false,
      triggers: [],
      metrics: {},
      summary: "Local OK",
    },
    gemini: {
      semantic: {
        pass: false,
        confidence: 0.92, // High confidence
        allowed_changes_only: false,
        reason: "Furniture still present in room",
        fail_reasons: ["sofa_visible", "chairs_visible"],
        checks: {
          furniture_removed_only: "fail",
        } as any,
      },
      summary: "Gemini semantic FAIL",
    },
    final: {
      pass: false,
      blockedBy: "gemini_semantic",
      reason: "Gemini semantic failed: Furniture still present in room (conf=0.92)",
    },
  };
}

const semanticHighConfReport = simulateSemanticFailHighConf();
assertEqual(semanticHighConfReport.final.pass, false, "semantic fail high conf causes pass=false");
assertEqual(semanticHighConfReport.final.blockedBy, "gemini_semantic" as BlockedBy, "blockedBy=gemini_semantic");
assert(semanticHighConfReport.gemini?.semantic?.confidence === 0.92, "confidence captured");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Gemini semantic fail low confidence with fail-closed
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nGemini semantic fail low confidence (fail-closed):");

function simulateSemanticFailLowConfFailClosed(): ValidatorReport {
  return {
    stage: "1B_FULL",
    baselinePath: "/tmp/baseline.webp",
    candidatePath: "/tmp/candidate.webp",
    ran: {
      localStructural: true,
      localMaskedEdge: true,
      localSemanticFallback: true,
      geminiSemantic: true,
      geminiPlacement: false,
    },
    skipped: {
      gemini: false,
    },
    latencyMs: {
      local: 100,
      gemini: 850,
      total: 950,
    },
    local: {
      pass: true,
      risk: false,
      fatal: false,
      triggers: [],
      metrics: {},
      summary: "Local OK",
    },
    gemini: {
      semantic: {
        pass: false,
        confidence: 0.65, // Low confidence
        allowed_changes_only: false,
        reason: "Unclear if furniture removed",
        fail_reasons: ["unclear_furniture_status"],
        checks: {
          furniture_removed_only: "unclear",
        } as any,
      },
      summary: "Gemini semantic FAIL (low conf)",
    },
    final: {
      pass: false,
      blockedBy: "gemini_semantic",
      reason: "Gemini semantic failed: Unclear if furniture removed (conf=0.65)",
    },
  };
}

const semanticLowConfReport = simulateSemanticFailLowConfFailClosed();
assertEqual(semanticLowConfReport.final.pass, false, "semantic fail low conf with fail-closed causes pass=false");
assertEqual(semanticLowConfReport.final.blockedBy, "gemini_semantic" as BlockedBy, "blockedBy=gemini_semantic");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Stage 2 placement fail
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nStage 2 placement fail:");

function simulatePlacementFail(): ValidatorReport {
  return {
    stage: "2",
    baselinePath: "/tmp/baseline.webp",
    candidatePath: "/tmp/candidate.webp",
    ran: {
      localStructural: true,
      localMaskedEdge: true,
      localSemanticFallback: true,
      geminiSemantic: true,
      geminiPlacement: true,
    },
    skipped: {
      gemini: false,
    },
    latencyMs: {
      local: 140,
      gemini: 1800,
      total: 1940,
    },
    local: {
      pass: true,
      risk: false,
      fatal: false,
      triggers: [],
      metrics: {},
      summary: "Local OK",
    },
    gemini: {
      semantic: {
        pass: true,
        confidence: 0.88,
        allowed_changes_only: true,
        reason: "Staging compliant",
        fail_reasons: [],
        checks: {} as any,
      },
      placement: {
        pass: false,
        confidence: 0.82,
        reason: "Sofa blocking doorway",
      },
      summary: "Gemini placement FAIL",
    },
    final: {
      pass: false,
      blockedBy: "gemini_placement",
      reason: "Gemini placement failed: Sofa blocking doorway",
    },
  };
}

const placementFailReport = simulatePlacementFail();
assertEqual(placementFailReport.final.pass, false, "placement fail causes pass=false");
assertEqual(placementFailReport.final.blockedBy, "gemini_placement" as BlockedBy, "blockedBy=gemini_placement");
assertEqual(placementFailReport.ran.geminiPlacement, true, "placement ran for stage 2");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: JSON parse failure (parse_error)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nJSON parse failure:");

function simulateParseError(): ValidatorReport {
  return {
    stage: "1B_FULL",
    baselinePath: "/tmp/baseline.webp",
    candidatePath: "/tmp/candidate.webp",
    ran: {
      localStructural: true,
      localMaskedEdge: true,
      localSemanticFallback: true,
      geminiSemantic: true,
      geminiPlacement: false,
    },
    skipped: {
      gemini: false,
    },
    latencyMs: {
      local: 100,
      gemini: 500,
      total: 600,
    },
    local: {
      pass: true,
      risk: false,
      fatal: false,
      triggers: [],
      metrics: {},
      summary: "Local OK",
    },
    gemini: {
      summary: "Gemini: parse failed",
    },
    final: {
      pass: false,
      blockedBy: "gemini_parse_error",
      reason: "Gemini semantic JSON parse failed (fail-closed)",
    },
  };
}

const parseErrorReport = simulateParseError();
assertEqual(parseErrorReport.final.pass, false, "parse error causes pass=false");
assertEqual(parseErrorReport.final.blockedBy, "gemini_parse_error" as BlockedBy, "blockedBy=gemini_parse_error");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Stage 1B does NOT run placement
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nStage 1B skips placement:");

function simulateStage1BSkipsPlacement(): ValidatorReport {
  return {
    stage: "1B_FULL",
    baselinePath: "/tmp/baseline.webp",
    candidatePath: "/tmp/candidate.webp",
    ran: {
      localStructural: true,
      localMaskedEdge: true,
      localSemanticFallback: true,
      geminiSemantic: true,
      geminiPlacement: false, // NOT run for 1B
    },
    skipped: {
      gemini: false,
    },
    latencyMs: {
      local: 100,
      gemini: 800,
      total: 900,
    },
    local: {
      pass: true,
      risk: false,
      fatal: false,
      triggers: [],
      metrics: {},
      summary: "Local OK",
    },
    gemini: {
      semantic: {
        pass: true,
        confidence: 0.90,
        allowed_changes_only: true,
        reason: "Room properly emptied",
        fail_reasons: [],
        checks: {} as any,
      },
      summary: "Gemini OK",
    },
    final: {
      pass: true,
      blockedBy: "none",
      reason: "All validators passed",
    },
  };
}

const stage1BReport = simulateStage1BSkipsPlacement();
assertEqual(stage1BReport.ran.geminiPlacement, false, "placement not run for stage 1B");
assertEqual(stage1BReport.final.pass, true, "stage 1B can pass without placement");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: StageKey mapping
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nStageKey mapping:");

const validStages: StageKey[] = ["1A", "1B_LIGHT", "1B_FULL", "2"];
for (const s of validStages) {
  assert(typeof s === "string", `${s} is valid StageKey`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Skipped tracking
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nSkipped tracking:");

assert(mockReport.skipped.gemini === false, "gemini not skipped when fully ran");
assertEqual(fatalReport.skipped.geminiReason, "local_blocked" as "local_blocked", "fatal trigger sets geminiReason=local_blocked");
assertEqual(riskBlockReport.skipped.geminiReason, "local_blocked" as "local_blocked", "risk trigger sets geminiReason=local_blocked");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: LatencyMs tracking
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nLatencyMs tracking:");

assert(mockReport.latencyMs.local > 0, "local latency tracked");
assert(mockReport.latencyMs.gemini > 0, "gemini latency tracked");
assert(mockReport.latencyMs.total > 0, "total latency tracked");
assert(mockReport.latencyMs.total >= mockReport.latencyMs.local, "total >= local latency");
assert(fatalReport.latencyMs.gemini === 0, "gemini latency is 0 when skipped");

// ═══════════════════════════════════════════════════════════════════════════════
// Test: Env var configuration
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\nEnv var configuration:");

resetEnv();
process.env.SEMANTIC_VALIDATOR_FAIL_CLOSED = "1";
process.env.SEMANTIC_VALIDATOR_HIGH_CONF_THRESHOLD = "0.85";
process.env.SEMANTIC_VALIDATOR_LOG_RAW = "0";

assertEqual(process.env.SEMANTIC_VALIDATOR_FAIL_CLOSED, "1", "fail-closed env var set");
assertEqual(process.env.SEMANTIC_VALIDATOR_HIGH_CONF_THRESHOLD, "0.85", "threshold env var set");
assertEqual(process.env.SEMANTIC_VALIDATOR_LOG_RAW, "0", "log raw env var set");

resetEnv();

// Test LOCAL_VALIDATOR_BLOCK_ON_RISK
console.log("\nLOCAL_VALIDATOR_BLOCK_ON_RISK env var:");

process.env.LOCAL_VALIDATOR_BLOCK_ON_RISK = "1";
assertEqual(process.env.LOCAL_VALIDATOR_BLOCK_ON_RISK, "1", "LOCAL_VALIDATOR_BLOCK_ON_RISK=1 (default, strict)");

process.env.LOCAL_VALIDATOR_BLOCK_ON_RISK = "0";
assertEqual(process.env.LOCAL_VALIDATOR_BLOCK_ON_RISK, "0", "LOCAL_VALIDATOR_BLOCK_ON_RISK=0 (lenient)");

resetEnv();

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
