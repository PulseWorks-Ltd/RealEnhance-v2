import { getGeminiClient } from "../ai/gemini";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { toBase64 } from "../utils/images";
import {
  detectRelocation,
  extractStructuralBaseline,
  type StructuralBaseline,
  type OpeningDiagnosticFinding,
  validateOpeningPreservation,
} from "./openingPreservationValidator";
import { classifyIssueTier, createStructuredIssue, ISSUE_TYPES, mapIssueTierToSeverity, splitIssueTokens, type StructuredIssue, type ValidationIssueType } from "./issueTypes";
import { computeOpeningGeometrySignal } from "./signalMetrics";
import type { ValidatorOutcome } from "./validatorOutcome";
import type { AdvisoryObservation } from "./runValidation";

export type OpeningValidatorDetail = {
  id: string;
  classification: "present" | "occluded" | "altered" | "removed" | "relocated" | "unknown";
  reason: string;
  explanation?: string;
  location?: string;
  machineReasons?: string[];
  question?: string;
};

export type OpeningValidatorResult = ValidatorOutcome & {
  explanation?: string;
  findings?: OpeningDiagnosticFinding[];
  advisoryObservations?: AdvisoryObservation[];
  details?: OpeningValidatorDetail[];
  decision?: OpeningValidatorDecision;
};

export type OpeningValidatorDecision = {
  decision: "pass" | "advisory" | "hard_fail";
  authorityClass: "CLASS_A" | "CLASS_B" | "CLASS_C" | "CLASS_D";
  authority: string;
  vetoable: boolean;
  signals: string[];
  decisionTrace: string[];
  trace: string[];
  semanticCorroborated: boolean;
  vetoed: boolean;
};

const OPENING_MODEL_PRIMARY = process.env.GEMINI_VALIDATOR_MODEL_PRIMARY || "gemini-2.5-flash";
const OPENING_MODEL_ESCALATION = process.env.GEMINI_VALIDATOR_MODEL_ESCALATION || "gemini-2.5-pro";
const OPENING_ESCALATION_CONFIDENCE = Number(process.env.GEMINI_VALIDATOR_PRO_MIN_CONFIDENCE || 0.7);
const HARD_FAIL_CONFIDENCE_THRESHOLD = 0.9;
const OPENING_LIGHT_ANCHOR_MODEL = process.env.GEMINI_OPENING_LIGHT_ANCHOR_MODEL || OPENING_MODEL_PRIMARY;
const OPENING_WINDOW_MIN_RETENTION = Number(process.env.OPENING_WINDOW_MIN_RETENTION || 0.8);
const OPENING_WINDOW_EXTREME_OCCLUSION_RETENTION = Number(process.env.OPENING_WINDOW_EXTREME_OCCLUSION_RETENTION || 0.45);
const OPENING_DOOR_EXTREME_OCCLUSION_RETENTION = Number(process.env.OPENING_DOOR_EXTREME_OCCLUSION_RETENTION || 0.4);
const OPENING_SIZE_REDUCTION_HARD_FAIL_THRESHOLD = Number(process.env.OPENING_SIZE_REDUCTION_HARD_FAIL_THRESHOLD || 0.25);
const OPENING_ADDED_STRONG_DETERMINISTIC_CONFIDENCE = Number(process.env.OPENING_ADDED_STRONG_DETERMINISTIC_CONFIDENCE || 0.8);
const OPENING_ADDED_MICRO_CORROBORATION_CONFIDENCE = Number(process.env.OPENING_ADDED_MICRO_CORROBORATION_CONFIDENCE || 0.9);
const OPENING_ADDED_CONSENSUS_MIN_IOU = Number(process.env.OPENING_ADDED_CONSENSUS_MIN_IOU || 0.2);
const OPENING_ADDED_STRUCTURAL_PRECHECK_MIN_MATCHES = Number(process.env.OPENING_ADDED_STRUCTURAL_PRECHECK_MIN_MATCHES || 1);

function logOpeningInstrumentation(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({
    event,
    ...payload,
  }));
}

function logOpeningPhaseEnd(jobId: string | undefined, phase: string, durationMs: number, extra: Record<string, unknown> = {}): void {
  logOpeningInstrumentation("OPENING_PHASE_END", {
    jobId: jobId || "unknown",
    validator: "opening",
    phase,
    durationMs: Math.max(0, Math.round(durationMs)),
    ...extra,
  });
}

function logOpeningPhaseStart(jobId: string | undefined, phase: string, extra: Record<string, unknown> = {}): void {
  logOpeningInstrumentation("OPENING_PHASE_START", {
    jobId: jobId || "unknown",
    validator: "opening",
    phase,
    durationMs: 0,
    ...extra,
  });
}

function logOpeningGeminiStart(jobId: string | undefined, model: string, promptType: string): void {
  logOpeningInstrumentation("OPENING_GEMINI_START", {
    jobId: jobId || "unknown",
    validator: "opening",
    phase: "gemini",
    durationMs: 0,
    model,
    promptType,
  });
}

function logOpeningGeminiEnd(jobId: string | undefined, model: string, promptType: string, durationMs: number): void {
  logOpeningInstrumentation("OPENING_GEMINI_END", {
    jobId: jobId || "unknown",
    validator: "opening",
    phase: "gemini",
    model,
    promptType,
    durationMs: Math.max(0, Math.round(durationMs)),
  });
}

