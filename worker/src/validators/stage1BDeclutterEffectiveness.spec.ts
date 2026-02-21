import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateStage1BDeclutterEffectiveness,
  type Stage1BDeclutterMetrics,
  type Stage1BDeclutterThresholds,
} from "./stage1BDeclutterEffectiveness";

const thresholds: Stage1BDeclutterThresholds = {
  minConfidence: 0.8,
  percentBaselineMin: 5,
  percentAfterMin: 3,
  maxRemainingPercent: 20,
  absoluteAfterBlock: 6,
  surfaceAfterBlock: 3,
};

function evaluate(metrics: Stage1BDeclutterMetrics) {
  return evaluateStage1BDeclutterEffectiveness(metrics, thresholds);
}

test("does not block when confidence is below threshold", () => {
  const result = evaluate({
    beforeClutterItems: 12,
    afterClutterItems: 8,
    remainingPercent: 66,
    surfaceClutterItems: 5,
    confidence: 0.72,
    reasons: [],
  });

  assert.equal(result.confidenceEligible, false);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockReasons, []);
});

test("does not block for small leftovers (1-2 items)", () => {
  const result = evaluate({
    beforeClutterItems: 8,
    afterClutterItems: 2,
    remainingPercent: 25,
    surfaceClutterItems: 1,
    confidence: 0.9,
    reasons: [],
  });

  assert.equal(result.confidenceEligible, true);
  assert.equal(result.blocked, false);
});

test("blocks when percent gate is exceeded", () => {
  const result = evaluate({
    beforeClutterItems: 10,
    afterClutterItems: 4,
    remainingPercent: 40,
    surfaceClutterItems: 1,
    confidence: 0.91,
    reasons: [],
  });

  assert.equal(result.blocked, true);
  assert.ok(result.blockReasons.some((r) => r.startsWith("remaining_percent_exceeded")));
});

test("blocks when absolute or core-surface leftovers exceed thresholds", () => {
  const absoluteBlock = evaluate({
    beforeClutterItems: 3,
    afterClutterItems: 6,
    remainingPercent: 15,
    surfaceClutterItems: 1,
    confidence: 0.9,
    reasons: [],
  });
  assert.equal(absoluteBlock.blocked, true);
  assert.ok(absoluteBlock.blockReasons.some((r) => r.startsWith("absolute_after_exceeded")));

  const surfaceBlock = evaluate({
    beforeClutterItems: 4,
    afterClutterItems: 2,
    remainingPercent: 18,
    surfaceClutterItems: 3,
    confidence: 0.88,
    reasons: [],
  });
  assert.equal(surfaceBlock.blocked, true);
  assert.ok(surfaceBlock.blockReasons.some((r) => r.startsWith("surface_clutter_exceeded")));
});
