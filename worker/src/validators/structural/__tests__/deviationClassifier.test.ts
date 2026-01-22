// Simple unit tests for deviation classifier
// Run with: npx tsx src/validators/structural/__tests__/deviationClassifier.test.ts

import { classifyDeviation, type DeviationConfig } from "../deviationClassifier";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

const cfg: DeviationConfig = {
  fatalRequiresConfirmation: true,
  confirmationSignalsMin: 1,
  thresholdsDeg: {
    stage1A: 20,
    stage1B: 35,
    stage2: 45,
  },
};

console.log("Deviation classifier tests:\n");

// High deviation but no confirmations -> risk only, Gemini should run
const riskOnly = classifyDeviation("stage1A", 50, {
  structIou: 0.5,
  structIouThreshold: 0.3,
  edgeIou: 0.7,
  edgeIouThreshold: 0.6,
  openingsDelta: 0,
  openingsMinDelta: 2,
  openingsValidatorActive: true,
}, cfg);
assert(riskOnly?.severity === "risk", "High deviation alone is risk-only (stage1A)");

// High deviation + low structIoU -> fatal
const fatalStruct = classifyDeviation("stage1A", 50, {
  structIou: 0.2,
  structIouThreshold: 0.3,
  edgeIou: 0.8,
  edgeIouThreshold: 0.6,
  openingsDelta: 0,
  openingsMinDelta: 2,
  openingsValidatorActive: true,
}, cfg);
assert(fatalStruct?.severity === "fatal" && fatalStruct?.confirmationsUsed.includes("structIou"), "Deviation + low structIoU escalates to fatal");

// High deviation + openings delta over min -> fatal
const fatalOpenings = classifyDeviation("stage1B", 60, {
  structIou: 0.5,
  structIouThreshold: 0.4,
  edgeIou: 0.7,
  edgeIouThreshold: 0.5,
  openingsDelta: 3,
  openingsMinDelta: 2,
  openingsValidatorActive: true,
}, cfg);
assert(fatalOpenings?.severity === "fatal" && fatalOpenings?.confirmationsUsed.includes("openingsDelta"), "Deviation + openings delta escalates to fatal");

// Stage2 is always risk-only for deviation
const stage2Risk = classifyDeviation("stage2", 80, {
  structIou: 0.1,
  structIouThreshold: 0.8,
  edgeIou: 0.1,
  edgeIouThreshold: 0.6,
  openingsDelta: 5,
  openingsMinDelta: 2,
  openingsValidatorActive: true,
}, cfg);
assert(stage2Risk?.severity === "risk", "Stage2 deviation is never fatal");

console.log("\n=== Test Results ===");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
