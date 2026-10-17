// Extracted from worker.ts's Stage 2 critical-issues gate (previously an
// inline closure with no exports, so this exact logic was never directly
// unit-testable — see the established testing philosophy in this repo:
// pure decision-logic gets extracted and tested with literal fixture data,
// never by mocking the Gemini/Grok layer). Pulled out unchanged in behavior
// except for the two fixes documented inline below.
//
// PURPOSE: a specialist validator (openingValidator) can hard-fail an
// opening as OPENING_REMOVED/OPENING_INFILLED/OPENING_SEALED/
// OPENING_RESIZED_* purely from the occlusion-vs-removal vision check in
// occlusionVsRemovalCheck.ts. That check is known to sometimes misread an
// opening that is simply decorated/partially occluded (curtains, plants,
// furniture, staging) as "replaced" or "removed" even when the opening
// itself is untouched. This guard looks for corroborating occlusion-cause
// keywords in the specialist's own reason/subtype/advisory text (and the
// wider job's specialist advisories) and, when found strongly enough,
// downgrades the hard block to an advisory OPENING_OCCLUSION signal so
// Gemini's Unified validator gets to adjudicate holistically instead of an
// unappealable pre-Unified block.
//
// FIX 1 (2026-08-30, confirmed real incidents job_9afb6878 and
// job_c4a18bc3): isOpeningEscalationCandidate previously recognized only
// OPENING_REMOVED/OPENING_RESIZED_MAJOR/OPENING_RESIZED_MINOR.
// OPENING_INFILLED and OPENING_SEALED were missing — but
// openingEnvelopeValidator.ts reports EVERY altered-opening verdict
// ("replaced", "removed", "resized", "fully_covered") under the single
// issueType OPENING_INFILLED, so the "replaced" verdicts that are actually
// this guard's exact target case never reached it. Both real incidents had
// clear occlusion-guard keywords ("curtains", "potted plants") sitting
// unused in the failing reason text. Confirmed via direct visual
// inspection of both jobs' attempt outputs that the flagged opening was
// genuinely unchanged.
//
// FIX 2: collectIfOcclusionHint previously added at most ONE hint per
// source string, regardless of how many distinct occlusion keywords that
// string contained (a reason string naming both "curtains" and "potted
// plants" only ever counted as one hint toward the >=2 corroboration
// threshold). matchedOpeningOcclusionKeywords now returns every distinct
// match, so a single reason string can clear the threshold on its own when
// it names multiple independent occlusion causes. This only ever
// increases a hint count that was previously computed — a case that
// already cleared >=2 before this change still clears it now.
import { ISSUE_TYPES } from "./issueTypes";

export type OpeningEscalationSignal = {
  validator?: string;
  issueType?: string;
  reason?: string;
  subtype?: string;
  advisorySignals?: string[];
};

export const OPENING_OCCLUSION_GUARD_KEYWORDS = [
  "curtain",
  "curtains",
  "blind",
  "blinds",
  "drape",
  "drapes",
  "window covering",
  "window coverings",
  "window_covering",
  "window_coverings",
  "soft furnishing",
  "soft furnishings",
  "bed",
  "headboard",
  "sofa",
  "couch",
  "chair",
  "plant",
  "leaf",
  "lamp",
  "shelf",
  "shelving",
  "decor",
  "furniture",
  "foreground",
  "staging",
];

export const normalizeOcclusionGuardText = (value: string): string =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[|:,;]+/g, " ")
    .replace(/\s+/g, " ");

// Returns every distinct guard keyword found in the (already-normalized)
// text, not just whether at least one matched — see the FIX 2 note above.
export const matchedOpeningOcclusionKeywords = (value: string): string[] => {
  const normalized = normalizeOcclusionGuardText(value);
  if (!normalized) return [];
  return OPENING_OCCLUSION_GUARD_KEYWORDS.filter((keyword) => normalized.includes(keyword));
};