type BaselineOpenings = {
  openings: Array<{
    id: string;
    type: "window" | "door" | "closet_door" | "opening";
    visibility: "full" | "partial";
    approximateLocation: "left" | "center" | "right" | "rear" | "unknown";
    size: "small" | "medium" | "large" | "unknown";
  }>;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

type OpeningSignalCoherenceAnalysis = {
  coherent: boolean;
  primaryDestructiveStates: string[];
  supportiveModifiers: string[];
  contextualUncertainty: string[];
  contradictions: string[];
};

function uniqueTokens(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function hasAnyToken(tokens: string[], candidates: string[]): boolean {
  return candidates.some((candidate) => tokens.includes(candidate));
}

type OpeningAuthorityKey =
  | "deterministic_added_opening"
  | "deterministic_opening_break"
  | "deterministic_hard_fail"
  | "light_anchor_corroborated"
  | "added_opening_advisory"
  | "advisory"
  | "preserved";

type OpeningAuthorityPolicy = {
  authorityClass: OpeningValidatorDecision["authorityClass"];
  vetoable: boolean;
  deterministicOrigin: boolean;
  semanticOnly: boolean;
  hardFailAllowed: boolean;
};

const OPENING_AUTHORITY_POLICIES: Record<OpeningAuthorityKey, OpeningAuthorityPolicy> = {
  deterministic_added_opening: {
    authorityClass: "CLASS_A",
    vetoable: false,
    deterministicOrigin: true,
    semanticOnly: false,
    hardFailAllowed: true,
  },
  deterministic_opening_break: {
    authorityClass: "CLASS_A",
    vetoable: false,
    deterministicOrigin: true,
    semanticOnly: false,
    hardFailAllowed: true,
  },
  deterministic_hard_fail: {
    authorityClass: "CLASS_A",
    vetoable: false,
    deterministicOrigin: true,
    semanticOnly: false,
    hardFailAllowed: true,
  },
  light_anchor_corroborated: {
    authorityClass: "CLASS_B",
    vetoable: false,
    deterministicOrigin: false,
    semanticOnly: false,
    hardFailAllowed: true,
  },
  added_opening_advisory: {
    authorityClass: "CLASS_C",
    vetoable: true,
    deterministicOrigin: false,
    semanticOnly: true,
    hardFailAllowed: false,
  },
  advisory: {
    authorityClass: "CLASS_C",
    vetoable: true,
    deterministicOrigin: false,
    semanticOnly: true,
    hardFailAllowed: false,
  },
  preserved: {
    authorityClass: "CLASS_D",
    vetoable: true,
    deterministicOrigin: false,
    semanticOnly: true,
    hardFailAllowed: false,
  },
};

function resolveOpeningAuthorityPolicy(authority: string): OpeningAuthorityPolicy {
  const key = authority as OpeningAuthorityKey;
  const policy = OPENING_AUTHORITY_POLICIES[key];
  if (!policy) {
    throw new Error(`OPENING_VALIDATOR_AUTHORITY_UNKNOWN:${authority}`);
  }
  return policy;
}

function buildOpeningDecisionTrace(params: {
  authority: string;
  authorityClass: OpeningValidatorDecision["authorityClass"];
  decision: OpeningValidatorDecision["decision"];
  vetoable: boolean;
  vetoed: boolean;
  deterministicHardFailIssue: boolean;
  hasHighConfidenceMicroHardFailSignal: boolean;
  addedHardFailCorroborated: boolean;
  openingAddedConsensusUnstable: boolean;
  openingAddedStructuralContinuityUnresolved: boolean;
  reasonParts: string[];
  advisorySignals: string[];
}): string[] {
  const trace: string[] = ["decision_trace_started"];

  if (params.deterministicHardFailIssue) trace.push("deterministic_signal_detected");
  if (params.reasonParts.includes("opening_added")) trace.push("opening_added_signal_detected");
  if (params.openingAddedConsensusUnstable) trace.push("added_opening_consensus_unstable");
  if (params.openingAddedStructuralContinuityUnresolved) trace.push("structural_continuity_unresolved");
  if (params.hasHighConfidenceMicroHardFailSignal) trace.push("semantic_microcheck_hardfail_signal");
  if (params.addedHardFailCorroborated) trace.push("semantic_corroboration_confirmed");
  if (params.advisorySignals.length > 0) trace.push("advisory_signals_present");

  trace.push(`authority_${params.authorityClass.toLowerCase()}_assigned`);
  trace.push(`authority_${params.authority}`);

  if (params.decision === "hard_fail") {
    trace.push("hard_fail_decision_selected");
  } else if (params.decision === "advisory") {
    trace.push("advisory_decision_selected");
  } else {
    trace.push("pass_decision_selected");
  }

  if (params.vetoed) {
    trace.push("veto_applied");
  } else if (!params.vetoable) {
    trace.push("veto_skipped_nonvetoable");
  }

  if (params.authorityClass === "CLASS_A") {
    trace.push("deterministic_supremacy_applied");
  }

  return uniqueTokens(trace);
}

function assertOpeningAuthorityInvariants(params: {
  authority: string;
  policy: OpeningAuthorityPolicy;
  decision: OpeningValidatorDecision["decision"];
  vetoable: boolean;
  vetoed: boolean;
}): void {
  const { authority, policy, decision, vetoable, vetoed } = params;

  if (policy.authorityClass === "CLASS_A") {
    if (vetoable) {
      throw new Error(`OPENING_VALIDATOR_AUTHORITY_INVARIANT:CLASS_A_NON_VETOABLE_REQUIRED:${authority}`);
    }
    if (!policy.deterministicOrigin || !authority.startsWith("deterministic_")) {
      throw new Error(`OPENING_VALIDATOR_AUTHORITY_INVARIANT:CLASS_A_DETERMINISTIC_ORIGIN_REQUIRED:${authority}`);
    }
  }

  if (policy.authorityClass === "CLASS_D") {
    if (decision === "hard_fail" || policy.hardFailAllowed) {
      throw new Error(`OPENING_VALIDATOR_AUTHORITY_INVARIANT:CLASS_D_NEVER_HARD_FAIL:${authority}`);
    }
    if (!policy.semanticOnly) {
      throw new Error(`OPENING_VALIDATOR_AUTHORITY_INVARIANT:CLASS_D_SEMANTIC_OR_ADVISORY_ONLY:${authority}`);
    }
  }

  if (decision === "hard_fail" && !policy.hardFailAllowed) {
    throw new Error(`OPENING_VALIDATOR_AUTHORITY_INVARIANT:HARD_FAIL_NOT_ALLOWED:${authority}`);
  }

  if (vetoed && !vetoable) {
    throw new Error(`OPENING_VALIDATOR_AUTHORITY_INVARIANT:VETO_APPLIED_TO_NON_VETOABLE_AUTHORITY:${authority}`);
  }
}

export function analyzeOpeningSignalCoherence(params: {
  issueType: string;
  allIssueTypes: string[];
  hasResize: boolean;
  hasOcclusion: boolean;
  hasBandMismatch: boolean;
}): OpeningSignalCoherenceAnalysis {
  const tokens = uniqueTokens(params.allIssueTypes.map((token) => String(token || "").trim().toLowerCase()));
  const primaryDestructiveStates = uniqueTokens(tokens.filter((token) =>
    token === "opening_removed" ||
    token === "opening_infilled" ||
    token === "opening_sealed" ||
    token === "opening_type_changed" ||
    token === "opening_class_mismatch" ||
    token === "light_anchor_opening_removed" ||
    token === "light_anchor_opening_infilled"
  ));

  if (params.issueType && params.issueType !== ISSUE_TYPES.NONE) {
    if (
      params.issueType === ISSUE_TYPES.OPENING_REMOVED ||
      params.issueType === ISSUE_TYPES.OPENING_INFILLED ||
      params.issueType === ISSUE_TYPES.OPENING_SEALED ||
      params.issueType === ISSUE_TYPES.OPENING_ANOMALY
    ) {
      primaryDestructiveStates.push(params.issueType);
    }
  }

  const supportiveModifiers = uniqueTokens([
    ...(params.hasResize ? ["opening_resized"] : []),
    ...(params.hasBandMismatch ? ["opening_band_mismatch"] : []),
    ...tokens.filter((token) =>
      token === "opening_resized" ||
      token === "opening_resized_major" ||
      token.startsWith("opening_size_reduction_ge_") ||
      token.startsWith("opening_resize_ge_") ||
      token.startsWith("opening_resized_minor") ||
      token === "opening_band_mismatch" ||
      token === "opening_signature_mismatch" ||
      token === "light_anchor_opening_removed" ||
      token === "light_anchor_opening_infilled"
    ),
  ]);

  const contextualUncertainty = uniqueTokens([
    ...(params.hasOcclusion ? ["opening_occlusion_review"] : []),
    ...tokens.filter((token) =>
      token === "opening_relocated_review" ||
      token === "light_anchor_opening_relocated_review" ||
      token === "door_or_closet_occluded_review" ||
      token === "window_occlusion_review" ||
      token.includes("occlusion")
    ),
  ]);

  const contradictions: string[] = [];

  if (primaryDestructiveStates.length === 0) {
    contradictions.push("missing_primary_destructive_state");
  }

  if (hasAnyToken(tokens, ["openings_preserved", "opening_preserved", "opening_unchanged", "opening_present"])) {
    contradictions.push("preserved_state_conflicts_with_destructive_state");
  }

  const hasRelocationExplanation = hasAnyToken(tokens, ["opening_relocated_review", "light_anchor_opening_relocated_review"]);
  if (tokens.includes("opening_added") && primaryDestructiveStates.length > 0 && !hasRelocationExplanation) {
    contradictions.push("opening_added_without_relocation_explanation");
  }

  if (
    params.hasOcclusion &&
    primaryDestructiveStates.length > 0 &&
    supportiveModifiers.length === 0 &&
    !tokens.includes("opening_removed") &&
    !tokens.includes("opening_infilled") &&
    !tokens.includes("opening_sealed")
  ) {
    contradictions.push("occlusion_only_conflicts_with_destructive_state");
  }

  return {
    coherent: primaryDestructiveStates.length > 0 && contradictions.length === 0,
    primaryDestructiveStates: uniqueTokens(primaryDestructiveStates),
    supportiveModifiers,
    contextualUncertainty,
    contradictions: uniqueTokens(contradictions),
  };
}

/**
 * Signal coherence gate: destructive opening states remain coherent when
 * paired with supportive geometry modifiers. Only true semantic contradictions
 * should suppress hard-fail intent.
 */
function isOpeningSignalCoherent(params: {
  issueType: string;
  allIssueTypes: string[];
  hasResize: boolean;
  hasOcclusion: boolean;
  hasBandMismatch: boolean;
}): boolean {
  return analyzeOpeningSignalCoherence(params).coherent;
}

function evaluateDoorFunctionalBlockage(
  baselineOpening: StructuralBaseline["openings"][number],
  detectedOpening: StructuralBaseline["openings"][number],
  retention: number
): boolean {
  // Approximate overlap from retained visible doorway area.
  const overlapRatio = clamp01(1 - retention);

  const baselineHeight = Math.max(0.01, baselineOpening.bbox[3] - baselineOpening.bbox[1]);
  const detectedHeight = Math.max(0.01, detectedOpening.bbox[3] - detectedOpening.bbox[1]);
  const verticalRetention = clamp01(detectedHeight / baselineHeight);

  const baselineTouchesFloor = baselineOpening.touchesFloor === true || baselineOpening.verticalBand === "floor_zone" || baselineOpening.verticalBand === "full_height";
  const detectedTouchesFloor = detectedOpening.touchesFloor === true || detectedOpening.verticalBand === "floor_zone" || detectedOpening.verticalBand === "full_height";

  const preservesVerticalOpening = verticalRetention >= 0.7;
  const preservesFloorVisibility = !baselineTouchesFloor || detectedTouchesFloor;

  return overlapRatio > 0.5 && !preservesVerticalOpening && !preservesFloorVisibility;
}

function toOpeningRegionType(input: StructuralBaseline["openings"][number]["type"]): "window" | "door" | null {
  if (input === "window") return "window";
  if (input === "door" || input === "closet_door" || input === "walkthrough") return "door";
  return null;
}

function normalizeBbox01(input: [number, number, number, number]): [number, number, number, number] {
  let x1 = clamp01(Number(input[0]));
  let y1 = clamp01(Number(input[1]));
  let x2 = clamp01(Number(input[2]));
  let y2 = clamp01(Number(input[3]));
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  return [x1, y1, x2, y2];
}

function bboxIoU(
  a: [number, number, number, number],
  b: [number, number, number, number]
): number {
  const ax1 = Math.min(a[0], a[2]);
  const ay1 = Math.min(a[1], a[3]);
  const ax2 = Math.max(a[0], a[2]);
  const ay2 = Math.max(a[1], a[3]);
  const bx1 = Math.min(b[0], b[2]);
  const by1 = Math.min(b[1], b[3]);
  const bx2 = Math.max(b[0], b[2]);
  const by2 = Math.max(b[1], b[3]);

  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;

  const areaA = Math.max(0, (ax2 - ax1) * (ay2 - ay1));
  const areaB = Math.max(0, (bx2 - bx1) * (by2 - by1));
  const union = areaA + areaB - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

type DeterministicAddedOpeningSignal = {
  type: StructuralBaseline["openings"][number]["type"];
  wallIndex: StructuralBaseline["openings"][number]["wallIndex"];
  canonicalWallIndex: StructuralBaseline["openings"][number]["wallIndex"];
  horizontalBand: StructuralBaseline["openings"][number]["horizontalBand"];
  bbox: [number, number, number, number];
  confidence: number;
};

type StructuralContinuityPrecheckResult = {
  passed: boolean;
  matchedReferenceOpenings: number;
  wallRemap: Map<number, number>;
};

function resolveBaselineReferenceOpening(
  candidate: StructuralBaseline["openings"][number],
  baselineOpenings: StructuralBaseline["openings"]
): StructuralBaseline["openings"][number] | null {
  const idMatch = baselineOpenings.find((base) => String(base.id) === String(candidate.id));
  if (idMatch) return idMatch;

  const structuralBandMatches = baselineOpenings.filter((base) =>
    base.type === candidate.type &&
    base.horizontalBand === candidate.horizontalBand
  );
  if (structuralBandMatches.length === 1) return structuralBandMatches[0];

  return null;
}

function pickTopVote(votes: Map<number, number>): number | null {
  let topKey: number | null = null;
  let topCount = 0;
  let isTie = false;
  votes.forEach((count, key) => {
    if (count > topCount) {
      topKey = key;
      topCount = count;
      isTie = false;
      return;
    }
    if (count === topCount) {
      isTie = true;
    }
  });
  if (topKey === null || topCount <= 0 || isTie) return null;
  return topKey;
}

export function runStructuralContinuityPrecheck(params: {
  baseline: StructuralBaseline;
  detectedOpenings: StructuralBaseline["openings"];
}): StructuralContinuityPrecheckResult {
  const detectedOpenings = Array.isArray(params.detectedOpenings) ? params.detectedOpenings : [];
  const baselineOpenings = Array.isArray(params.baseline?.openings) ? params.baseline.openings : [];
  if (detectedOpenings.length === 0 || baselineOpenings.length === 0) {
    return {
      passed: false,
      matchedReferenceOpenings: 0,
      wallRemap: new Map<number, number>(),
    };
  }

  const voteTable = new Map<number, Map<number, number>>();
  let matchedReferenceOpenings = 0;

  for (const candidate of detectedOpenings) {
    const reference = resolveBaselineReferenceOpening(candidate, baselineOpenings);
    if (!reference) continue;
    matchedReferenceOpenings += 1;

    const afterWall = Number(candidate.wallIndex);
    const baselineWall = Number(reference.wallIndex);
    if (!Number.isFinite(afterWall) || !Number.isFinite(baselineWall)) continue;

    const wallVotes = voteTable.get(afterWall) ?? new Map<number, number>();
    wallVotes.set(baselineWall, (wallVotes.get(baselineWall) ?? 0) + 1);
    voteTable.set(afterWall, wallVotes);
  }

  const wallRemap = new Map<number, number>();
  voteTable.forEach((votes, afterWall) => {
    const canonicalWall = pickTopVote(votes);
    if (canonicalWall === null) return;
    wallRemap.set(afterWall, canonicalWall);
  });

  const passed =
    matchedReferenceOpenings >= OPENING_ADDED_STRUCTURAL_PRECHECK_MIN_MATCHES &&
    wallRemap.size > 0;

  return {
    passed,
    matchedReferenceOpenings,
    wallRemap,
  };
}

export function extractStrongDeterministicAddedOpeningSignals(params: {
  baseline: StructuralBaseline;
  detectedOpenings: StructuralBaseline["openings"];
  hasAddedOpenings: boolean;
  matchedDetectedIds?: Set<string>;
  summary?: {
    openingSignatureMismatch?: boolean;
    openingBandMismatch?: boolean;
    openingRelocated?: boolean;
  };
  wallRemap?: Map<number, number>;
}): DeterministicAddedOpeningSignal[] {
  const hasTopologyChangeSignal =
    params.summary?.openingSignatureMismatch === true ||
    params.summary?.openingBandMismatch === true ||
    params.summary?.openingRelocated === true;
  if (!hasTopologyChangeSignal) return [];
  if (!params.hasAddedOpenings) return [];

  const baselineOpenings = Array.isArray(params.baseline?.openings) ? params.baseline.openings : [];
  return (params.detectedOpenings || [])
    .filter((opening) => !params.matchedDetectedIds?.has(String(opening.id)))
    .filter((opening) =>
      opening.type === "window" ||
      opening.type === "door" ||
      opening.type === "closet_door" ||
      opening.type === "walkthrough"
    )
    .filter((opening) => Number(opening.confidence || 0) >= OPENING_ADDED_STRONG_DETERMINISTIC_CONFIDENCE)
    .filter((opening) => Number(opening.area_pct || 0) >= 2)
    .filter((opening) => {
      const openingBox = normalizeBbox01(opening.bbox);
      const maxIoUWithBaseline = baselineOpenings.reduce((acc, base) => {
        const iou = bboxIoU(openingBox, normalizeBbox01(base.bbox));
        return Math.max(acc, iou);
      }, 0);
      return maxIoUWithBaseline <= 0.12;
    })
    .map((opening) => ({
      type: opening.type,
      wallIndex: opening.wallIndex,
      canonicalWallIndex: (params.wallRemap?.get(opening.wallIndex) ?? opening.wallIndex) as StructuralBaseline["openings"][number]["wallIndex"],
      horizontalBand: opening.horizontalBand,
      bbox: normalizeBbox01(opening.bbox),
      confidence: Number(opening.confidence || 0),
    }));
}

export function hasStableAddedOpeningConsensus(
  firstPassSignals: DeterministicAddedOpeningSignal[],
  secondPassSignals: DeterministicAddedOpeningSignal[]
): boolean {
  if (!Array.isArray(firstPassSignals) || !Array.isArray(secondPassSignals)) return false;
  if (firstPassSignals.length === 0 || secondPassSignals.length === 0) return false;

  return firstPassSignals.some((first) =>
    secondPassSignals.some((second) =>
      first.type === second.type &&
      first.canonicalWallIndex === second.canonicalWallIndex &&
      first.horizontalBand === second.horizontalBand &&
      bboxIoU(first.bbox, second.bbox) >= OPENING_ADDED_CONSENSUS_MIN_IOU
    )
  );
}

function buildOpeningRegions(openings: StructuralBaseline["openings"]): Array<{
  bbox: [number, number, number, number];
  type: "window" | "door";
}> {
  if (!Array.isArray(openings) || openings.length === 0) return [];
  return openings
    .map((opening) => {
      const mappedType = toOpeningRegionType(opening.type);
      if (!mappedType) return null;
      return {
        bbox: normalizeBbox01(opening.bbox),
        type: mappedType,
      };
    })
    .filter((region): region is { bbox: [number, number, number, number]; type: "window" | "door" } => region !== null);
}

function bboxToApproximateLocation(
  bbox?: [number, number, number, number]
): AdvisoryObservation["approximateLocation"] {
  if (!bbox) return undefined;
  const cx = (bbox[0] + bbox[2]) / 2;
  if (cx < 0.2) return "left";
  if (cx < 0.4) return "center-left";
  if (cx < 0.6) return "center";
  if (cx < 0.8) return "center-right";
  return "right";
}

function inferFindingIssueType(finding: OpeningDiagnosticFinding): string {
  if (finding.status === "infilled") return ISSUE_TYPES.OPENING_INFILLED;
  if (finding.status === "missing") return ISSUE_TYPES.OPENING_REMOVED;
  if (
    finding.machineReasons.includes("staging_occlusion_advisory") ||
    finding.machineReasons.includes("frame_boundary_truncation_advisory")
  ) {
    return ISSUE_TYPES.OPENING_OCCLUSION;
  }
  if (finding.machineReasons.includes("opening_type_changed")) return ISSUE_TYPES.OPENING_ANOMALY;
  if (finding.machineReasons.includes("wall_index_changed")) return ISSUE_TYPES.OPENING_RELOCATED;
  if (
    finding.machineReasons.includes("horizontal_band_changed") ||
    finding.machineReasons.includes("vertical_band_changed")
  ) {
    return ISSUE_TYPES.OPENING_RELOCATED;
  }
  if (finding.machineReasons.some((reason) =>
    reason === "wall_coverage_band_changed_gt_one" ||
    reason === "pane_structure_changed" ||
    reason === "orientation_changed" ||
    reason.startsWith("window_sill_shift_gt_") ||
    reason.startsWith("aperture_expanded_gt_")
  )) {
    return ISSUE_TYPES.OPENING_RESIZED_MINOR;
  }
  return ISSUE_TYPES.OPENING_ANOMALY;
}

function buildFindingContext(finding: OpeningDiagnosticFinding): string {
  if (finding.status === "infilled") {
    return "Local opening-preservation analysis could not match the baseline opening in this region and detected possible wall continuity where the opening previously existed.";
  }
  if (finding.status === "missing") {
    return "Local opening-preservation analysis could not match the baseline opening in this region in the AFTER image.";
  }
  if (finding.machineReasons.includes("wall_index_changed")) {
    return "Local opening-preservation analysis flagged this opening as potentially appearing on a different wall than in the original image.";
  }
  if (
    finding.machineReasons.includes("horizontal_band_changed") ||
    finding.machineReasons.includes("vertical_band_changed")
  ) {
    return "Local opening-preservation analysis flagged a possible shift in the opening's wall position.";
  }
  if (finding.machineReasons.includes("opening_type_changed")) {
    return "Local opening-preservation analysis flagged a possible change in the type of opening at this location.";
  }
  if (finding.machineReasons.includes("frame_boundary_truncation_advisory")) {
    return "Local opening-preservation analysis detected likely frame-boundary truncation near the image edge while preserving perceptual opening continuity.";
  }
  if (finding.machineReasons.includes("staging_occlusion_advisory")) {
    return "Local opening-preservation analysis detected partial staging occlusion with preserved opening geometry and location.";
  }
  if (finding.machineReasons.includes("semantic_anchor_erosion_advisory")) {
    return "Local opening-preservation analysis detected semantic anchor erosion (for example seam/handle cues) without decisive wall-replacement evidence.";
  }
  return "Local opening-preservation analysis flagged a possible structural difference for this baseline opening.";
}

function buildOpeningAdvisoryObservations(findings: OpeningDiagnosticFinding[]): AdvisoryObservation[] {
  return findings.map((finding) => ({
    category: "openings",
    validator: "openings",
    issueType: inferFindingIssueType(finding),
    location: finding.location,
    approximateLocation: bboxToApproximateLocation(finding.bbox),
    bbox: finding.bbox,
    confidence: finding.confidence,
    question: finding.question,
    context: buildFindingContext(finding),
    investigationTask: finding.question,
  }));
}

function buildOpeningExplanation(
  findings: OpeningDiagnosticFinding[],
  fallbackReason: string,
  summaryAnalysis?: string,
): string {
  if (findings.length > 0) {
    return findings.slice(0, 2).map((finding) => finding.explanation).join(" ");
  }
  if (summaryAnalysis && summaryAnalysis.trim().length > 0) {
    return summaryAnalysis.trim();
  }
  if (fallbackReason === "openings_preserved") {
    return "All baseline openings appear preserved.";
  }
  return fallbackReason.replace(/\|/g, ", ");
}

function toBaselineOpeningType(input: string): "window" | "door" | "closet_door" | "opening" {
  const value = String(input || "").toLowerCase();
  if (value === "window") return "window";
  if (value === "closet_door") return "closet_door";
  if (value === "door") return "door";
  return "opening";
}

function classifyBaselineVisibility(opening: StructuralBaseline["openings"][number]): "full" | "partial" {
  const [x1, y1, x2, y2] = normalizeBbox01(opening.bbox);
  const touchesImageEdge = x1 <= 0.01 || y1 <= 0.01 || x2 >= 0.99 || y2 >= 0.99;
  return touchesImageEdge ? "partial" : "full";
}

function classifyBaselineLocation(opening: StructuralBaseline["openings"][number]): "left" | "center" | "right" | "rear" | "unknown" {
  if (typeof opening.wallIndex === "number" && opening.wallIndex >= 2) return "rear";
  const [x1, , x2] = normalizeBbox01(opening.bbox);
  const cx = (x1 + x2) / 2;
  if (cx < 0.33) return "left";
  if (cx > 0.67) return "right";
  if (Number.isFinite(cx)) return "center";
  return "unknown";
}

function classifyBaselineSize(opening: StructuralBaseline["openings"][number]): "small" | "medium" | "large" | "unknown" {
  const area = Number(opening.area_pct);
  if (!Number.isFinite(area) || area <= 0) return "unknown";
  if (area < 0.03) return "small";
  if (area < 0.1) return "medium";
  return "large";
}

function extractBaselineOpenings(baseline?: StructuralBaseline | null): BaselineOpenings {
  if (!baseline || !Array.isArray(baseline.openings)) return { openings: [] };
  return {
    openings: baseline.openings.map((opening, index) => ({
      id: String(opening.id || `opening_${index + 1}`),
      type: toBaselineOpeningType(opening.type),
      visibility: classifyBaselineVisibility(opening),
      approximateLocation: classifyBaselineLocation(opening),
      size: classifyBaselineSize(opening),
    })),
  };
}

function inferIssueTypeFromComparison(params: {
  anyRemoved: boolean;
  anyAlteredMajor: boolean;
  anyRelocated: boolean;
}): ValidationIssueType {
  if (params.anyRemoved) return ISSUE_TYPES.OPENING_REMOVED;
  if (params.anyAlteredMajor) return ISSUE_TYPES.OPENING_RESIZED_MAJOR;
  if (params.anyRelocated) return ISSUE_TYPES.OPENING_ANOMALY;
  return ISSUE_TYPES.NONE;
}

function inferOpeningIssueType(params: {
  pass: boolean;
  hardFail: boolean;
  reason?: string;
  advisorySignals?: string[];
}): ValidationIssueType {
  if (params.pass) return ISSUE_TYPES.NONE;
  const tokens = splitIssueTokens(params.reason, params.advisorySignals);
  const has = (prefix: string): boolean => tokens.some((token) => token === prefix || token.startsWith(`${prefix}_`));

  if (has("opening_removed") || has("light_anchor_opening_removed")) return ISSUE_TYPES.OPENING_REMOVED;
  if (has("opening_infilled") || has("light_anchor_opening_infilled")) return ISSUE_TYPES.OPENING_INFILLED;
  if (has("opening_sealed")) return ISSUE_TYPES.OPENING_SEALED;
  if (has("opening_type_changed") || has("opening_class_mismatch") || has("opening_added")) return ISSUE_TYPES.OPENING_ANOMALY;
  if (has("opening_relocated") || has("light_anchor_opening_relocated")) return ISSUE_TYPES.OPENING_RELOCATED;
  if (has("opening_visibility_reduction")) return ISSUE_TYPES.OPENING_OCCLUSION;
  if (has("opening_size_reduction_ge") || has("opening_resize_ge_0_30")) return ISSUE_TYPES.OPENING_RESIZED_MAJOR;
  if (has("opening_resized")) return ISSUE_TYPES.OPENING_RESIZED_MINOR;
  if (has("window_occlusion") || has("door_or_closet_blocked") || has("occlusion")) return ISSUE_TYPES.OPENING_OCCLUSION;
  return params.hardFail ? ISSUE_TYPES.OPENING_RELOCATED : ISSUE_TYPES.OPENING_ANOMALY;
}

function mapOpeningTypeToStructuredObject(input?: string): string {
  if (input === "window") return "window";
  if (input === "door") return "door";
  if (input === "closet_door") return "closet_door";
  return "opening";
}

function buildOpeningStructuredIssues(params: {
  issueType: OpeningValidatorResult["issueType"];
  issueTier: OpeningValidatorResult["issueTier"];
  confidence: number;
  reason: string;
  advisorySignals: string[];
  objectHint?: string;
}): StructuredIssue[] {
  if (params.issueType === ISSUE_TYPES.NONE) return [];

  const tokens = splitIssueTokens(params.reason, params.advisorySignals);
  const evidence = Array.from(new Set(tokens.filter((token) => token && !token.startsWith("light_anchor_microcheck_analysis"))));
  const joined = evidence.join("|");

  const action = /(^|_)opening_removed($|_)|light_anchor_opening_removed/.test(joined)
    ? "removed"
    : /(^|_)opening_infilled($|_)|light_anchor_opening_infilled/.test(joined)
      ? "infilled"
      : /(^|_)opening_sealed($|_)/.test(joined)
        ? "sealed"
        : /(^|_)opening_added($|_)/.test(joined)
          ? "added"
          : /(^|_)opening_relocated($|_)|opening_relocated_review|light_anchor_opening_relocated/.test(joined)
            ? "relocated"
            : /(^|_)opening_resized($|_)|opening_size_reduction_ge|opening_resize_ge_0_30|opening_resized_minor/.test(joined)
              ? "resized"
              : /occlusion|door_or_closet_occluded_review|window_occlusion_review/.test(joined)
                ? "occluded"
                : "resized";

  return [createStructuredIssue({
    type: "opening_change",
    object: mapOpeningTypeToStructuredObject(params.objectHint),
    action,
    severity: mapIssueTierToSeverity(params.issueTier),
    source: "opening_validator",
    confidence: params.confidence,
    evidence,
  })];
}

export function parseOpeningResult(rawText: string): OpeningValidatorResult {
  const cleaned = String(rawText || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  let parsed: any;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    throw new Error("validator_error_invalid_json");
  }

  const passRaw = typeof parsed?.pass === "boolean"
    ? parsed.pass
    : typeof parsed?.ok === "boolean"
      ? parsed.ok
      : undefined;

  if (typeof passRaw !== "boolean") {
    throw new Error("validator_error_invalid_schema");
  }

  const details = Array.isArray(parsed?.details)
    ? parsed.details.map((entry: any, idx: number) => ({
        id: String(entry?.id || `opening_${idx + 1}`),
        classification: String(entry?.classification || "unknown").toLowerCase(),
        reason: String(entry?.reason || "").trim(),
      }))
    : [];

  const anyRemoved = details.some((entry: any) => entry.classification === "removed") || String(parsed?.issueType || "") === "opening_removed";
  const anyAlteredMajor = details.some((entry: any) => entry.classification === "altered") || String(parsed?.issueType || "") === "opening_altered";
  const anyOccluded = details.some((entry: any) => entry.classification === "occluded");
  const anyRelocated = details.some((entry: any) => entry.classification === "relocated") || /relocat/i.test(String(parsed?.reason || ""));

  const issueType = inferIssueTypeFromComparison({
    anyRemoved,
    anyAlteredMajor,
    anyRelocated,
  });
  const confidenceRaw = Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : 0.5;
  let confidence = clamp01(confidenceRaw);

  if (anyRemoved) {
    confidence = Math.max(0.9, confidence);
  } else if (anyAlteredMajor) {
    confidence = Math.max(0.8, Math.min(0.95, confidence || 0.85));
  } else if (anyRelocated) {
    confidence = Math.min(confidence || 0.6, 0.6);
  }

  // Occlusion alone is never a fail condition.
  const pass = anyRemoved || anyAlteredMajor
    ? false
    : anyOccluded
      ? true
      : passRaw;

  const reason = typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
    ? parsed.reason.trim()
    : pass
      ? anyRelocated ? "openings_preserved_with_relocation_review" : "openings_preserved"
      : anyRemoved
        ? "opening_removed"
        : "opening_altered";

  const advisorySignals = pass
    ? anyRelocated
      ? ["opening_relocation_review"]
      : []
    : [reason];

  // ── COHERENCE GATE (fallback path) ──
  const fallbackCoherent = isOpeningSignalCoherent({
    issueType: anyRemoved ? "opening_removed" : "none",
    allIssueTypes: [issueType],
    hasResize: false,
    hasOcclusion: anyOccluded,
    hasBandMismatch: false,
  });
  const hardFail = !pass && anyRemoved && confidence >= HARD_FAIL_CONFIDENCE_THRESHOLD && fallbackCoherent;
  const issueTier = classifyIssueTier(issueType);
  const structuredIssues = buildOpeningStructuredIssues({
    issueType,
    issueTier,
    confidence,
    reason,
    advisorySignals,
  });
  const comparisonResult = {
    pass,
    issueType,
    confidence,
    details,
    reason,
  };

  console.log("[OPENINGS_COMPARISON]", comparisonResult);

  return {
    status: pass ? "pass" : "fail",
    reason,
    confidence,
    hardFail,
    issueType,
    issueTier,
    advisorySignals,
    details,
    explanation: reason,
    primaryStructuredIssue: structuredIssues[0],
    structuredIssues,
  };
}

type OpeningLightAnchorVerdict = {
  openingInfilled: boolean;
  openingRemoved: boolean;
  openingRelocated: boolean;
  openingAdded: boolean;
  confidence: number;
  analysis: string;
};

function parseOpeningLightAnchorVerdict(rawText: string): OpeningLightAnchorVerdict {
  const cleaned = String(rawText || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  const parsed = JSON.parse(jsonCandidate || "{}");

  const confidenceRaw = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;

  return {
    openingInfilled: parsed?.openingInfilled === true,
    openingRemoved: parsed?.openingRemoved === true,
    openingRelocated: parsed?.openingRelocated === true,
    openingAdded: parsed?.openingAdded === true,
    confidence,
    analysis: typeof parsed?.analysis === "string" ? parsed.analysis.trim().slice(0, 160) : "",
  };
}

async function runOpeningLightAnchorMicroCheck(
  beforeImageUrl: string,
  afterImageUrl: string,
  jobId?: string,
  imageId?: string,
  attempt?: number,
): Promise<OpeningLightAnchorVerdict | null> {
  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;

  const prompt = `You are a fast structural opening spot-check validator.

Compare BEFORE vs AFTER for architectural openings.

HARD SEMANTIC DEFINITION:
An opening must be a penetrative architectural aperture in a wall plane
(window, door, closet door, walkthrough).

Do NOT classify the following as opening added/removed:
- Curtains or drapes
- Mirrors
- Artwork
- TV screens or reflections
- Bright lighting hotspots
- Glass cabinets
- Open shelving

GLOBAL LIGHT ANCHOR RULE:
Identify the primary exterior light-source opening in BEFORE
(large window/sliding door/glazed opening).

If in AFTER that region is no longer penetrative and appears as continuous wall,
or is replaced by decor/artwork/artificial light (lamp), set openingInfilled=true.

Do NOT treat as valid occlusion when the wall plane behind foreground objects
becomes continuous and opaque where an opening existed.

LEFT-TO-RIGHT WALL SEQUENCE RULE:
Compare opening sequence across each visible wall from left to right.
If an opening token disappears and the sequence becomes wall-continuous,
set openingRemoved=true (and openingInfilled=true when appropriate).

ADDED OPENING RULE (STRICT):
Set openingAdded=true only if AFTER shows a new penetrative architectural
aperture on a region that was continuous wall in BEFORE.
If uncertain, set openingAdded=false.

Return JSON only:
{
  "openingInfilled": boolean,
  "openingRemoved": boolean,
  "openingRelocated": boolean,
  "openingAdded": boolean,
  "confidence": number,
  "analysis": "short reason"
}`;

  const requestStartedAt = Date.now();
  const response = await (ai as any).models.generateContent({
    model: OPENING_LIGHT_ANCHOR_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { text: "IMAGE_BEFORE:" },
          { inlineData: { mimeType: "image/webp", data: before } },
          { text: "IMAGE_AFTER:" },
          { inlineData: { mimeType: "image/webp", data: after } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0,
      maxOutputTokens: 180,
      responseMimeType: "application/json",
    },
  });
  logGeminiUsage({
    ctx: {
      jobId: jobId || "",
      imageId: imageId || "",
      stage: "validator",
      attempt: Number.isFinite(attempt) ? Number(attempt) : 1,
    },
    model: OPENING_LIGHT_ANCHOR_MODEL,
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
  });

  const rawText = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  try {
    return parseOpeningLightAnchorVerdict(rawText);
  } catch {
    return null;
  }
}

export function buildOpeningValidatorDecision(params: {
  hardFail: boolean;
  deterministicHardFailIssue: boolean;
  hasHighConfidenceMicroHardFailSignal: boolean;
  addedHardFailCorroborated: boolean;
  openingAddedConsensusUnstable: boolean;
  openingAddedStructuralContinuityUnresolved: boolean;
  reasonParts: string[];
  advisorySignals: string[];
  vetoed?: boolean;
}): OpeningValidatorDecision {
  const signals = uniqueTokens([
    ...params.reasonParts,
    ...params.advisorySignals,
  ]);

  const authority = params.hardFail
    ? params.addedHardFailCorroborated
      ? "deterministic_added_opening"
      : params.hasHighConfidenceMicroHardFailSignal
        ? "light_anchor_corroborated"
        : params.deterministicHardFailIssue
          ? "deterministic_opening_break"
          : "deterministic_hard_fail"
    : params.openingAddedStructuralContinuityUnresolved || params.openingAddedConsensusUnstable
      ? "added_opening_advisory"
      : signals.length > 0
        ? "advisory"
        : "preserved";

  const decision = params.hardFail
    ? "hard_fail"
    : signals.length > 0
      ? "advisory"
      : "pass";

  const policy = resolveOpeningAuthorityPolicy(authority);
  const authorityClass = policy.authorityClass;
  const vetoable = policy.vetoable;
  const vetoed = params.vetoed === true;

  assertOpeningAuthorityInvariants({
    authority,
    policy,
    decision,
    vetoable,
    vetoed,
  });

  const decisionTrace = buildOpeningDecisionTrace({
    authority,
    authorityClass,
    decision,
    vetoable,
    vetoed,
    deterministicHardFailIssue: params.deterministicHardFailIssue,
    hasHighConfidenceMicroHardFailSignal: params.hasHighConfidenceMicroHardFailSignal,
    addedHardFailCorroborated: params.addedHardFailCorroborated,
    openingAddedConsensusUnstable: params.openingAddedConsensusUnstable,
    openingAddedStructuralContinuityUnresolved: params.openingAddedStructuralContinuityUnresolved,
    reasonParts: params.reasonParts,
    advisorySignals: params.advisorySignals,
  });

  return {
    decision,
    authorityClass,
    authority,
    vetoable,
    signals,
    decisionTrace,
    trace: decisionTrace,
    semanticCorroborated: params.addedHardFailCorroborated || params.hasHighConfidenceMicroHardFailSignal,
    vetoed,
  };
}

function attachStructuredDecision(result: OpeningValidatorResult): OpeningValidatorResult {
  const reasonParts = splitIssueTokens(result.reason || "");
  const advisorySignals = Array.isArray(result.advisorySignals) ? result.advisorySignals : [];
  const hardFail = result.hardFail === true;
  const deterministicHardFailIssue = hardFail;
  const hasHighConfidenceMicroHardFailSignal = reasonParts.includes("light_anchor_opening_infilled") || reasonParts.includes("light_anchor_opening_removed");
  const addedHardFailCorroborated = reasonParts.includes("light_anchor_opening_added_confirmed");

  return {
    ...result,
    decision: buildOpeningValidatorDecision({
      hardFail,
      deterministicHardFailIssue,
      hasHighConfidenceMicroHardFailSignal,
      addedHardFailCorroborated,
      openingAddedConsensusUnstable: advisorySignals.includes("opening_added_consensus_unstable"),
      openingAddedStructuralContinuityUnresolved: advisorySignals.includes("opening_added_structural_continuity_unresolved"),
      reasonParts,
      advisorySignals,
    }),
  };
}

export async function runOpeningValidator(
  beforeImageUrl: string,
  afterImageUrl: string,
  options?: {
    jobId?: string;
    imageId?: string;
    attempt?: number;
    microChecks?: boolean;
    /** Pre-extracted structural baseline. When provided, skips re-extraction (saves a Gemini call). */
    baseline?: StructuralBaseline;
    /** Pre-extracted candidate graph. When provided, skips AFTER re-extraction and freezes graph inputs. */
    detectedBaseline?: StructuralBaseline;
  }
): Promise<OpeningValidatorResult> {
  const openingValidatorStartedAt = Date.now();
  logOpeningInstrumentation("OPENING_VALIDATOR_START", {
    jobId: options?.jobId || "unknown",
    validator: "opening",
    phase: "validator_total",
    durationMs: 0,
  });
  if (!String(beforeImageUrl || "").trim() || !String(afterImageUrl || "").trim()) {
    throw new Error("VALIDATION_INPUT_MISSING");
  }

  logOpeningPhaseStart(options?.jobId, "baseline_retrieval");
  const baselineStartedAt = Date.now();
  const baseline = options?.baseline ?? await extractStructuralBaseline(beforeImageUrl, {
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: options?.attempt,
  });
  logOpeningPhaseEnd(options?.jobId, "baseline_retrieval", Date.now() - baselineStartedAt, {
    skipped: options?.baseline ? true : false,
  });
  const baselineOpenings = extractBaselineOpenings(baseline);
  console.log("[OPENINGS_BASELINE]", baselineOpenings);

  try {
  if (Array.isArray(baseline.openings) && baseline.openings.length > 0) {
    logOpeningPhaseStart(options?.jobId, "image_load", { skipped: true });
    logOpeningPhaseEnd(options?.jobId, "image_load", 0, { skipped: true });
    logOpeningPhaseStart(options?.jobId, "image_decode", { skipped: true });
    logOpeningPhaseEnd(options?.jobId, "image_decode", 0, { skipped: true });
    logOpeningPhaseStart(options?.jobId, "image_resize", { skipped: true });
    logOpeningPhaseEnd(options?.jobId, "image_resize", 0, { skipped: true });

    logOpeningPhaseStart(options?.jobId, "opening_extraction");
    const openingExtractionStartedAt = Date.now();
    logOpeningGeminiStart(options?.jobId, "opening-baseline-extraction", "opening_extraction");
    const frozenCandidateGraph = options?.detectedBaseline ?? await extractStructuralBaseline(afterImageUrl, {
      jobId: options?.jobId,
      imageId: options?.imageId,
      attempt: options?.attempt,
    });
    logOpeningGeminiEnd(options?.jobId, "opening-baseline-extraction", "opening_extraction", Date.now() - openingExtractionStartedAt);
    logOpeningPhaseEnd(options?.jobId, "opening_extraction", Date.now() - openingExtractionStartedAt, {
      skipped: options?.detectedBaseline ? true : false,
    });

    logOpeningPhaseStart(options?.jobId, "structural_extraction");
    logOpeningPhaseStart(options?.jobId, "reconciliation");
    const reconciliationStartedAt = Date.now();
    logOpeningGeminiStart(options?.jobId, "opening-structural-validate", "structural_extraction");
    const deterministic = await validateOpeningPreservation(baseline, afterImageUrl, {
      jobId: options?.jobId,
      imageId: options?.imageId,
      attempt: options?.attempt,
      detectedBaseline: frozenCandidateGraph,
    });
    logOpeningGeminiEnd(options?.jobId, "opening-structural-validate", "structural_extraction", Date.now() - reconciliationStartedAt);
    logOpeningPhaseEnd(options?.jobId, "structural_extraction", Date.now() - reconciliationStartedAt);
    logOpeningPhaseEnd(options?.jobId, "reconciliation", Date.now() - reconciliationStartedAt);
    const relocationDetected = detectRelocation(baseline, deterministic.detectedOpenings || []);
    const detectedById = new Map((deterministic.detectedOpenings || []).map((opening) => [String(opening.id), opening]));

    const areaDelta = Number.isFinite(deterministic.summary.semanticOpeningAreaDeltaPct)
      ? Number(deterministic.summary.semanticOpeningAreaDeltaPct)
      : 0;
    let maxSizeReductionDelta = 0;
    const openingSizeReductionAdvisoryThreshold = Math.max(0.1, OPENING_SIZE_REDUCTION_HARD_FAIL_THRESHOLD * 0.5);
    let openingSizeReductionDetected = false;

    const hasAddedOpenings =
      Number(deterministic.summary.openingCount?.after || 0) >
      Number(deterministic.summary.openingCount?.before || 0);
    const baselineGraphStable = baseline.graphMeta?.graphStable === true;
    const candidateGraphStable = Boolean(frozenCandidateGraph.graphMeta?.graphStable);
    const baselineGraphConfidence = Number(baseline.graphMeta?.graphConfidence ?? baseline.graphMeta?.extractionAgreement ?? 0);
    const candidateGraphConfidence = Number(frozenCandidateGraph.graphMeta?.graphConfidence ?? frozenCandidateGraph.graphMeta?.extractionAgreement ?? 0);
    const openingGraphStable = baselineGraphStable && candidateGraphStable;
    const openingGraphConfidence = Math.min(baselineGraphConfidence, candidateGraphConfidence);
    const authoritativeAddedOpenings =
      hasAddedOpenings &&
      openingGraphStable &&
      openingGraphConfidence >= Number(process.env.OPENING_ADDED_GRAPH_MIN_CONFIDENCE || 0.67);

    const firstPassContinuity = runStructuralContinuityPrecheck({
      baseline,
      detectedOpenings: deterministic.detectedOpenings || [],
    });
    const firstPassAddedSignals = extractStrongDeterministicAddedOpeningSignals({
      baseline,
      detectedOpenings: deterministic.detectedOpenings || [],
      hasAddedOpenings: authoritativeAddedOpenings,
      wallRemap: firstPassContinuity.wallRemap,
      matchedDetectedIds: new Set((deterministic.reconciledMatches || []).map((entry) => String(entry.detectedId))),
      summary: deterministic.summary,
    });
    let deterministicStrongAddedOpening = false;
    let openingAddedConsensusUnstable = false;
    let openingAddedStructuralContinuityUnresolved = false;
    if (authoritativeAddedOpenings && firstPassAddedSignals.length > 0) {
      const deterministicSecondPass = await validateOpeningPreservation(baseline, afterImageUrl, {
        jobId: options?.jobId,
        imageId: options?.imageId,
        attempt: options?.attempt,
        detectedBaseline: frozenCandidateGraph,
      });
      const secondPassContinuity = runStructuralContinuityPrecheck({
        baseline,
        detectedOpenings: deterministicSecondPass.detectedOpenings || [],
      });
      const secondPassAddedSignals = extractStrongDeterministicAddedOpeningSignals({
        baseline,
        detectedOpenings: deterministicSecondPass.detectedOpenings || [],
        hasAddedOpenings:
          Number(deterministicSecondPass.summary.openingCount?.after || 0) >
          Number(deterministicSecondPass.summary.openingCount?.before || 0),
        wallRemap: secondPassContinuity.wallRemap,
        matchedDetectedIds: new Set((deterministicSecondPass.reconciledMatches || []).map((entry) => String(entry.detectedId))),
        summary: deterministicSecondPass.summary,
      });
      const structuralContinuityPassed = firstPassContinuity.passed && secondPassContinuity.passed;
      if (!structuralContinuityPassed) {
        openingAddedStructuralContinuityUnresolved = true;
        console.log("[OPENING_ADDED_PRECHECK_UNRESOLVED]", {
          jobId: options?.jobId,
          imageId: options?.imageId,
          firstPassMatchedReferenceOpenings: firstPassContinuity.matchedReferenceOpenings,
          secondPassMatchedReferenceOpenings: secondPassContinuity.matchedReferenceOpenings,
          firstPassWallRemapSize: firstPassContinuity.wallRemap.size,
          secondPassWallRemapSize: secondPassContinuity.wallRemap.size,
          action: "added_opening_advisory_only",
        });
      }
      deterministicStrongAddedOpening = structuralContinuityPassed && hasStableAddedOpeningConsensus(
        firstPassAddedSignals,
        secondPassAddedSignals,
      );
      if (!deterministicStrongAddedOpening) {
        openingAddedConsensusUnstable = true;
        console.log("[OPENING_ADDED_CONSENSUS_UNSTABLE]", {
          jobId: options?.jobId,
          imageId: options?.imageId,
          firstPassCandidates: firstPassAddedSignals.length,
          secondPassCandidates: secondPassAddedSignals.length,
          action: "added_opening_advisory_only",
        });
      } else {
        console.log("[OPENING_ADDED_CONSENSUS_CONFIRMED]", {
          jobId: options?.jobId,
          imageId: options?.imageId,
          firstPassCandidates: firstPassAddedSignals.length,
          secondPassCandidates: secondPassAddedSignals.length,
          action: "eligible_for_gemini_corroboration",
        });
      }
    }

    // Partial occlusion from staging (furniture, decor, camera angle)
    // is allowed. Structural preservation hard-fails only when the opening is
    // removed, infilled, sealed, or a new opening is authoritatively added.
    // Class mismatch remains visible for diagnostics and Unified context, but
    // does not independently trigger authoritative failure.
    const hasStrongStructuralOpeningEvidence =
      deterministic.summary.openingRemoved ||
      deterministic.summary.openingInfilled ||
      deterministic.summary.openingSealed ||
      authoritativeAddedOpenings;

    let strictDoorOcclusionFail = false;
    let strictWindowOcclusionFail = false;

    logOpeningPhaseStart(options?.jobId, "geometry_comparison");
    const geometryComparisonStartedAt = Date.now();
    for (const baseOpening of baseline.openings || []) {
      const matchedOpening =
        detectedById.get(String(baseOpening.id)) ||
        (deterministic.detectedOpenings || []).find((candidate) =>
          candidate.type === baseOpening.type &&
          candidate.wallIndex === baseOpening.wallIndex &&
          candidate.horizontalBand === baseOpening.horizontalBand
        );

      if (!matchedOpening) continue;

      const baseArea = Math.max(0.01, Number(baseOpening.area_pct || 0));
      const detectedArea = Math.max(0.01, Number(matchedOpening.area_pct || 0));
      const retention = detectedArea / baseArea;
      const sizeReduction = clamp01((baseArea - detectedArea) / baseArea);

      maxSizeReductionDelta = Math.max(maxSizeReductionDelta, sizeReduction);
      if (sizeReduction >= openingSizeReductionAdvisoryThreshold) {
        openingSizeReductionDetected = true;
      }
      // Non-window openings (doors/closets/walkthroughs) must remain functionally usable.
      // Minor perspective overlap can be tolerated when usability is preserved.
      if (baseOpening.type !== "window") {
        if (retention < 0.9) {
          const isFunctionallyBlocked = evaluateDoorFunctionalBlockage(baseOpening, matchedOpening, retention);
          const extremeOcclusion = retention < OPENING_DOOR_EXTREME_OCCLUSION_RETENTION;
          if (isFunctionallyBlocked || (extremeOcclusion && hasStrongStructuralOpeningEvidence)) {
            strictDoorOcclusionFail = true;
          }
        }
      } else {
        // Window partial occlusion can be tolerated only when clearly partial.
        // Near-full occlusion only fails when structural or semantic change evidence is present.
        if (
          retention < OPENING_WINDOW_MIN_RETENTION &&
          retention < OPENING_WINDOW_EXTREME_OCCLUSION_RETENTION &&
          hasStrongStructuralOpeningEvidence
        ) {
          strictWindowOcclusionFail = true;
        }
      }
    }

    logOpeningPhaseEnd(options?.jobId, "geometry_comparison", Date.now() - geometryComparisonStartedAt);

    const openingRegions = buildOpeningRegions(deterministic.detectedOpenings || []);
    const rawDeterministicHardFailSignal =
      deterministic.summary.openingRemoved ||
      deterministic.summary.openingInfilled ||
      deterministic.summary.openingSealed ||
      authoritativeAddedOpenings;

    const findings = Array.isArray(deterministic.findings) ? deterministic.findings : [];
    const missingOrInfilledFindings = findings.filter((finding) =>
      finding.status === "missing" || finding.status === "infilled"
    );
    const persistentUnmatchedOpeningEvidence = missingOrInfilledFindings.some((finding) => finding.confidence >= 0.9);
    const strongContinuityBreakEvidence = missingOrInfilledFindings.some((finding) =>
      finding.machineReasons.includes("opening_replaced_by_wall_continuity") ||
      finding.machineReasons.includes("missing_opening")
    );
    const strongFrameDestructionEvidence = missingOrInfilledFindings.some((finding) =>
      finding.machineReasons.includes("opening_replaced_by_wall_continuity")
    );
    const strongCrossAnchorInconsistency =
      deterministic.summary.openingSignatureMismatch === true &&
      deterministic.summary.openingRelocated === true;
    const strongBandCorroboration =
      deterministic.summary.openingBandMismatch &&
      (deterministic.summary.openingRelocated || deterministic.summary.openingApertureExpanded === true);
    const strongTopologyBreakEvidence =
      deterministic.summary.openingRemoved ||
      deterministic.summary.openingApertureExpanded === true ||
      deterministic.summary.openingStateChanged === true ||
      authoritativeAddedOpenings;
    const deterministicStructuralCorroborated =
      strongTopologyBreakEvidence ||
      strongContinuityBreakEvidence ||
      strongBandCorroboration ||
      strongCrossAnchorInconsistency ||
      strongFrameDestructionEvidence ||
      persistentUnmatchedOpeningEvidence;

    const deterministicHardFailIssue =
      rawDeterministicHardFailSignal && deterministicStructuralCorroborated;

    const deterministicHardFailButOcclusionSusceptible =
      rawDeterministicHardFailSignal &&
      !deterministicHardFailIssue &&
      (
        openingSizeReductionDetected ||
        strictDoorOcclusionFail ||
        strictWindowOcclusionFail ||
        deterministic.summary.stagingOcclusionAdvisory === true ||
        deterministic.summary.frameBoundaryTruncationAdvisory === true ||
        deterministic.summary.semanticAnchorErosionAdvisory === true
      );

    const reasonParts: string[] = [];
    const advisorySignals: string[] = [];

    const strongRemovedEvidence = deterministic.summary.openingRemoved && (
      missingOrInfilledFindings.some((finding) => finding.status === "missing") ||
      strongContinuityBreakEvidence
    );
    const strongInfilledEvidence = deterministic.summary.openingInfilled && (
      missingOrInfilledFindings.some((finding) =>
        finding.status === "infilled" && finding.machineReasons.includes("opening_replaced_by_wall_continuity")
      ) ||
      strongFrameDestructionEvidence
    );

    if (strongRemovedEvidence) {
      reasonParts.push("opening_removed");
    } else if (deterministic.summary.openingRemoved) {
      advisorySignals.push("opening_loss_unconfirmed");
    }

    if (strongInfilledEvidence) {
      reasonParts.push("opening_infilled");
    } else if (deterministic.summary.openingInfilled) {
      advisorySignals.push("opening_fill_unconfirmed");
    }

    if (deterministic.summary.openingSealed && (strongRemovedEvidence || strongInfilledEvidence)) {
      reasonParts.push("opening_sealed");
    } else if (deterministic.summary.openingSealed) {
      advisorySignals.push("opening_seal_unconfirmed");
    }

    if (deterministic.summary.openingClassMismatch) {
      advisorySignals.push("opening_class_mismatch_advisory");
      advisorySignals.push(`opening_class_mismatch_enforcement:${deterministic.summary.openingClassMismatchEnforcement}`);
      reasonParts.push("opening_type_changed");
      reasonParts.push("opening_class_mismatch");
    }
    if (hasAddedOpenings) reasonParts.push("opening_added");
    if (hasAddedOpenings && !authoritativeAddedOpenings) {
      advisorySignals.push("opening_added_graph_stability_unconfirmed");
      advisorySignals.push(`opening_added_graph_confidence:${openingGraphConfidence.toFixed(3)}`);
      openingAddedConsensusUnstable = true;
    }
    if (deterministic.summary.openingRelocated || relocationDetected) {
      advisorySignals.push("opening_relocated_review");
      reasonParts.push("opening_relocated_review");
    }
    if (openingAddedConsensusUnstable) {
      advisorySignals.push("opening_added_consensus_unstable");
    }
    if (openingAddedStructuralContinuityUnresolved) {
      advisorySignals.push("opening_added_structural_continuity_unresolved");
    }
    if (deterministic.summary.openingResized) {
      reasonParts.push("opening_resized");
    }
    if (openingSizeReductionDetected && maxSizeReductionDelta > 0) {
      advisorySignals.push(`opening_visibility_reduction:${maxSizeReductionDelta.toFixed(3)}`);
      advisorySignals.push(`opening_resized_minor:${maxSizeReductionDelta.toFixed(3)}`);
      if (deterministic.summary.openingResized && maxSizeReductionDelta >= OPENING_SIZE_REDUCTION_HARD_FAIL_THRESHOLD) {
        reasonParts.push(`opening_size_reduction_ge_${OPENING_SIZE_REDUCTION_HARD_FAIL_THRESHOLD.toFixed(2)}:${maxSizeReductionDelta.toFixed(3)}`);
      }
    }
    if (deterministic.summary.openingBandMismatch) reasonParts.push("opening_band_mismatch");
    if ((deterministic.summary as any).openingSignatureMismatch === true) {
      advisorySignals.push("opening_signature_mismatch");
    }
    if ((deterministic.summary as any).stagingOcclusionAdvisory === true) {
      advisorySignals.push("staging_occlusion_advisory");
    }
    if ((deterministic.summary as any).frameBoundaryTruncationAdvisory === true) {
      advisorySignals.push("frame_boundary_truncation_advisory");
    }
    if ((deterministic.summary as any).semanticAnchorErosionAdvisory === true) {
      advisorySignals.push("semantic_anchor_erosion_advisory");
    }
    if (strictDoorOcclusionFail) advisorySignals.push("door_or_closet_occluded_review");
    if (strictWindowOcclusionFail) advisorySignals.push("window_occlusion_review");

    const microCheckRisk =
      (!deterministicHardFailIssue || deterministicHardFailButOcclusionSusceptible) && (
        deterministicHardFailButOcclusionSusceptible ||
        deterministic.summary.openingResized ||
        areaDelta >= 0.25
      );

    const baseConfidence = Number(deterministic.summary.confidence || 0);
    let hardFailConfidence = baseConfidence;
    let hardFail = deterministicHardFailIssue && hardFailConfidence >= HARD_FAIL_CONFIDENCE_THRESHOLD;
    let microCheck: OpeningLightAnchorVerdict | null = null;
    const getMicroCheck = async (): Promise<OpeningLightAnchorVerdict | null> => {
      if (microCheck !== null) return microCheck;
      if (options?.microChecks === false) {
        microCheck = null;
        return microCheck;
      }
      const microCheckStartedAt = Date.now();
      logOpeningGeminiStart(options?.jobId, OPENING_LIGHT_ANCHOR_MODEL, "micro_check");
      microCheck = await runOpeningLightAnchorMicroCheck(
        beforeImageUrl,
        afterImageUrl,
        options?.jobId,
        options?.imageId,
        options?.attempt,
      );
      logOpeningGeminiEnd(options?.jobId, OPENING_LIGHT_ANCHOR_MODEL, "micro_check", Date.now() - microCheckStartedAt);
      return microCheck;
    };

    if (microCheckRisk) {
      const micro = await getMicroCheck();
      if (micro && Number.isFinite(micro.confidence)) {
        hardFailConfidence = Math.max(hardFailConfidence, Number(micro.confidence));
      }
      if (micro && micro.confidence >= 0.8 && (micro.openingInfilled || micro.openingRemoved || micro.openingRelocated)) {
        if (micro.openingInfilled || micro.openingRemoved) {
          reasonParts.push(
            micro.openingInfilled
              ? "light_anchor_opening_infilled"
              : "light_anchor_opening_removed"
          );
        } else {
          advisorySignals.push("light_anchor_opening_relocated_review");
          reasonParts.push("light_anchor_opening_relocated_review");
        }
        advisorySignals.push(`light_anchor_microcheck_confidence:${micro.confidence.toFixed(3)}`);
        if (micro.analysis) {
          advisorySignals.push(`light_anchor_microcheck_analysis:${micro.analysis.replace(/\|/g, "/")}`);
        }
        if (micro.openingAdded) {
          advisorySignals.push("light_anchor_opening_added_review");
        }
      }
    }

    if (deterministicHardFailButOcclusionSusceptible) {
      advisorySignals.push("opening_occlusion_susceptible_requires_semantic_review");
      console.log("[OPENING_OCCLUSION_SUSCEPTIBLE_PATH]", {
        jobId: options?.jobId,
        imageId: options?.imageId,
        attempt: options?.attempt,
        rawDeterministicHardFailSignal,
        deterministicStructuralCorroborated,
        openingSizeReductionDetected,
        strictDoorOcclusionFail,
        strictWindowOcclusionFail,
        stagingOcclusionAdvisory: deterministic.summary.stagingOcclusionAdvisory === true,
        frameBoundaryTruncationAdvisory: deterministic.summary.frameBoundaryTruncationAdvisory === true,
        semanticAnchorErosionAdvisory: deterministic.summary.semanticAnchorErosionAdvisory === true,
        action: "run_microcheck_before_non_vetoable_escalation",
      });
    }

    const hasHighConfidenceMicroHardFailSignal = reasonParts.some((part) =>
      part === "light_anchor_opening_infilled" || part === "light_anchor_opening_removed"
    );
    const addedHardFailCorroborated = reasonParts.includes("light_anchor_opening_added_confirmed");

    if (!hardFail && deterministicStrongAddedOpening) {
      const addedCorroboration = await getMicroCheck();
      if (
        addedCorroboration &&
        Number.isFinite(addedCorroboration.confidence) &&
        addedCorroboration.confidence >= OPENING_ADDED_MICRO_CORROBORATION_CONFIDENCE &&
        addedCorroboration.openingAdded
      ) {
        hardFail = true;
        hardFailConfidence = Math.max(hardFailConfidence, Number(addedCorroboration.confidence));
        reasonParts.push("light_anchor_opening_added_confirmed");
        advisorySignals.push(`light_anchor_added_corroboration_confidence:${addedCorroboration.confidence.toFixed(3)}`);
        if (addedCorroboration.analysis) {
          advisorySignals.push(`light_anchor_added_corroboration_analysis:${addedCorroboration.analysis.replace(/\|/g, "/")}`);
        }
        console.log("[OPENING_ADDED_HARD_FAIL_CORROBORATED]", {
          jobId: options?.jobId,
          imageId: options?.imageId,
          deterministicStrongAddedOpening,
          corroborationConfidence: addedCorroboration.confidence,
          action: "hard_fail_added_opening",
        });
      } else if (addedCorroboration?.openingAdded) {
        advisorySignals.push("light_anchor_opening_added_review");
        advisorySignals.push(`light_anchor_added_unconfirmed_confidence:${addedCorroboration.confidence.toFixed(3)}`);
        console.log("[OPENING_ADDED_ADVISORY_ONLY]", {
          jobId: options?.jobId,
          imageId: options?.imageId,
          deterministicStrongAddedOpening,
          corroborationConfidence: addedCorroboration?.confidence,
          action: "added_opening_advisory_only",
        });
      }
    }

    // ── COHERENCE GATE: only hard-fail when signals are internally consistent ──
    const primaryIssueType = deterministic.summary.openingRemoved
      ? "opening_removed"
      : deterministic.summary.openingInfilled
        ? "opening_infilled"
        : deterministic.summary.openingSealed
          ? "opening_sealed"
          : "none";

    const coherenceAnalysis = analyzeOpeningSignalCoherence({
      issueType: primaryIssueType,
      allIssueTypes: reasonParts,
      hasResize: openingSizeReductionDetected || !!deterministic.summary.openingResized,
      hasOcclusion: strictDoorOcclusionFail || strictWindowOcclusionFail,
      hasBandMismatch: !!deterministic.summary.openingBandMismatch,
    });
    const signalCoherent = coherenceAnalysis.coherent || addedHardFailCorroborated;

    const deterministicEscalationEligible =
      deterministicHardFailIssue &&
      (deterministicStructuralCorroborated || hasHighConfidenceMicroHardFailSignal || addedHardFailCorroborated);

    hardFail = (deterministicEscalationEligible || hasHighConfidenceMicroHardFailSignal || addedHardFailCorroborated) &&
      hardFailConfidence >= HARD_FAIL_CONFIDENCE_THRESHOLD &&
      signalCoherent;

    if (
      signalCoherent &&
      coherenceAnalysis.primaryDestructiveStates.length > 0 &&
      coherenceAnalysis.supportiveModifiers.length > 0
    ) {
      console.log("[OPENING_COHERENCE_REINFORCED]", {
        primaryIssueType,
        destructiveStates: coherenceAnalysis.primaryDestructiveStates,
        supportiveModifiers: coherenceAnalysis.supportiveModifiers,
        contextualUncertainty: coherenceAnalysis.contextualUncertainty,
        action: "accept_destructive_bundle",
      });
    }

    if (!signalCoherent && (deterministicHardFailIssue || hasHighConfidenceMicroHardFailSignal || addedHardFailCorroborated) && hardFailConfidence >= HARD_FAIL_CONFIDENCE_THRESHOLD) {
      advisorySignals.push("opening_signal_incoherent_downgraded");
      console.log("[OPENING_COHERENCE_DOWNGRADE]", {
        primaryIssueType,
        reasonParts,
        hasResize: openingSizeReductionDetected || !!deterministic.summary.openingResized,
        hasOcclusion: strictDoorOcclusionFail || strictWindowOcclusionFail,
        hasBandMismatch: !!deterministic.summary.openingBandMismatch,
        contradictions: coherenceAnalysis.contradictions,
        contextualUncertainty: coherenceAnalysis.contextualUncertainty,
        action: "downgrade_to_advisory",
      });
    }

    if (reasonParts.length === 0) reasonParts.push("openings_preserved");
    const reason = reasonParts.join("|");
    const validatorDecision = buildOpeningValidatorDecision({
      hardFail,
      deterministicHardFailIssue,
      hasHighConfidenceMicroHardFailSignal,
      addedHardFailCorroborated,
      openingAddedConsensusUnstable,
      openingAddedStructuralContinuityUnresolved,
      reasonParts,
      advisorySignals,
    });
    const advisoryObservations = buildOpeningAdvisoryObservations(findings);
    const explanation = buildOpeningExplanation(findings, reason, deterministic.summary.analysis);
    const relocationOnly = !hardFail && (deterministic.summary.openingRelocated || relocationDetected);
    const hasAdvisoryIssue = reason !== "openings_preserved" || advisorySignals.length > 0;
    const issueType = hasAdvisoryIssue
      ? inferOpeningIssueType({
          pass: false,
          hardFail,
          reason,
          advisorySignals,
        })
      : ISSUE_TYPES.NONE;
    const issueTier = classifyIssueTier(issueType);
    const findingById = new Map(findings.map((finding) => [finding.id, finding]));
    const comparisonResult = {
      pass: !hardFail,
      issueType,
      confidence: relocationOnly
        ? Math.min(baseConfidence, 0.6)
        : hardFailConfidence,
      reason,
      openingClassMismatchTelemetry: {
        value: deterministic.summary.openingClassMismatch === true,
        enforcement: deterministic.summary.openingClassMismatchEnforcement,
      },
      details: baselineOpenings.openings.map((opening) => ({
        id: opening.id,
        classification: findingById.has(opening.id)
          ? ((): OpeningValidatorDetail["classification"] => {
              const finding = findingById.get(opening.id)!;
              if (finding.status === "missing" || finding.status === "infilled") return "removed";
              if (finding.machineReasons.includes("wall_index_changed")) return "relocated";
              return "altered";
            })()
          : hardFail
            ? reason.includes("opening_removed") || reason.includes("opening_infilled") || reason.includes("opening_sealed")
              ? "removed"
              : reason.includes("opening_type_changed") ||
                reason.includes("opening_class_mismatch") ||
                reason.includes("opening_added") ||
                reason.includes("opening_size_reduction") ||
                reason.includes("opening_resized")
                ? "altered"
                : "present"
            : reason.includes("occlusion")
              ? "occluded"
              : "present",
        reason: findingById.get(opening.id)?.machineReasons.join("|") || reason,
        explanation: findingById.get(opening.id)?.explanation,
        location: findingById.get(opening.id)?.location,
        machineReasons: findingById.get(opening.id)?.machineReasons,
        question: findingById.get(opening.id)?.question,
      })),
      explanation,
    };
    const primaryFinding = findings[0];
    const structuredIssues = buildOpeningStructuredIssues({
      issueType,
      issueTier,
      confidence: comparisonResult.confidence,
      reason,
      advisorySignals,
      objectHint: primaryFinding?.openingType,
    });

    console.log("[OPENINGS_COMPARISON]", comparisonResult);
    console.log("[SPECIALIST_REVIEW][OPENING]", {
      hardFail,
      deterministicHardFailIssue,
      hardFailConfidence: hardFailConfidence.toFixed(3),
      hasHighConfidenceMicroHardFailSignal,
      reason,
      structuralSignalCount: deterministic.structuralSignals?.length ?? 0,
      openingClassMismatchTelemetry: {
        value: deterministic.summary.openingClassMismatch === true,
        enforcement: deterministic.summary.openingClassMismatchEnforcement,
      },
    });

    logOpeningPhaseStart(options?.jobId, "decision_generation");
    const decisionGenerationStartedAt = Date.now();
    const decisionResult: OpeningValidatorResult = {
      status: hardFail ? "fail" as const : "pass" as const,
      reason,
      confidence: comparisonResult.confidence,
      hardFail,
      issueType,
      issueTier,
      advisorySignals,
      explanation,
      findings,
      advisoryObservations,
      details: comparisonResult.details,
      structuralSignals: deterministic.structuralSignals,
      decision: validatorDecision,
      openingRegions,
      primaryStructuredIssue: structuredIssues[0],
      structuredIssues,
    };
    logOpeningPhaseEnd(options?.jobId, "decision_generation", Date.now() - decisionGenerationStartedAt);
    return decisionResult;
  }

  logOpeningPhaseStart(options?.jobId, "image_load");
  const imageLoadStartedAt = Date.now();
  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;
  logOpeningPhaseEnd(options?.jobId, "image_load", Date.now() - imageLoadStartedAt);
  logOpeningPhaseStart(options?.jobId, "image_decode");
  logOpeningPhaseEnd(options?.jobId, "image_decode", Date.now() - imageLoadStartedAt);
  logOpeningPhaseStart(options?.jobId, "image_resize", { skipped: true });
  logOpeningPhaseEnd(options?.jobId, "image_resize", 0, { skipped: true });

  logOpeningPhaseStart(options?.jobId, "geometry_comparison");
  const geometrySignalStartedAt = Date.now();
  const openingSignal = await computeOpeningGeometrySignal(before, after).catch(() => ({
    openingAreaDelta: 0,
    aspectRatioDelta: 0,
    suspiciousOpeningGeometry: false,
  }));
  logOpeningPhaseEnd(options?.jobId, "geometry_comparison", Date.now() - geometrySignalStartedAt);

  logOpeningPhaseStart(options?.jobId, "decision_generation", { section: "prompt_build" });
  const promptBuildStartedAt = Date.now();
  let prompt = `You are a structural validation system.

Your task is to verify that ALL architectural openings from a baseline image are preserved in a staged image.

You are given:
1) The baseline image
2) The staged image
3) A structured list of baseline openings

BASELINE_OPENINGS_JSON:
${JSON.stringify(baselineOpenings)}

You MUST follow this exact process:

STEP 1 - PER-OPENING VERIFICATION
For EACH opening in the baseline list:
1) Locate the opening in the staged image using approximate position and surrounding structure.
2) Classify as ONE of:
- PRESENT: clearly visible and intact
- OCCLUDED: partially blocked by furniture but still exists
- ALTERED: size, shape, or proportions changed
- REMOVED: cannot be identified or replaced by wall/structure

STEP 2 - CONTINUITY CHECK
For EACH opening ask:
"Does a continuous opening path still exist where this opening was?"
If NO, classify as REMOVED even if visually ambiguous.

STEP 3 - RELOCATION RULE
ONLY classify as RELOCATED if:
- opening clearly exists in a different location
- AND original location no longer contains the opening

DO NOT classify as relocated when opening is partially occluded, perspective changed, or furniture overlaps the opening.
If uncertain, DO NOT use RELOCATED.

STEP 4 - FINAL DECISION
Rules:
- ANY REMOVED -> FAIL (CRITICAL)
- ANY ALTERED (major) -> FAIL (CRITICAL)
- OCCLUDED -> PASS
- PRESENT -> PASS

Do NOT assume an opening exists unless clearly visible.
If an opening cannot be confirmed, treat as REMOVED.

STEP 5 - OUTPUT FORMAT
Return JSON only:
{
  "pass": boolean,
  "issueType": "opening_removed" | "opening_altered" | "none",
  "confidence": number,
  "details": [
    {
      "id": "...",
      "classification": "present|occluded|altered|removed",
      "reason": "..."
    }
  ]
}`;

  if (openingSignal.suspiciousOpeningGeometry) {
    prompt += `

STRUCTURAL ATTENTION SIGNAL:

Local analysis detected a potential change in opening geometry.

Focus specifically on:
- window and door size, proportions, and visible area
- whether wall surfaces have expanded into former openings

If any opening appears reduced, expanded, or reshaped:
→ set pass=false
→ set issueType="opening_altered"`;
  }
  logOpeningPhaseEnd(options?.jobId, "decision_generation", Date.now() - promptBuildStartedAt, {
    section: "prompt_build",
  });

  const runWithModel = async (model: string): Promise<OpeningValidatorResult> => {
    logOpeningGeminiStart(options?.jobId, model, "opening_validator");
    const requestStartedAt = Date.now();
    const response = await (ai as any).models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { text: "IMAGE_BEFORE:" },
            { inlineData: { mimeType: "image/webp", data: before } },
            { text: "IMAGE_AFTER:" },
            { inlineData: { mimeType: "image/webp", data: after } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        topP: 0,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
      },
    });
    logGeminiUsage({
      ctx: {
        jobId: options?.jobId || "",
        imageId: options?.imageId || "",
        stage: "validator",
        attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : 1,
      },
      model,
      callType: "validator",
      response,
      latencyMs: Date.now() - requestStartedAt,
    });
    logOpeningGeminiEnd(options?.jobId, model, "opening_validator", Date.now() - requestStartedAt);

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    logOpeningPhaseStart(options?.jobId, "reconciliation", { section: "parse_input" });
    const parseStartedAt = Date.now();
    const parsed = parseOpeningResult(text);
    logOpeningPhaseEnd(options?.jobId, "reconciliation", Date.now() - parseStartedAt, {
      section: "parse_input",
    });
    return parsed;
  };

  try {
    if (openingSignal.suspiciousOpeningGeometry) {
      logOpeningPhaseStart(options?.jobId, "structural_extraction", { promptType: "escalation_only" });
      logOpeningPhaseStart(options?.jobId, "opening_extraction", { promptType: "escalation_only" });
      const structuralExtractionStartedAt = Date.now();
      const result = await runWithModel(OPENING_MODEL_ESCALATION);
      logOpeningPhaseEnd(options?.jobId, "structural_extraction", Date.now() - structuralExtractionStartedAt);
      logOpeningPhaseEnd(options?.jobId, "opening_extraction", Date.now() - structuralExtractionStartedAt, { promptType: "escalation_only" });
      return {
        ...attachStructuredDecision(result),
        openingRegions: [],
      };
    }

    logOpeningPhaseStart(options?.jobId, "opening_extraction", { promptType: "flash" });
    logOpeningPhaseStart(options?.jobId, "structural_extraction", { promptType: "flash" });
    const flashStartedAt = Date.now();
    const flashResult = await runWithModel(OPENING_MODEL_PRIMARY);
    logOpeningPhaseEnd(options?.jobId, "opening_extraction", Date.now() - flashStartedAt, { promptType: "flash" });
    logOpeningPhaseEnd(options?.jobId, "structural_extraction", Date.now() - flashStartedAt, { promptType: "flash" });
    /*
    Flash FAIL is trusted immediately because it normally
    indicates an obvious architectural violation.
    */
    if (flashResult.status === "fail") {
      return {
        ...attachStructuredDecision(flashResult),
        openingRegions: [],
      };
    }

    /*
    Flash PASS must always be verified by Pro because Flash
    can miss subtle geometry changes (window shrink,
    opening boundary movement, etc.)
    */
    logOpeningPhaseStart(options?.jobId, "opening_extraction", { promptType: "pro" });
    logOpeningPhaseStart(options?.jobId, "structural_extraction", { promptType: "pro" });
    const proStartedAt = Date.now();
    const proResult = await runWithModel(OPENING_MODEL_ESCALATION);
    logOpeningPhaseEnd(options?.jobId, "opening_extraction", Date.now() - proStartedAt, { promptType: "pro" });
    logOpeningPhaseEnd(options?.jobId, "structural_extraction", Date.now() - proStartedAt, { promptType: "pro" });
    return {
      ...attachStructuredDecision(proResult),
      openingRegions: [],
    };
  } catch (error: any) {
    throw new Error(`validator_error_opening:${error?.message || String(error)}`);
  }
  } finally {
    logOpeningInstrumentation("OPENING_VALIDATOR_END", {
      jobId: options?.jobId || "unknown",
      validator: "opening",
      phase: "validator_total",
      durationMs: Math.max(0, Math.round(Date.now() - openingValidatorStartedAt)),
    });
  }
}
