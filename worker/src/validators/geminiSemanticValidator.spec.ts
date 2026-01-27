import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeGeminiSemantic } from "./runValidation";
import type { GeminiSemanticVerdict } from "./geminiSemanticValidator";

test("Gemini furniture change is warning only", () => {
  const verdict: GeminiSemanticVerdict = {
    hardFail: false,
    category: "furniture_change",
    reasons: ["Added headboard behind bed"],
    confidence: 0.82,
  };

  const summary = summarizeGeminiSemantic(verdict);

  assert.equal(summary.hardFail, false);
  assert.equal(summary.passed, true);
  assert.ok(summary.warnings.includes("Added headboard behind bed"));
  assert.equal(verdict.category, "furniture_change");
});
