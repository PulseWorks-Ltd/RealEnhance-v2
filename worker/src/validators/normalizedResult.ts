/**
 * Normalized validator result structure.
 *
 * This is the canonical shape callers can rely on — regardless of
 * which validators actually ran.  The adapter builds it from the
 * existing UnifiedValidationResult without changing that type.
 *
 * Downstream consumers should use this type when they need a
 * consistent, serializable summary of the validation outcome.
 */

import type { UnifiedValidationResult, ValidatorResult } from "./runValidation";

export interface NormalizedCheck {
  name: string;
  pass: boolean;
  score: number;
}

export interface NormalizedValidatorResult {
  verdict: "PASS" | "FAIL" | "ESCALATED_PASS" | "ESCALATED_FAIL";
  score?: number;
  checks: NormalizedCheck[];
  earlyExit?: boolean;
  escalated?: boolean;
}

/**
 * Convert an existing UnifiedValidationResult into the canonical
 * NormalizedValidatorResult shape.
 *
 * This is an *adapter only* — it does not change pass/fail logic, thresholds,
 * or any downstream consumer.  Callers that currently use
 * UnifiedValidationResult continue to work unmodified.
 */
export function normalizeValidatorResult(
  result: UnifiedValidationResult
): NormalizedValidatorResult {
  // Build per-check list from the raw validator map
  const checks: NormalizedCheck[] = Object.values(result.raw).map(
    (vr: ValidatorResult) => ({
      name: vr.name,
      pass: vr.passed,
      score: vr.score ?? (vr.passed ? 1.0 : 0.0),
    })
  );

  // Derive verdict string
  const escalated = result.escalated === true;
  let verdict: NormalizedValidatorResult["verdict"];

  if (result.passed) {
    verdict = escalated ? "ESCALATED_PASS" : "PASS";
  } else {
    verdict = escalated ? "ESCALATED_FAIL" : "FAIL";
  }

  return {
    verdict,
    score: result.score,
    checks,
    earlyExit: result.earlyExit || undefined,
    escalated: escalated || undefined,
  };
}