export const hasOpeningOcclusionKeyword = (value: string): boolean => {
  const normalized = normalizeOcclusionGuardText(value);
  if (!normalized) return false;
  return OPENING_OCCLUSION_GUARD_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

// See FIX 1 above: OPENING_INFILLED/OPENING_SEALED were confirmed missing.
export const isOpeningEscalationCandidate = (signal: OpeningEscalationSignal): boolean => {
  const issueType = signal.issueType;
  if (
    issueType === ISSUE_TYPES.OPENING_REMOVED ||
    issueType === ISSUE_TYPES.OPENING_INFILLED ||
    issueType === ISSUE_TYPES.OPENING_SEALED ||
    issueType === ISSUE_TYPES.OPENING_RESIZED_MAJOR ||
    issueType === ISSUE_TYPES.OPENING_RESIZED_MINOR
  ) {
    return true;
  }

  const detail = [signal.reason || "", signal.subtype || "", ...(signal.advisorySignals || [])]
    .map((part) => normalizeOcclusionGuardText(part))
    .join(" ");
  return (
    detail.includes("opening_removed") ||
    detail.includes("opening_infilled") ||
    detail.includes("opening_sealed") ||
    detail.includes("opening_resized") ||
    detail.includes("opening_resize")
  );
};

export function shouldApplyOpeningOcclusionGuard(
  signal: OpeningEscalationSignal,
  allSignals: OpeningEscalationSignal[],
  allAdvisories: string[],
  curtainRailLikely?: boolean
): { apply: boolean; occlusionHints: string[] } {
  if (!isOpeningEscalationCandidate(signal)) {
    return { apply: false, occlusionHints: [] };
  }

  const occlusionHints = new Set<string>();

  const collectIfOcclusionHint = (source: string, value: string) => {
    const normalized = normalizeOcclusionGuardText(value);
    if (!normalized) return;
    // One hint per distinct matched keyword, not one hint per source
    // string — see FIX 2 above.
    matchedOpeningOcclusionKeywords(normalized).forEach((keyword) => {
      occlusionHints.add(`${source}:${keyword}:${normalized.slice(0, 120)}`);
    });
  };

  collectIfOcclusionHint("opening.reason", signal.reason || "");
  collectIfOcclusionHint("opening.subtype", signal.subtype || "");
  (signal.advisorySignals || []).forEach((entry) => collectIfOcclusionHint("opening.advisory", String(entry || "")));

  allAdvisories.forEach((entry) => collectIfOcclusionHint("specialist.advisory", String(entry || "")));

  allSignals
    .filter((entry) => entry.validator === "fixtures" || entry.validator === "openings")
    .forEach((entry) => {
      collectIfOcclusionHint(`${entry.validator}.reason`, entry.reason || "");
      collectIfOcclusionHint(`${entry.validator}.subtype`, entry.subtype || "");
      (entry.advisorySignals || []).forEach((advisory) =>
        collectIfOcclusionHint(`${entry.validator}.advisory`, String(advisory || ""))
      );
    });

  if (curtainRailLikely === true) {
    occlusionHints.add("scene:curtain_rail_likely");
  }

  return {
    apply: occlusionHints.size > 0,
    occlusionHints: Array.from(occlusionHints),
  };
}

// The gate that actually decides whether a categoricalBlock gets
// downgraded to advisory — see worker.ts's SINGLE-AUTHORITY comment at the
// call site. "UNKNOWN" is included alongside "OCCLUSION" for the same
// confirmed reason as FIX 1: OPENING_INFILLED/OPENING_REMOVED/
// OPENING_SEALED classify as "UNKNOWN" (not "OCCLUSION") whenever there is
// no corroborating envelope signal, which is exactly the un-corroborated,
// decor-driven false-positive case this guard exists to catch. A signal
// with genuine corroborating envelope evidence classifies as "REMOVAL" and
// is deliberately excluded here.
export function isEligibleForOpeningOcclusionDowngrade(
  categoricalBlockClass: string,
  occlusionHintCount: number
): boolean {
  return (categoricalBlockClass === "OCCLUSION" || categoricalBlockClass === "UNKNOWN") && occlusionHintCount >= 2;
}
