import type { OpeningDiagnosticFinding } from "./openingPreservationValidator";

// Narrow fail-fast for Stage 1B: skip the ~9s full_gemini call only when the deterministic
// opening reconciliation reports an unambiguous closure (infilled/missing + the same
// "wall continuity" corroboration openingValidator.ts already treats as strong evidence)
// at high confidence. Everything else still falls back to full_gemini (GEMINI_ONLY policy).
export const STAGE1B_OPENING_CLOSURE_FAILFAST_CONFIDENCE = Number(
  process.env.STAGE1B_OPENING_CLOSURE_FAILFAST_CONFIDENCE || 0.9
);
export const STAGE1B_OPENING_CLOSURE_FAILFAST_REASONS = new Set([
  "opening_replaced_by_wall_continuity",
  "missing_opening",
]);

export type Stage1BOpeningClosureDetail = {
  location: string;
  openingType: string;
  explanation: string;
};

export type Stage1BOpeningClosureSignal = {
  /** True when the opening reconciliation reports an opening was removed, infilled, or sealed. */
  openingClosed: boolean;
  /**
   * The highest-confidence closed/infilled/missing finding, if any — regardless of whether
   * it clears the fail-fast confidence bar. Used to phrase a retry-prompt correction even
   * when the closure isn't confident enough to hard-fail deterministically on its own.
   */
  openingClosureDetail?: Stage1BOpeningClosureDetail;
  /**
   * Set only when a specific finding independently corroborates the closure with a strong,
   * unambiguous machine reason at or above the confidence threshold — the narrow condition
   * under which the caller may hard-fail without waiting on full_gemini.
   */
  failFastFinding?: OpeningDiagnosticFinding;
};

/**
 * Pure computation over an opening-reconciliation result. Previously this only looked at
 * openingStateChanged/openingApertureExpanded (an opening getting bigger or changing
 * open/closed state) and never at an opening being closed off entirely — the more serious
 * of the two failure modes, since it permanently removes an architectural feature rather
 * than just changing its state.
 */
export function computeStage1BOpeningClosureSignal(params: {
  summary: {
    openingRemoved?: boolean;
    openingInfilled?: boolean;
    openingSealed?: boolean;
  };
  findings: OpeningDiagnosticFinding[] | undefined;
}): Stage1BOpeningClosureSignal {
  const openingClosed =
    params.summary.openingRemoved === true ||
    params.summary.openingInfilled === true ||
    params.summary.openingSealed === true;

  if (!openingClosed) {
    return { openingClosed: false };
  }

  const findings = Array.isArray(params.findings) ? params.findings : [];
  const closureFindings = findings.filter((finding) => finding.status === "infilled" || finding.status === "missing");

  const bestClosureFinding = closureFindings.length > 0
    ? closureFindings.reduce((best, finding) => (finding.confidence > best.confidence ? finding : best), closureFindings[0])
    : undefined;

  const openingClosureDetail: Stage1BOpeningClosureDetail | undefined = bestClosureFinding
    ? {
        location: bestClosureFinding.location,
        openingType: bestClosureFinding.openingType,
        explanation: bestClosureFinding.explanation,
      }
    : undefined;

  const failFastFinding = closureFindings.find((finding) =>
    Number.isFinite(finding.confidence) &&
    finding.confidence >= STAGE1B_OPENING_CLOSURE_FAILFAST_CONFIDENCE &&
    Array.isArray(finding.machineReasons) &&
    finding.machineReasons.some((reason) => STAGE1B_OPENING_CLOSURE_FAILFAST_REASONS.has(reason))
  );

  return { openingClosed, openingClosureDetail, failFastFinding };
}

/**
 * Renders the retry-prompt correction as a natural-language sentence, not a metadata dump —
 * Gemini responds to instructions phrased the way the rest of the Stage 1B prompt is phrased,
 * not to a bulleted field/value list.
 */
export function buildStage1BRetryCorrectionPrompt(retryCorrection: Stage1BOpeningClosureDetail): string {
  // `location` (from openingPreservationValidator.ts's describeOpeningLocation) already
  // reads as a full noun phrase — e.g. "walk-through opening in the center of the near
  // wall" — so it's used directly rather than wrapped in another "{type} opening located
  // at {location}" frame, which would repeat "opening" and read like a metadata dump.
  return `

PREVIOUS ATTEMPT CORRECTION (CRITICAL):
A previous attempt on this image incorrectly filled in the ${retryCorrection.location} — turning it into a continuous wall surface where an opening should be. This opening MUST remain open and unobstructed in this attempt. Do not add wall, floor, paneling, or any continuous surface across it.
`;
}
