import { getGeminiClient } from "../ai/gemini";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { toBase64 } from "../utils/images";
import { classifyIssueTier, createStructuredIssue, ISSUE_TYPES, mapIssueTierToSeverity, splitIssueTokens, type StructuredIssue } from "./issueTypes";
import { extractStructuralBaseline, type AnchorFixture, type StructuralBaseline, type StructuralOpening } from "./openingPreservationValidator";
import type { ValidatorOutcome } from "./validatorOutcome";
import { computeVerticalEdgeDelta, type VerticalEdgeDeltaResult } from "./verticalEdgeDelta";
import type { StructuralSignal } from "./structuralSignal";

export type EnvelopeValidatorResult = ValidatorOutcome & {
  verticalEdgeDelta?: VerticalEdgeDeltaResult;
  deterministicEnvelopeComparison?: EnvelopeDeterministicComparison;
  deterministicHypotheses?: EnvelopeHypothesisBundle;
  deterministicStructuralInterpretations?: DeterministicStructuralInterpretation[];
  baselineAdvisoryGeometry?: AdvisoryGeometryObservation[];
  initialAdvisoryStageExtraction?: string;
  stagedExtractionIntegrity?: StagedExtractionIntegrityResult;
  stagedExtractionRetryStatus?: StagedExtractionRetryStatus;
  initialStagedWallVerifications?: BaselineGuidedWallVerification[];
  stagedWallVerifications?: BaselineGuidedWallVerification[];
  initialAdditionalArchitecturalEvidence?: AdditionalArchitecturalEvidence;
  additionalArchitecturalEvidence?: AdditionalArchitecturalEvidence;
  initialAdditionalWallPlanes?: AdditionalWallPlanesResult;
  additionalWallPlanes?: AdditionalWallPlanesResult;
  baselineCandidateWallQualifications?: CandidateWallQualification[];
  stagedCandidateWallQualifications?: CandidateWallQualification[];
  semanticBaselineWallModel?: SemanticWallModel[];
  initialSemanticStagedWallModel?: SemanticWallModel[];
  semanticStagedWallModel?: SemanticWallModel[];
  semanticWallMatches?: SemanticWallMatch[];
  semanticWallIdentityAudit?: SemanticWallIdentityAudit;
  finalGeminiPrompt?: string;
  constraintVerificationMode?: "comparison_claim" | "constraint_statement_verification";
  baselineArchitecturalConstraintModel?: string;
  constraintVerificationStatements?: EnvelopeBaselineVerificationStatement[];
  constraintVerificationResults?: EnvelopeStatementVerificationResult[];
  changedConstraints?: EnvelopeVerificationFailure[];
  baselineVerificationMode?: "comparison_claim" | "baseline_statement_verification";
  baselineArchitecturalModel?: string;
  baselineVerificationStatements?: EnvelopeBaselineVerificationStatement[];
  baselineVerificationResults?: EnvelopeStatementVerificationResult[];
  baselineVerificationFailures?: EnvelopeVerificationFailure[];
  advisoryStageExtraction?: string;
  architecturalChangeSummary?: string;
  architecturalClaim?: string;
  architecturalClaimSupport?: string[];
  structuralPatterns?: Array<{
    patternId: string;
    patternName: string;
    supportingObservations: string[];
    confidence: number;
  }>;
  architecturalEventCandidates?: Array<{
    eventId: string;
    eventName: string;
    supportingStructuralPatterns: string[];
    conflictingStructuralPatterns: string[];
    supportingObservations: string[];
    conflictingObservations: string[];
    confidence: number;
  }>;
  winningArchitecturalEvent?: string;
  architecturalQuestion?: string;
  architecturalAnswer?: "TRUE" | "FALSE";
  architecturalReason?: string;
  architecturalEventInference?: {
    primaryEventType: string;
    primarySuspicion: string;
    evidence: string[];
    alternatives: string[];
    confidence: "Low" | "Medium" | "High";
    secondarySuspicion?: string;
  };
  selectedExplanation?: string;
  primaryHypothesis?: string;
  hypothesisConfidence?: "Low" | "Medium" | "High";
  hypothesisVerdict?: "confirmed" | "rejected";
  hypothesisDismissalReason?: string;
  hypothesisAnalysis?: string;
  deterministicObservationAdjudications?: EnvelopeObservationAdjudication[];
  deterministicAdjudicationCoverage?: EnvelopeAdjudicationCoverage;
  rawGeminiJson?: string;
  guidedObservationPrompt?: string;
  guidedObservationRawGeminiJson?: string;
};

type EnvelopeDeterministicSuspicion = {
  observationId: string;
  code:
    | "possible_wall_added"
    | "possible_wall_removed"
    | "possible_wall_extended"
    | "possible_wall_shortened"
    | "possible_wall_interrupted"
    | "possible_unsupported_architectural_completion"
    | "possible_new_visible_corner"
    | "possible_missing_corner"
    | "possible_wall_visibility_changed"
    | "possible_architectural_certainty_changed";
  wallIndex: number;
  note: string;
};

type EnvelopeDeterministicComparison = {
  baselineWallCount: number;
  stagedWallCount: number;
  suspicions: EnvelopeDeterministicSuspicion[];
  clarificationQuestions: string[];
};

type EnvelopeStructuralPatternId =
  | "existing_wall_no_longer_continues"
  | "previously_unseen_wall_continues"
  | "new_wall_surface_introduced"
  | "wall_termination_disappeared";

type EnvelopeStructuralPattern = {
  patternId: EnvelopeStructuralPatternId;
  patternName: string;
  description: string;
  supportingObservationIds: string[];
  supportingObservations: string[];
  confidence: number;
};

type EnvelopeDeterministicHypothesis = {
  hypothesisId: string;
  category:
    | "possible_unsupported_architectural_completion"
    | "possible_permanent_wall_added"
    | "possible_permanent_wall_removed"
    | "possible_wall_extension"
    | "possible_wall_shortening"
    | "possible_wall_continuity_interrupted"
    | "possible_room_envelope_modified"
    | "possible_visibility_ambiguity";
  title: string;
  confidence: "Low" | "Medium" | "High";
  statement: string;
  supportingObservationIds: string[];
  supportingObservations: string[];
  conflictingObservationIds: string[];
  conflictingObservations: string[];
  alternativeExplanationsAlreadyConsidered: string[];
};

type EnvelopeHypothesisBundle = {
  primaryHypothesis: EnvelopeDeterministicHypothesis;
  hypotheses: EnvelopeDeterministicHypothesis[];
};

type EnvelopeObservationAdjudication = {
  observationId: string;
  code: EnvelopeDeterministicSuspicion["code"];
  wallIndex: number;
  decision: "confirm" | "dismiss";
  explanation: string;
  dismissReason?: "perspective_framing" | "foreground_occlusion" | "baseline_visibility_limitation" | "camera_viewpoint" | "observation_incorrect" | "other_valid_explanation";
};

type EnvelopeAdjudicationCoverage = {
  totalSuspicions: number;
  addressedSuspicions: number;
  unresolvedSuspicions: Array<{ code: string; wallIndex: number }>;
  allSuspicionsAddressed: boolean;
};

type EnvelopeArchitecturalEventId =
  | "wall_added"
  | "wall_removed"
  | "room_corner_added"
  | "room_corner_removed"
  | "wall_plane_split";

type EnvelopeArchitecturalEventInference = {
  eventId: EnvelopeArchitecturalEventId;
  eventName: string;
  suspicion: string;
  claim: string;
  question: string;
  reasonToken: string;
  evidence: string[];
  alternatives: string[];
  confidence: "Low" | "Medium" | "High";
  supportingObservationIds: string[];
};

type EnvelopeArchitecturalEventCandidate = {
  eventId: EnvelopeArchitecturalEventId;
  eventName: string;
  claim: string;
  question: string;
  reasonToken: string;
  supportingPatternIds: EnvelopeStructuralPatternId[];
  supportingPatterns: string[];
  conflictingPatternIds: EnvelopeStructuralPatternId[];
  conflictingPatterns: string[];
  supportingObservationIds: string[];
  supportingObservations: string[];
  conflictingObservationIds: string[];
  conflictingObservations: string[];
  confidence: number;
};

export type EnvelopeBaselineVerificationStatement = {
  statementId: string;
  statement: string;
  scope: "structural" | "reference";
  reasoningLayer: "geometric_observation" | "structural_interpretation";
  architecturalContext: "frame_edge" | "interior_geometry" | "primary_wall_geometry" | "global_geometry";
  edgeSide?: "left" | "right";
  factType:
    | "global_visible_walls"
    | "wall_visibility"
    | "wall_visibility_magnitude"
    | "wall_continuation"
    | "visible_corner"
    | "no_visible_corner"
    | "corner_visibility_magnitude"
    | "terminates_at_corner"
    | "no_visible_return_wall"
    | "no_visible_adjoining_wall_plane"
    | "no_visible_recess"
    | "no_visible_wall_termination"
    | "opening_anchor"
    | "fixture_anchor";
  failureEventHint:
    | "new_wall_plane_introduced"
    | "wall_surface_missing"
    | "room_corner_added"
    | "room_corner_removed"
    | "wall_termination_changed"
    | "reference_anchor_changed";
  relatedWallIndex?: number;
  supportingFacts: string[];
};

export type EnvelopeStatementVerificationResult = {
  statementId: string;
  statement: string;
  scope: "structural" | "reference";
  answer: "TRUE" | "FALSE";
  explanation?: string;
  observedVisibilityMagnitude?: string;
};

export type EnvelopeVerificationFailure = EnvelopeBaselineVerificationStatement & {
  explanation?: string;
  observedVisibilityMagnitude?: string;
  significance?: "low" | "medium" | "high";
  significanceScore?: number;
};

type EnvelopeVisibilityMagnitude = "none" | "minimal" | "partial" | "substantial" | "dominant" | "complete" | "full";

export type SemanticWallModel = {
  semanticWallId: string;
  displayName: string;
  primaryAnchorLabel?: string;
  primaryAnchorToken?: string;
  secondaryArchitecturalFeatures: string[];
  rawArchitecturalFeatures: string[];
  rawAnchorTokens: string[];
  advisoryWallIndex: number;
  advisoryPositionalLabel: string;
  referenceAnchors: string[];
  anchorTokens: string[];
  geometryLines: string[];
  visibility: string;
  visibleExtent: string;
  descriptor: string;
  identityAmbiguity?: string;
  matchedBaselineWall?: string;
};

export type SemanticWallMatch = {
  baselineSemanticWallId: string;
  baselineDisplayName: string;
  stagedSemanticWallId?: string;
  stagedDisplayName?: string;
  matched: boolean;
  score: number;
  reasons: string[];
};

export type SemanticWallIdentityAudit = {
  regenerationOccurred: boolean;
  reason?: string;
  mergedSemanticWallsDetected: boolean;
  ambiguityDetected: boolean;
  initialStagedWallCount: number;
  finalStagedWallCount: number;
  notes: string[];
};

export type AdvisoryGeometryObservation = {
  candidateId: string;
  advisoryWallIndex: number;
  advisoryPositionalLabel: string;
  qualificationDecision: CandidateWallQualificationDecision;
  qualificationReason: string;
  primaryAnchorLabel?: string;
  rawArchitecturalFeatures: string[];
  evidenceBreakdown: string[];
  descriptor: string;
};

export type BaselineGuidedWallVerification = {
  semanticWallId: string;
  displayName: string;
  primaryAnchorLabel?: string;
  samePermanentWallVisible: "TRUE" | "FALSE";
  wallVisibility?: EnvelopeVisibilityMagnitude;
  wallExtent?: EnvelopeVisibilityMagnitude;
  architecturalCertainty?: "known" | "partial" | "unknown";
  leftCornerVisible?: boolean;
  rightCornerVisible?: boolean;
  continuesBeyondFrame?: boolean;
  terminatesAtCorner?: boolean;
  returnWallVisible?: boolean;
  adjoiningWallVisible?: boolean;
  recessVisible?: boolean;
  confidence?: number;
  reason?: string;
  observations: string[];
};

export type AdditionalWallPlanesResult = {
  answer: "TRUE" | "FALSE";
  descriptions: string[];
  confidence?: number;
  reason?: string;
};

export type AdditionalArchitecturalEvidence = {
  additionalPermanentWallPlanes: "TRUE" | "FALSE";
  additionalPermanentWallPlaneDescriptions: string[];
  additionalPermanentReturnWalls: "TRUE" | "FALSE";
  additionalPermanentReturnWallDescriptions: string[];
  additionalPermanentRecesses: "TRUE" | "FALSE";
  additionalPermanentRecessDescriptions: string[];
  additionalPermanentCorners: "TRUE" | "FALSE";
  additionalPermanentCornerDescriptions: string[];
  unmatchedPermanentArchitecturalFeatures: "TRUE" | "FALSE";
  unmatchedPermanentFeatureDescriptions: string[];
  confidence?: number;
  reason?: string;
};

export type DeterministicStructuralInterpretation = {
  interpretationId: string;
  category:
    | "wall_plane_introduced"
    | "wall_plane_removed"
    | "wall_shortened"
    | "wall_extended"
    | "corner_introduced"
    | "corner_removed"
    | "return_wall_introduced"
    | "return_wall_removed"
    | "adjoining_wall_introduced"
    | "adjoining_wall_removed"
    | "recess_introduced"
    | "recess_removed";
  wallSemanticId?: string;
  wallDisplayName?: string;
  severity: "advisory" | "significant";
  confidence: "low" | "medium" | "high";
  summary: string;
  supportingFacts: string[];
  corroboratingEvidence: string[];
  contradictingEvidence: string[];
};

export type StagedExtractionIntegrityIssue = {
  code:
    | "primary_anchor_conflict"
    | "duplicate_primary_anchor"
    | "missing_required_anchor"
    | "ambiguous_mapping"
    | "low_confidence_mapping"
    | "primary_anchor_mismatch";
  message: string;
  baselineSemanticWallId?: string;
  stagedSemanticWallId?: string;
};

export type StagedExtractionIntegrityResult = {
  passed: boolean;
  attempt: number;
  mappingConfidenceThreshold: number;
  issues: StagedExtractionIntegrityIssue[];
};

export type StagedExtractionRetryStatus = {
  triggered: boolean;
  attempts: number;
  finalAttempt: number;
  retrySucceeded: boolean;
  reason?: string;
};

export type CandidateWallQualificationDecision = "qualified_semantic_wall" | "supporting_geometric_evidence" | "rejected";

export type CandidateWallQualification = {
  candidateId: string;
  advisoryWallIndex: number;
  advisoryPositionalLabel: string;
  qualificationScore: number;
  evidenceBreakdown: string[];
  qualificationDecision: CandidateWallQualificationDecision;
  qualificationReason: string;
  primaryAnchorLabel?: string;
  primaryAnchorToken?: string;
  secondaryArchitecturalFeatures: string[];
  rawArchitecturalFeatures: string[];
};

function logEnvelopeEvent(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...payload }));
}

function logEnvelopePhaseEnd(jobId: string | undefined, phase: string, durationMs: number, extra: Record<string, unknown> = {}): void {
  logEnvelopeEvent("ENVELOPE_PHASE_END", {
    jobId: jobId || "unknown",
    validator: "envelope",
    phase,
    durationMs: Math.max(0, Math.round(durationMs)),
    ...extra,
  });
}

const ENVELOPE_MODEL_PRIMARY = process.env.GEMINI_VALIDATOR_MODEL_PRIMARY || "gemini-2.5-flash";
const ENVELOPE_MODEL_ESCALATION = process.env.GEMINI_VALIDATOR_MODEL_ESCALATION || "gemini-2.5-pro";
const ENVELOPE_ESCALATION_CONFIDENCE = Number(process.env.GEMINI_VALIDATOR_PRO_MIN_CONFIDENCE || 0.7);
const ENVELOPE_HARD_FAIL_CONFIDENCE_THRESHOLD = ENVELOPE_ESCALATION_CONFIDENCE;

type EnvelopeReasonCode =
  | "envelope_visual_ambiguity"
  | "envelope_insufficient_geometric_evidence"
  | "envelope_confirmed_structural_change";

function hasClearGeometricChange(parsed: any): boolean {
  const boundaryLinesMissing = parsed?.boundaryLinesMissing === true;
  const continuousSurfaceReplacement = parsed?.continuousSurfaceReplacement === true;
  const noPlausibleVisualExplanation = parsed?.noPlausibleVisualExplanation === true;
  return boundaryLinesMissing && continuousSurfaceReplacement && noPlausibleVisualExplanation;
}

function buildEnvelopeStructuredIssues(params: {
  issueType: EnvelopeValidatorResult["issueType"];
  issueTier: EnvelopeValidatorResult["issueTier"];
  confidence: number;
  reasonCode?: EnvelopeReasonCode;
  boundaryLinesMissing: boolean;
  continuousSurfaceReplacement: boolean;
  noPlausibleVisualExplanation: boolean;
  visualAmbiguity: boolean;
}): StructuredIssue[] {
  if (params.issueType === ISSUE_TYPES.NONE) return [];

  const object = params.continuousSurfaceReplacement || params.boundaryLinesMissing
    ? "wall_plane"
    : params.reasonCode === "envelope_visual_ambiguity"
      ? "room_envelope"
      : "wall_plane";

  const action = params.reasonCode === "envelope_visual_ambiguity"
    ? "uncertain"
    : params.continuousSurfaceReplacement
      ? "flattened"
      : "changed";

  const evidence = [
    ...(params.reasonCode ? [params.reasonCode] : []),
    ...(params.boundaryLinesMissing ? ["boundary_lines_missing"] : []),
    ...(params.continuousSurfaceReplacement ? ["continuous_surface_replacement"] : []),
    ...(params.noPlausibleVisualExplanation ? ["no_plausible_visual_explanation"] : []),
    ...(params.visualAmbiguity ? ["visual_ambiguity"] : []),
  ];

  return [createStructuredIssue({
    type: "envelope_change",
    object,
    action,
    severity: mapIssueTierToSeverity(params.issueTier),
    source: "envelope_validator",
    confidence: params.confidence,
    evidence,
  })];
}

function wallLabelForEnvelope(wallIndex: number): string {
  if (wallIndex === 0) return "front / camera-facing wall";
  if (wallIndex === 1) return "right wall";
  if (wallIndex === 2) return "rear wall";
  if (wallIndex === 3) return "left wall";
  return `wall ${wallIndex}`;
}

function wallShortLabelForEnvelope(wallIndex: number): string {
  if (wallIndex === 0) return "front wall";
  if (wallIndex === 1) return "right wall";
  if (wallIndex === 2) return "rear wall";
  if (wallIndex === 3) return "left wall";
  return `wall ${wallIndex}`;
}

function adjacentWallIndex(wallIndex: number, side: "left" | "right"): number {
  const orderedWalls = [0, 1, 2, 3] as const;
  const position = orderedWalls.indexOf(wallIndex as 0 | 1 | 2 | 3);
  if (position === -1) return wallIndex;
  if (side === "left") return orderedWalls[(position + orderedWalls.length - 1) % orderedWalls.length];
  return orderedWalls[(position + 1) % orderedWalls.length];
}

function wallJoinPhrase(wallIndex: number, side: "left" | "right"): string {
  return `${wallShortLabelForEnvelope(wallIndex)} joins the ${wallShortLabelForEnvelope(adjacentWallIndex(wallIndex, side))} at a visible ${side} corner`;
}

function describeFrameContinuation(descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number]): string | null {
  if (descriptor.continuesBeyondFrame !== true) return null;

  if (descriptor.leftBoundaryVisible !== true && descriptor.rightBoundaryVisible === true) {
    return `${wallShortLabelForEnvelope(descriptor.wallIndex)} continues beyond the left image edge`;
  }
  if (descriptor.rightBoundaryVisible !== true && descriptor.leftBoundaryVisible === true) {
    return `${wallShortLabelForEnvelope(descriptor.wallIndex)} continues beyond the right image edge`;
  }
  return `${wallShortLabelForEnvelope(descriptor.wallIndex)} continues beyond the image frame`;
}

function visibilityPhrase(descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number]): string {
  if (descriptor.visibility === "full") return `${wallShortLabelForEnvelope(descriptor.wallIndex)} is fully visible`;
  if (descriptor.visibility === "minimal") return `${wallShortLabelForEnvelope(descriptor.wallIndex)} is only minimally visible`;
  return `${wallShortLabelForEnvelope(descriptor.wallIndex)} is partially visible`;
}

function wallVisibilityMagnitude(descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number]): EnvelopeVisibilityMagnitude {
  const visibility = descriptor.visibleExtent || descriptor.visibility;
  if (visibility === "minimal") return "minimal";
  if (visibility === "partial") return "partial";
  if (visibility === "full" && (descriptor.leftBoundaryVisible !== true || descriptor.rightBoundaryVisible !== true)) {
    return "substantial";
  }
  return "full";
}

function cornerVisibilityMagnitude(
  descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number],
  side: "left" | "right",
): EnvelopeVisibilityMagnitude {
  const visible = side === "left" ? descriptor.leftCornerVisible === true : descriptor.rightCornerVisible === true;
  if (!visible) return "none";
  const wallMagnitude = wallVisibilityMagnitude(descriptor);
  if (wallMagnitude === "minimal") return "minimal";
  if (wallMagnitude === "partial" || normalizeWallCertainty(descriptor.architecturalCertainty) !== "known") return "partial";
  return "complete";
}

function magnitudeLine(label: string, magnitude: EnvelopeVisibilityMagnitude): string {
  return `${label} visibility: ${magnitude}`;
}

function exitedFrameSide(descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number]): "left" | "right" | null {
  if (descriptor.leftBoundaryVisible !== true && descriptor.rightBoundaryVisible === true) return "left";
  if (descriptor.rightBoundaryVisible !== true && descriptor.leftBoundaryVisible === true) return "right";
  return null;
}

function baselineMagnitudeFromStatement(statement: EnvelopeBaselineVerificationStatement): EnvelopeVisibilityMagnitude | undefined {
  const token = statement.supportingFacts.find((item) => String(item).startsWith("baseline_magnitude:"));
  if (!token) return undefined;
  return token.slice("baseline_magnitude:".length) as EnvelopeVisibilityMagnitude;
}

function edgeObservationContext(
  descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number],
  side: "left" | "right",
): EnvelopeBaselineVerificationStatement["architecturalContext"] {
  if (side === "left" && descriptor.leftBoundaryVisible !== true && descriptor.rightBoundaryVisible === true) return "frame_edge";
  if (side === "right" && descriptor.rightBoundaryVisible !== true && descriptor.leftBoundaryVisible === true) return "frame_edge";
  return "interior_geometry";
}

function semanticizeWallLabelText(text: string, semanticWalls: SemanticWallModel[]): string {
  let rewritten = text;
  for (const wall of semanticWalls) {
    const aliases = [
      wallLabelForEnvelope(wall.advisoryWallIndex),
      wallShortLabelForEnvelope(wall.advisoryWallIndex),
      wallShortLabelForEnvelope(wall.advisoryWallIndex).replace(/^./, (value) => value.toUpperCase()),
    ];
    for (const alias of aliases) {
      rewritten = rewritten.replace(alias, wall.displayName);
    }
  }
  return rewritten;
}

function visibilityRank(value?: string): number {
  if (!value) return -1;
  const normalized = value.trim().toLowerCase();
  if (normalized === "none") return 0;
  if (normalized === "minimal") return 1;
  if (normalized === "partial") return 2;
  if (normalized === "substantial") return 3;
  if (normalized === "dominant") return 4;
  if (normalized === "complete") return 4;
  if (normalized === "full") return 4;
  return -1;
}

function changedConstraintWeight(statement: EnvelopeVerificationFailure): number {
  const baselineMagnitude = baselineMagnitudeFromStatement(statement);
  const baselineRank = visibilityRank(baselineMagnitude);
  const observedRank = visibilityRank(statement.observedVisibilityMagnitude);

  if (statement.reasoningLayer === "structural_interpretation") {
    return observedRank >= 2 ? 0.98 : observedRank >= 1 ? 0.92 : 0.85;
  }

  if (
    statement.factType === "no_visible_return_wall"
    || statement.factType === "no_visible_adjoining_wall_plane"
    || statement.factType === "no_visible_recess"
    || statement.factType === "no_visible_wall_termination"
  ) {
    if (statement.architecturalContext === "frame_edge") {
      return observedRank >= 2 ? 0.92 : observedRank >= 1 ? 0.82 : 0.7;
    }
    return observedRank >= 2 ? 0.98 : observedRank >= 1 ? 0.92 : 0.85;
  }

  if (statement.factType === "no_visible_corner") {
    if (statement.architecturalContext === "frame_edge") {
      return observedRank >= 2 ? 0.85 : observedRank >= 1 ? 0.72 : 0.55;
    }
    return observedRank >= 2 ? 0.95 : observedRank >= 1 ? 0.85 : 0.7;
  }

  if (statement.factType === "visible_corner" || statement.factType === "corner_visibility_magnitude") {
    if (observedRank === 0 && statement.architecturalContext === "frame_edge" && baselineRank <= 1) return 0.12;
    if (observedRank === 0 && statement.architecturalContext === "frame_edge") return 0.28;
    if (observedRank === 0) return 0.8;
    return observedRank > baselineRank ? 0.72 : statement.architecturalContext === "frame_edge" ? 0.3 : 0.55;
  }

  if (statement.factType === "wall_visibility" || statement.factType === "wall_visibility_magnitude") {
    if (statement.architecturalContext === "primary_wall_geometry") {
      if (observedRank === 0 && baselineRank >= 2) return 0.96;
      if (observedRank === 0) return 0.75;
      if (observedRank > baselineRank) return 0.9;
      return 0.55;
    }
    if (observedRank === 0 && baselineRank <= 1) return 0.1;
    if (observedRank === 0 && baselineRank === 2) return 0.25;
    if (observedRank > baselineRank) return 0.8;
    return 0.35;
  }

  if (statement.factType === "wall_continuation") {
    return statement.architecturalContext === "frame_edge" ? 0.25 : 0.7;
  }

  if (statement.factType === "terminates_at_corner") {
    return statement.architecturalContext === "frame_edge" ? 0.55 : 0.88;
  }

  return statement.architecturalContext === "frame_edge" ? 0.15 : 0.3;
}

function significanceBand(weight: number): "low" | "medium" | "high" {
  if (weight >= 0.75) return "high";
  if (weight >= 0.35) return "medium";
  return "low";
}

function semanticAnchorTypeLabel(type: AnchorFixture["type"] | StructuralOpening["type"]): string {
  if (type === "ac_unit") return "built-in AC unit";
  if (type === "fireplace") return "fireplace";
  if (type === "built_in_cabinet") return "built-in cabinetry";
  if (type === "kitchen_island") return "kitchen island";
  if (type === "staircase") return "staircase";
  if (type === "window") return "window";
  if (type === "door") return "sliding glass door";
  if (type === "closet_door") return "closet door";
  return "walkthrough opening";
}

function semanticAnchorTokenForFixture(fixture: AnchorFixture): string {
  return `${fixture.type}:${fixture.horizontalBand}`;
}

function semanticAnchorTokenForOpening(opening: StructuralOpening): string {
  return `${opening.type}:${opening.horizontalBand}:${opening.verticalBand}`;
}

type SemanticAnchorCandidate = {
  token: string;
  label: string;
  priority: number;
};

type StagedSemanticIdentityState = {
  descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number];
  rawCandidates: SemanticAnchorCandidate[];
  qualification: CandidateWallQualification;
  assignedPrimary?: SemanticAnchorCandidate;
  assignedSecondary: SemanticAnchorCandidate[];
  fallback?: { semanticWallId: string; displayName: string; anchors: string[]; tokens: string[] };
  identityAmbiguity?: string;
};

function semanticAnchorPriority(type: AnchorFixture["type"] | StructuralOpening["type"]): number {
  if (type === "door") return 1;
  if (type === "window") return 2;
  if (type === "closet_door") return 3;
  if (type === "ac_unit") return 4;
  if (type === "fireplace") return 5;
  if (type === "built_in_cabinet") return 6;
  if (type === "other") return 7;
  if (type === "kitchen_island") return 8;
  if (type === "staircase") return 9;
  return 10;
}

function buildSemanticAnchorCandidates(
  descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number],
  baseline: StructuralBaseline,
): SemanticAnchorCandidate[] {
  const fixtures = (baseline.anchorFixtures || [])
    .filter((item) => item.wallIndex === descriptor.wallIndex)
    .map((fixture) => ({
      token: semanticAnchorTokenForFixture(fixture),
      label: semanticAnchorTypeLabel(fixture.type),
      priority: semanticAnchorPriority(fixture.type),
    }));
  const openings = baseline.openings
    .filter((item) => item.wallIndex === descriptor.wallIndex)
    .map((opening) => ({
      token: semanticAnchorTokenForOpening(opening),
      label: semanticAnchorTypeLabel(opening.type),
      priority: semanticAnchorPriority(opening.type),
    }));

  return [...fixtures, ...openings]
    .sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label) || left.token.localeCompare(right.token))
    .filter((candidate, index, all) => all.findIndex((item) => item.token === candidate.token) === index);
}

function determinePrimaryAnchor(candidates: SemanticAnchorCandidate[]): { primary?: SemanticAnchorCandidate; secondary: SemanticAnchorCandidate[] } {
  if (candidates.length === 0) return { secondary: [] };
  return {
    primary: candidates[0],
    secondary: candidates.slice(1),
  };
}

function qualificationDecisionForScore(score: number): CandidateWallQualificationDecision {
  if (score >= 35) return "qualified_semantic_wall";
  if (score >= 15) return "supporting_geometric_evidence";
  return "rejected";
}

function buildCandidateWallQualification(
  descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number],
  baseline: StructuralBaseline,
): CandidateWallQualification {
  const rawCandidates = buildSemanticAnchorCandidates(descriptor, baseline);
  const assignment = determinePrimaryAnchor(rawCandidates);
  const evidenceBreakdown: string[] = [];
  let score = 0;

  if (assignment.primary) {
    const anchorScore = assignment.primary.priority <= 3 ? 38 : assignment.primary.priority <= 6 ? 32 : 28;
    score += anchorScore;
    evidenceBreakdown.push(`primary architectural anchor ${assignment.primary.label}: +${anchorScore}`);
  }

  const visibilityMagnitude = wallVisibilityMagnitude(descriptor);
  const visibilityScore = visibilityMagnitude === "full"
    ? 18
    : visibilityMagnitude === "substantial"
      ? 15
      : visibilityMagnitude === "partial"
        ? 11
        : visibilityMagnitude === "minimal"
          ? 4
          : 0;
  score += visibilityScore;
  evidenceBreakdown.push(`visible wall extent ${visibilityMagnitude}: +${visibilityScore}`);

  const cornerCount = Number(descriptor.leftCornerVisible === true) + Number(descriptor.rightCornerVisible === true);
  if (cornerCount > 0) {
    const cornerScore = cornerCount * 8;
    score += cornerScore;
    evidenceBreakdown.push(`visible corners (${cornerCount}): +${cornerScore}`);
  }

  if (descriptor.continuesBeyondFrame === true) {
    score += 5;
    evidenceBreakdown.push("continuation beyond frame: +5");
  }
  if (descriptor.leftBoundaryVisible === true) {
    score += 3;
    evidenceBreakdown.push("left boundary visible: +3");
  }
  if (descriptor.rightBoundaryVisible === true) {
    score += 3;
    evidenceBreakdown.push("right boundary visible: +3");
  }

  const certainty = normalizeWallCertainty(descriptor.architecturalCertainty);
  const certaintyScore = certainty === "known" ? 8 : certainty === "partial" ? 3 : 0;
  score += certaintyScore;
  evidenceBreakdown.push(`architectural certainty ${certainty}: +${certaintyScore}`);

  const decision = qualificationDecisionForScore(score);
  const qualificationReason = decision === "qualified_semantic_wall"
    ? "Sufficient structural evidence exists to promote this candidate into the semantic wall set."
    : decision === "supporting_geometric_evidence"
      ? "This candidate carries useful geometry but lacks enough architectural evidence to become a semantic wall."
      : "This candidate does not provide enough structural evidence and is treated as noise or duplicate geometry.";

  return {
    candidateId: `candidate_wall_${descriptor.wallIndex}`,
    advisoryWallIndex: descriptor.wallIndex,
    advisoryPositionalLabel: wallShortLabelForEnvelope(descriptor.wallIndex),
    qualificationScore: score,
    evidenceBreakdown,
    qualificationDecision: decision,
    qualificationReason,
    primaryAnchorLabel: assignment.primary?.label,
    primaryAnchorToken: assignment.primary?.token,
    secondaryArchitecturalFeatures: assignment.secondary.map((candidate) => candidate.label),
    rawArchitecturalFeatures: rawCandidates.map((candidate) => candidate.label),
  };
}

function buildCandidateWallQualifications(baseline?: StructuralBaseline | null): CandidateWallQualification[] {
  if (!baseline || !Array.isArray(baseline.wallDescriptors)) return [];
  return baseline.wallDescriptors.map((descriptor) => buildCandidateWallQualification(descriptor, baseline));
}

function buildAdvisoryGeometryObservations(
  baseline?: StructuralBaseline | null,
  candidates?: CandidateWallQualification[],
): AdvisoryGeometryObservation[] {
  if (!baseline) return [];
  const wallDescriptors = baseline.wallDescriptors || [];
  return (candidates || buildCandidateWallQualifications(baseline))
    .filter((candidate) => candidate.qualificationDecision !== "qualified_semantic_wall")
    .map((candidate) => ({
      candidateId: candidate.candidateId,
      advisoryWallIndex: candidate.advisoryWallIndex,
      advisoryPositionalLabel: candidate.advisoryPositionalLabel,
      qualificationDecision: candidate.qualificationDecision,
      qualificationReason: candidate.qualificationReason,
      primaryAnchorLabel: candidate.primaryAnchorLabel,
      rawArchitecturalFeatures: candidate.rawArchitecturalFeatures,
      evidenceBreakdown: candidate.evidenceBreakdown,
      descriptor: wallDescriptors.find((descriptor) => descriptor.wallIndex === candidate.advisoryWallIndex)?.description || "No descriptor available.",
    }));
}

function wallGeometrySimilarity(
  baselineWall: SemanticWallModel,
  stagedWall: SemanticWallModel,
): number {
  let score = 0;
  if (baselineWall.visibility === stagedWall.visibility) score += 3;
  if (baselineWall.visibleExtent === stagedWall.visibleExtent) score += 2;
  const continuationBaseline = baselineWall.geometryLines.find((line) => line.includes("continues beyond"));
  const continuationStaged = stagedWall.geometryLines.find((line) => line.includes("continues beyond"));
  if (continuationBaseline && continuationStaged && continuationBaseline.split("continues beyond")[1] === continuationStaged.split("continues beyond")[1]) score += 3;
  const baselineLeftCorner = baselineWall.geometryLines.some((line) => line.includes("visible left corner") || line.includes("joins") && line.includes("left corner"));
  const stagedLeftCorner = stagedWall.geometryLines.some((line) => line.includes("visible left corner") || line.includes("joins") && line.includes("left corner"));
  if (baselineLeftCorner === stagedLeftCorner) score += 2;
  const baselineRightCorner = baselineWall.geometryLines.some((line) => line.includes("visible right corner") || line.includes("joins") && line.includes("right corner"));
  const stagedRightCorner = stagedWall.geometryLines.some((line) => line.includes("visible right corner") || line.includes("joins") && line.includes("right corner"));
  if (baselineRightCorner === stagedRightCorner) score += 2;
  return score;
}

function materializeSemanticWallModel(
  item: StagedSemanticIdentityState,
  wallIdByIndex: Map<number, string>,
): SemanticWallModel {
  const descriptor = item.descriptor;
  const displayName = item.assignedPrimary
    ? `wall containing ${item.assignedPrimary.label}`
    : item.fallback?.displayName || `wall ${descriptor.wallIndex}`;
  const semanticWallId = item.assignedPrimary
    ? `wall_${item.assignedPrimary.token.replace(/[^a-z0-9]+/gi, "_")}`.toLowerCase()
    : item.fallback?.semanticWallId || `wall_${descriptor.wallIndex}`;
  const referenceAnchors = item.assignedPrimary
    ? [item.assignedPrimary.label, ...item.assignedSecondary.map((candidate) => candidate.label)]
    : item.fallback?.anchors || [];
  const anchorTokens = item.assignedPrimary
    ? [item.assignedPrimary.token, ...item.assignedSecondary.map((candidate) => candidate.token)]
    : item.fallback?.tokens || [];
  const terminationSide = descriptor.terminatesAtCorner === true
    ? descriptor.leftCornerVisible === true && descriptor.rightCornerVisible !== true
      ? "left"
      : descriptor.rightCornerVisible === true && descriptor.leftCornerVisible !== true
        ? "right"
        : null
    : null;
  const geometryLines: string[] = [
    visibilityPhrase(descriptor).replace(wallShortLabelForEnvelope(descriptor.wallIndex), displayName),
    `visibility magnitude: ${wallVisibilityMagnitude(descriptor)}`,
  ];
  const continuation = describeFrameContinuation(descriptor);
  if (continuation) {
    geometryLines.push(continuation.replace(wallShortLabelForEnvelope(descriptor.wallIndex), displayName));
  }
  if (descriptor.leftCornerVisible === true) {
    geometryLines.push(`${displayName} joins ${semanticJoinLabel(wallIdByIndex, descriptor.wallIndex, adjacentWallIndex(descriptor.wallIndex, "left"))} at a visible left corner`);
  } else {
    geometryLines.push(`no visible left corner on ${displayName}`);
  }
  if (descriptor.rightCornerVisible === true) {
    geometryLines.push(`${displayName} joins ${semanticJoinLabel(wallIdByIndex, descriptor.wallIndex, adjacentWallIndex(descriptor.wallIndex, "right"))} at a visible right corner`);
  } else {
    geometryLines.push(`no visible right corner on ${displayName}`);
  }
  if (terminationSide) {
    geometryLines.push(`${displayName} terminates at an observed corner`);
  }
  const frameSide = exitedFrameSide(descriptor);
  if (frameSide) {
    geometryLines.push(`no visible return wall at the ${frameSide} edge`);
    geometryLines.push(`no visible adjoining wall plane at the ${frameSide} edge`);
    geometryLines.push(`no visible recess at the ${frameSide} edge`);
    geometryLines.push(`no visible wall termination at the ${frameSide} edge`);
  }

  return {
    semanticWallId,
    displayName,
    primaryAnchorLabel: item.assignedPrimary?.label,
    primaryAnchorToken: item.assignedPrimary?.token,
    secondaryArchitecturalFeatures: item.assignedSecondary.map((candidate) => candidate.label),
    rawArchitecturalFeatures: item.rawCandidates.map((candidate) => candidate.label),
    rawAnchorTokens: item.rawCandidates.map((candidate) => candidate.token),
    advisoryWallIndex: descriptor.wallIndex,
    advisoryPositionalLabel: wallShortLabelForEnvelope(descriptor.wallIndex),
    referenceAnchors,
    anchorTokens,
    geometryLines,
    visibility: descriptor.visibility,
    visibleExtent: descriptor.visibleExtent || descriptor.visibility,
    descriptor: descriptor.description,
    identityAmbiguity: item.identityAmbiguity,
  } satisfies SemanticWallModel;
}

function buildSemanticWallIdentityStates(baseline?: StructuralBaseline | null): StagedSemanticIdentityState[] {
  if (!baseline) return [];
  const wallDescriptors = Array.isArray(baseline.wallDescriptors) ? baseline.wallDescriptors : [];
  const qualificationByWallIndex = new Map(buildCandidateWallQualifications(baseline).map((item) => [item.advisoryWallIndex, item] as const));
  const orderedDescriptors = [...wallDescriptors].sort((left, right) => {
    const rankDelta = descriptorVisibilityRank(right) - descriptorVisibilityRank(left);
    if (rankDelta !== 0) return rankDelta;
    return left.wallIndex - right.wallIndex;
  });

  const blankWallIndices = orderedDescriptors
    .filter((descriptor) => buildSemanticAnchorCandidates(descriptor, baseline).length === 0)
    .map((descriptor) => descriptor.wallIndex);
  const blankWallRank = new Map(blankWallIndices.map((wallIndex, index) => [wallIndex, index] as const));

  return orderedDescriptors.map((descriptor) => {
    const rawCandidates = buildSemanticAnchorCandidates(descriptor, baseline);
    const assignment = determinePrimaryAnchor(rawCandidates);
    const qualification = qualificationByWallIndex.get(descriptor.wallIndex) || buildCandidateWallQualification(descriptor, baseline);
    return {
      descriptor,
      rawCandidates,
      qualification,
      assignedPrimary: assignment.primary,
      assignedSecondary: assignment.secondary,
      fallback: assignment.primary ? undefined : fallbackSemanticAnchorId(descriptor, blankWallRank.get(descriptor.wallIndex) || 0),
    } satisfies StagedSemanticIdentityState;
  });
}

function materializeSemanticWallModels(states: StagedSemanticIdentityState[]): SemanticWallModel[] {
  const anchoredStates = states.filter((state) => state.assignedPrimary && state.qualification.qualificationDecision === "qualified_semantic_wall");
  const provisionalNames = new Map<number, string>();
  for (const state of anchoredStates) {
    const displayName = state.assignedPrimary
      ? `wall containing ${state.assignedPrimary.label}`
      : state.fallback?.displayName || `wall ${state.descriptor.wallIndex}`;
    provisionalNames.set(state.descriptor.wallIndex, displayName);
  }
  return anchoredStates.map((state) => materializeSemanticWallModel(state, provisionalNames));
}

const SEMANTIC_WALL_MAPPING_CONFIDENCE_THRESHOLD = 15;

function buildBaselineGuidedVerificationPrompt(params: {
  canonicalModel: string;
  semanticBaselineWalls: SemanticWallModel[];
  advisoryGeometry: AdvisoryGeometryObservation[];
  retryReason?: string;
}): string {
  const baselineWallVerificationText = params.semanticBaselineWalls.length > 0
    ? params.semanticBaselineWalls.map((wall) => [
      `- semanticWallId: ${wall.semanticWallId}`,
      `  displayName: ${wall.displayName}`,
      `  primaryAnchor: ${wall.primaryAnchorLabel || "none"}`,
      `  baseline geometry: ${wall.geometryLines.join(" | ")}`,
    ].join("\n")).join("\n")
    : "- none";
  const advisoryGeometryText = params.advisoryGeometry.length > 0
    ? params.advisoryGeometry.map((item) => `- ${item.candidateId} (${item.advisoryPositionalLabel}) [${item.qualificationDecision}]: ${item.descriptor} | evidence: ${item.evidenceBreakdown.join(" | ")}`).join("\n")
    : "- none";
  const retryText = params.retryReason
    ? `\nRETRY INSTRUCTION:\n- The previous staged verification response failed integrity validation for this reason: ${params.retryReason}\n- Re-verify the same baseline walls carefully.\n- Do not rename walls, merge walls, split walls, or invent new identities.\n`
    : "";

  return `You are verifying whether the staged image still preserves the authoritative baseline architectural wall graph.

Review the BASELINE image and the STAGED image.

Only evaluate permanent architecture.
Ignore furniture, decor, styling, and movable objects.
The baseline graph is authoritative.
Do not extract the room again.
Do not rename walls.
Do not change wall ordering.
Do not merge walls.
Do not split walls.
Do not invent new semantic identities.

Your reasoning order is mandatory:
1. Verify each known baseline wall.
2. Verify the geometry of each known wall.
3. Observe any additional permanent architectural features not represented by the baseline semantic walls.

CANONICAL BASELINE ARCHITECTURAL MODEL:
${params.canonicalModel}

QUALIFIED BASELINE SEMANTIC WALLS TO VERIFY:
${baselineWallVerificationText}

BASELINE ADVISORY GEOMETRY (CORROBORATING ONLY; NEVER SEMANTIC IDENTITIES):
${advisoryGeometryText}

For each baseline semantic wall above, answer whether that same permanent wall is visible in the staged image.
If TRUE, describe only that wall using:
- wallVisibility
- wallExtent
- leftCornerVisible
- rightCornerVisible
- continuesBeyondFrame
- terminatesAtCorner
- returnWallVisible
- adjoiningWallVisible
- recessVisible
- architecturalCertainty
- confidence
- reason

After every known wall has been verified, report observational-only additional architectural features using these fields:
- additionalPermanentWallPlanes
- additionalPermanentWallPlaneDescriptions
- additionalPermanentCorners
- additionalPermanentCornerDescriptions
- additionalPermanentReturnWalls
- additionalPermanentReturnWallDescriptions
- additionalPermanentRecesses
- additionalPermanentRecessDescriptions
- unmatchedPermanentArchitecturalFeatures
- unmatchedPermanentFeatureDescriptions

Do not infer whether these observations imply architectural change.
${retryText}
Return JSON only:

{
  "answer":"TRUE"|"FALSE",
  "confidence":0.0-1.0,
  "analysis":"concise visual explanation",
  "selectedExplanation":"short primary explanation",
  "primaryHypothesis":"short primary hypothesis",
  "hypothesisConfidence":"Low"|"Medium"|"High",
  "visualAmbiguity":true|false,
  "boundaryLinesMissing":true|false,
  "continuousSurfaceReplacement":true|false,
  "noPlausibleVisualExplanation":true|false,
  "wallVerifications":[
    {
      "semanticWallId":"exact baseline semanticWallId",
      "displayName":"exact baseline displayName",
      "primaryAnchorLabel":"exact baseline primaryAnchorLabel",
      "samePermanentWallVisible":"TRUE"|"FALSE",
      "wallVisibility":"none"|"minimal"|"partial"|"substantial"|"dominant"|"complete"|"full",
      "wallExtent":"none"|"minimal"|"partial"|"substantial"|"dominant"|"complete"|"full",
      "architecturalCertainty":"known"|"partial"|"unknown",
      "leftCornerVisible":true|false,
      "rightCornerVisible":true|false,
      "continuesBeyondFrame":true|false,
      "terminatesAtCorner":true|false,
      "returnWallVisible":true|false,
      "adjoiningWallVisible":true|false,
      "recessVisible":true|false,
      "confidence":0.0-1.0,
      "reason":"required when samePermanentWallVisible is FALSE; otherwise optional",
      "observations":["short geometric observations"]
    }
  ],
  "additionalPermanentWallPlanes":"TRUE"|"FALSE",
  "additionalPermanentWallPlaneDescriptions":["additional permanent wall planes not represented by baseline semantic walls"],
  "additionalPermanentCorners":"TRUE"|"FALSE",
  "additionalPermanentCornerDescriptions":["additional permanent corners not represented by baseline semantic walls"],
  "additionalPermanentReturnWalls":"TRUE"|"FALSE",
  "additionalPermanentReturnWallDescriptions":["additional permanent return walls not represented by baseline semantic walls"],
  "additionalPermanentRecesses":"TRUE"|"FALSE",
  "additionalPermanentRecessDescriptions":["additional permanent recesses not represented by baseline semantic walls"],
  "unmatchedPermanentArchitecturalFeatures":"TRUE"|"FALSE",
  "unmatchedPermanentFeatureDescriptions":["permanent architectural features not associated with baseline semantic walls"]
}`;
}

function scoreSemanticWallMatch(
  baselineWall: SemanticWallModel,
  stagedWall: SemanticWallModel,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (baselineWall.primaryAnchorToken && stagedWall.primaryAnchorToken && baselineWall.primaryAnchorToken === stagedWall.primaryAnchorToken) {
    score += 20;
    reasons.push(`primary semantic anchor match: ${baselineWall.primaryAnchorLabel}`);
  }
  const sharedTokens = baselineWall.anchorTokens.filter((token) => stagedWall.anchorTokens.includes(token));
  if (sharedTokens.length > 0) {
    score += sharedTokens.length * 5;
    reasons.push(`shared anchor tokens: ${sharedTokens.join(", ")}`);
  }
  const geometryScore = wallGeometrySimilarity(baselineWall, stagedWall);
  if (geometryScore > 0) {
    score += geometryScore;
    reasons.push(`wall geometry similarity: ${geometryScore}`);
  }
  const sharedLabels = baselineWall.referenceAnchors.filter((label) => stagedWall.referenceAnchors.includes(label));
  if (sharedLabels.length > 0) {
    score += sharedLabels.length * 3;
    reasons.push(`shared anchors: ${sharedLabels.join(", ")}`);
  }
  if (baselineWall.advisoryPositionalLabel === stagedWall.advisoryPositionalLabel) {
    score += 1;
    reasons.push("same advisory positional label");
  }
  if (baselineWall.advisoryWallIndex === stagedWall.advisoryWallIndex) {
    score += 1;
    reasons.push("same advisory wall index");
  }
  return { score, reasons };
}

function normalizeVisibilityMagnitude(value: unknown): EnvelopeVisibilityMagnitude | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "minimal" || normalized === "partial" || normalized === "substantial" || normalized === "dominant" || normalized === "complete" || normalized === "full") {
    return normalized;
  }
  return undefined;
}

function buildStageVerificationDescription(
  wallVerifications: BaselineGuidedWallVerification[],
  additionalWallPlanes?: AdditionalWallPlanesResult,
): string {
  if (wallVerifications.length === 0) {
    return [
      "Staged Verification",
      "- No wall verifications were available.",
    ].join("\n");
  }

  const lines = [
    "Staged Verification",
    `- Verified baseline walls: ${wallVerifications.length}`,
  ];

  for (const item of wallVerifications) {
    const visibility = item.samePermanentWallVisible === "TRUE"
      ? `${item.wallVisibility || "unknown"} visibility, extent ${item.wallExtent || "unknown"}`
      : `not visible`;
    lines.push(`- ${item.displayName}: ${visibility}; leftCorner=${item.leftCornerVisible === true ? "yes" : item.leftCornerVisible === false ? "no" : "unknown"}; rightCorner=${item.rightCornerVisible === true ? "yes" : item.rightCornerVisible === false ? "no" : "unknown"}; continuesBeyondFrame=${item.continuesBeyondFrame === true ? "yes" : item.continuesBeyondFrame === false ? "no" : "unknown"}; returnWallVisible=${item.returnWallVisible === true ? "yes" : item.returnWallVisible === false ? "no" : "unknown"}; adjoiningWallVisible=${item.adjoiningWallVisible === true ? "yes" : item.adjoiningWallVisible === false ? "no" : "unknown"}; recessVisible=${item.recessVisible === true ? "yes" : item.recessVisible === false ? "no" : "unknown"}${item.reason ? ` -- ${item.reason}` : ""}`);
  }

  if (additionalWallPlanes) {
    lines.push(`- Additional permanent wall planes: ${additionalWallPlanes.answer}`);
    if (additionalWallPlanes.descriptions.length > 0) {
      for (const description of additionalWallPlanes.descriptions) {
        lines.push(`  - ${description}`);
      }
    }
  }

  return lines.join("\n");
}

function magnitudeLabelToRank(value?: EnvelopeVisibilityMagnitude): number {
  if (value === "none") return 0;
  if (value === "minimal") return 1;
  if (value === "partial") return 2;
  if (value === "substantial") return 3;
  if (value === "dominant") return 4;
  if (value === "complete") return 5;
  if (value === "full") return 6;
  return -1;
}

function isEdgeWeakGeometry(
  descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number],
  side: "left" | "right",
): boolean {
  const magnitude = wallVisibilityMagnitude(descriptor);
  const cornerMagnitude = cornerVisibilityMagnitude(descriptor, side);
  return edgeObservationContext(descriptor, side) === "frame_edge"
    && (magnitudeLabelToRank(magnitude) <= 2 || magnitudeLabelToRank(cornerMagnitude) <= 1);
}

function findBaselineDescriptorForSemanticWall(
  baseline: StructuralBaseline | null | undefined,
  wall: SemanticWallModel,
): NonNullable<StructuralBaseline["wallDescriptors"]>[number] | undefined {
  return (baseline?.wallDescriptors || []).find((descriptor) => descriptor.wallIndex === wall.advisoryWallIndex);
}

function buildDeterministicStructuralInterpretation(params: {
  interpretationId: string;
  category: DeterministicStructuralInterpretation["category"];
  wall?: SemanticWallModel;
  severity: DeterministicStructuralInterpretation["severity"];
  confidence: DeterministicStructuralInterpretation["confidence"];
  summary: string;
  supportingFacts: string[];
  corroboratingEvidence?: string[];
  contradictingEvidence?: string[];
}): DeterministicStructuralInterpretation {
  return {
    interpretationId: params.interpretationId,
    category: params.category,
    wallSemanticId: params.wall?.semanticWallId,
    wallDisplayName: params.wall?.displayName,
    severity: params.severity,
    confidence: params.confidence,
    summary: params.summary,
    supportingFacts: params.supportingFacts,
    corroboratingEvidence: params.corroboratingEvidence || [],
    contradictingEvidence: params.contradictingEvidence || [],
  };
}

function deriveDeterministicStructuralInterpretations(params: {
  baseline: StructuralBaseline | null | undefined;
  baselineWalls: SemanticWallModel[];
  stagedObservations: BaselineGuidedWallVerification[];
  additionalEvidence?: AdditionalArchitecturalEvidence;
}): DeterministicStructuralInterpretation[] {
  const stagedById = new Map(params.stagedObservations.map((item) => [item.semanticWallId, item] as const));
  const interpretations: DeterministicStructuralInterpretation[] = [];

  for (const baselineWall of params.baselineWalls) {
    const descriptor = findBaselineDescriptorForSemanticWall(params.baseline, baselineWall);
    const staged = stagedById.get(baselineWall.semanticWallId);
    if (!descriptor || !staged) continue;

    if (staged.samePermanentWallVisible === "FALSE") {
      const severe = wallVisibilityMagnitude(descriptor) === "full" || wallVisibilityMagnitude(descriptor) === "substantial";
      interpretations.push(buildDeterministicStructuralInterpretation({
        interpretationId: `interp_${baselineWall.semanticWallId}_removed`,
        category: "wall_plane_removed",
        wall: baselineWall,
        severity: severe ? "significant" : "advisory",
        confidence: severe ? "high" : "medium",
        summary: `${baselineWall.displayName} is no longer visible in the staged image.`,
        supportingFacts: [
          `baseline visibility=${wallVisibilityMagnitude(descriptor)}`,
          "staged samePermanentWallVisible=FALSE",
        ],
        corroboratingEvidence: staged.reason ? [staged.reason] : [],
      }));
      continue;
    }

    if (descriptor.continuesBeyondFrame === true && staged.continuesBeyondFrame === false) {
      const weak = exitedFrameSide(descriptor) ? isEdgeWeakGeometry(descriptor, exitedFrameSide(descriptor)!) : true;
      interpretations.push(buildDeterministicStructuralInterpretation({
        interpretationId: `interp_${baselineWall.semanticWallId}_shortened`,
        category: "wall_shortened",
        wall: baselineWall,
        severity: weak ? "advisory" : "significant",
        confidence: weak ? "low" : "high",
        summary: `${baselineWall.displayName} no longer continues beyond the frame in staged observation.`,
        supportingFacts: ["baseline continuesBeyondFrame=TRUE", "staged continuesBeyondFrame=FALSE"],
      }));
    }

    if (descriptor.continuesBeyondFrame !== true && staged.continuesBeyondFrame === true) {
      interpretations.push(buildDeterministicStructuralInterpretation({
        interpretationId: `interp_${baselineWall.semanticWallId}_extended`,
        category: "wall_extended",
        wall: baselineWall,
        severity: "significant",
        confidence: "high",
        summary: `${baselineWall.displayName} now continues beyond the frame in staged observation.`,
        supportingFacts: ["baseline continuesBeyondFrame=FALSE", "staged continuesBeyondFrame=TRUE"],
      }));
    }

    if (descriptor.leftCornerVisible !== true && staged.leftCornerVisible === true) {
      interpretations.push(buildDeterministicStructuralInterpretation({
        interpretationId: `interp_${baselineWall.semanticWallId}_left_corner_added`,
        category: "corner_introduced",
        wall: baselineWall,
        severity: edgeObservationContext(descriptor, "left") === "frame_edge" ? "significant" : "significant",
        confidence: edgeObservationContext(descriptor, "left") === "frame_edge" ? "high" : "high",
        summary: `${baselineWall.displayName} now shows a left corner that baseline did not show.`,
        supportingFacts: ["baseline leftCornerVisible=FALSE", "staged leftCornerVisible=TRUE"],
      }));
    }

    if (descriptor.leftCornerVisible === true && staged.leftCornerVisible === false) {
      const weak = isEdgeWeakGeometry(descriptor, "left");
      interpretations.push(buildDeterministicStructuralInterpretation({
        interpretationId: `interp_${baselineWall.semanticWallId}_left_corner_removed`,
        category: "corner_removed",
        wall: baselineWall,
        severity: weak ? "advisory" : "significant",
        confidence: weak ? "low" : "high",
        summary: `${baselineWall.displayName} no longer shows its baseline left corner.`,
        supportingFacts: ["baseline leftCornerVisible=TRUE", "staged leftCornerVisible=FALSE"],
      }));
    }

    if (descriptor.rightCornerVisible !== true && staged.rightCornerVisible === true) {
      interpretations.push(buildDeterministicStructuralInterpretation({
        interpretationId: `interp_${baselineWall.semanticWallId}_right_corner_added`,
        category: "corner_introduced",
        wall: baselineWall,
        severity: "significant",
        confidence: "high",
        summary: `${baselineWall.displayName} now shows a right corner that baseline did not show.`,
        supportingFacts: ["baseline rightCornerVisible=FALSE", "staged rightCornerVisible=TRUE"],
      }));
    }

    if (descriptor.rightCornerVisible === true && staged.rightCornerVisible === false) {
      const weak = isEdgeWeakGeometry(descriptor, "right");
      interpretations.push(buildDeterministicStructuralInterpretation({
        interpretationId: `interp_${baselineWall.semanticWallId}_right_corner_removed`,
        category: "corner_removed",
        wall: baselineWall,
        severity: weak ? "advisory" : "significant",
        confidence: weak ? "low" : "high",
        summary: `${baselineWall.displayName} no longer shows its baseline right corner.`,
        supportingFacts: ["baseline rightCornerVisible=TRUE", "staged rightCornerVisible=FALSE"],
      }));
    }

    const baselineFrameSide = exitedFrameSide(descriptor);
    if (baselineFrameSide && staged.returnWallVisible === true) {
      interpretations.push(buildDeterministicStructuralInterpretation({
        interpretationId: `interp_${baselineWall.semanticWallId}_return_wall_added`,
        category: "return_wall_introduced",
        wall: baselineWall,
        severity: "significant",
        confidence: "high",
        summary: `${baselineWall.displayName} now has a visible return wall at the frame edge.`,
        supportingFacts: ["baseline returnWallVisible=FALSE", "staged returnWallVisible=TRUE"],
      }));
    }

    if (baselineFrameSide && staged.adjoiningWallVisible === true) {
      interpretations.push(buildDeterministicStructuralInterpretation({
        interpretationId: `interp_${baselineWall.semanticWallId}_adjoining_wall_added`,
        category: "adjoining_wall_introduced",
        wall: baselineWall,
        severity: "significant",
        confidence: "high",
        summary: `${baselineWall.displayName} now has an adjoining wall plane visible at the frame edge.`,
        supportingFacts: ["baseline adjoiningWallVisible=FALSE", "staged adjoiningWallVisible=TRUE"],
      }));
    }

    if (baselineFrameSide && staged.recessVisible === true) {
      interpretations.push(buildDeterministicStructuralInterpretation({
        interpretationId: `interp_${baselineWall.semanticWallId}_recess_added`,
        category: "recess_introduced",
        wall: baselineWall,
        severity: "significant",
        confidence: "high",
        summary: `${baselineWall.displayName} now has a visible recess at the frame edge.`,
        supportingFacts: ["baseline recessVisible=FALSE", "staged recessVisible=TRUE"],
      }));
    }
  }

  if (params.additionalEvidence?.additionalPermanentWallPlanes === "TRUE") {
    interpretations.push(buildDeterministicStructuralInterpretation({
      interpretationId: "interp_additional_wall_planes",
      category: "wall_plane_introduced",
      severity: "significant",
      confidence: "medium",
      summary: "Guided staged observation reports extra wall planes not associated with baseline semantic walls.",
      supportingFacts: ["additional observed architectural features: additionalPermanentWallPlanes=TRUE"],
      corroboratingEvidence: params.additionalEvidence.additionalPermanentWallPlaneDescriptions,
    }));
  }

  if (params.additionalEvidence?.additionalPermanentReturnWalls === "TRUE") {
    interpretations.push(buildDeterministicStructuralInterpretation({
      interpretationId: "interp_additional_return_walls",
      category: "return_wall_introduced",
      severity: "significant",
      confidence: "medium",
      summary: "Guided staged observation reports return walls beyond the baseline model.",
      supportingFacts: ["additional observed architectural features: additionalPermanentReturnWalls=TRUE"],
      corroboratingEvidence: params.additionalEvidence.additionalPermanentReturnWallDescriptions,
    }));
  }

  if (params.additionalEvidence?.additionalPermanentRecesses === "TRUE") {
    interpretations.push(buildDeterministicStructuralInterpretation({
      interpretationId: "interp_additional_recesses",
      category: "recess_introduced",
      severity: "significant",
      confidence: "medium",
      summary: "Guided staged observation reports recesses beyond the baseline model.",
      supportingFacts: ["additional observed architectural features: additionalPermanentRecesses=TRUE"],
      corroboratingEvidence: params.additionalEvidence.additionalPermanentRecessDescriptions,
    }));
  }

  if (params.additionalEvidence?.additionalPermanentCorners === "TRUE") {
    interpretations.push(buildDeterministicStructuralInterpretation({
      interpretationId: "interp_additional_corners",
      category: "corner_introduced",
      severity: "significant",
      confidence: "medium",
      summary: "Guided staged observation reports corners not accounted for by baseline semantic walls.",
      supportingFacts: ["additional observed architectural features: additionalPermanentCorners=TRUE"],
      corroboratingEvidence: params.additionalEvidence.additionalPermanentCornerDescriptions,
    }));
  }

  return interpretations;
}

function materializeSemanticWallModelsFromVerifications(
  baselineWalls: SemanticWallModel[],
  wallVerifications: BaselineGuidedWallVerification[],
): SemanticWallModel[] {
  const baselineById = new Map(baselineWalls.map((wall) => [wall.semanticWallId, wall] as const));
  return wallVerifications
    .filter((item) => item.samePermanentWallVisible === "TRUE")
    .map((item) => {
      const baselineWall = baselineById.get(item.semanticWallId);
      const displayName = baselineWall?.displayName || item.displayName;
      const geometryLines = [
        `${displayName} visibility: ${item.wallVisibility || "unknown"}`,
        `wall extent: ${item.wallExtent || item.wallVisibility || "unknown"}`,
        item.leftCornerVisible === true ? `visible left corner on ${displayName}` : `no visible left corner on ${displayName}`,
        item.rightCornerVisible === true ? `visible right corner on ${displayName}` : `no visible right corner on ${displayName}`,
        item.continuesBeyondFrame === true ? `${displayName} continues beyond the image frame` : `${displayName} does not continue beyond the image frame`,
        item.terminatesAtCorner === true ? `${displayName} terminates at an observed corner` : `${displayName} does not terminate at an observed corner`,
        item.returnWallVisible === true ? `return wall visible adjacent to ${displayName}` : `no visible return wall adjacent to ${displayName}`,
        item.adjoiningWallVisible === true ? `adjoining wall plane visible adjacent to ${displayName}` : `no visible adjoining wall plane adjacent to ${displayName}`,
        item.recessVisible === true ? `recess visible adjacent to ${displayName}` : `no visible recess adjacent to ${displayName}`,
        ...item.observations,
      ];
      return {
        semanticWallId: item.semanticWallId,
        displayName,
        primaryAnchorLabel: baselineWall?.primaryAnchorLabel || item.primaryAnchorLabel,
        primaryAnchorToken: baselineWall?.primaryAnchorToken,
        secondaryArchitecturalFeatures: baselineWall?.secondaryArchitecturalFeatures || [],
        rawArchitecturalFeatures: baselineWall?.rawArchitecturalFeatures || (item.primaryAnchorLabel ? [item.primaryAnchorLabel] : []),
        rawAnchorTokens: baselineWall?.rawAnchorTokens || [],
        advisoryWallIndex: baselineWall?.advisoryWallIndex ?? -1,
        advisoryPositionalLabel: baselineWall?.advisoryPositionalLabel || "verified wall",
        referenceAnchors: baselineWall?.referenceAnchors || (item.primaryAnchorLabel ? [item.primaryAnchorLabel] : [displayName]),
        anchorTokens: baselineWall?.anchorTokens || [],
        geometryLines,
        visibility: item.wallVisibility || "partial",
        visibleExtent: item.wallExtent || item.wallVisibility || "partial",
        descriptor: item.reason || item.observations.join(" | ") || displayName,
      } satisfies SemanticWallModel;
    });
}

function evaluateStagedVerificationIntegrity(
  baselineWalls: SemanticWallModel[],
  wallVerifications: BaselineGuidedWallVerification[],
  attempt: number,
): StagedExtractionIntegrityResult {
  const issues: StagedExtractionIntegrityIssue[] = [];
  const verificationById = new Map<string, BaselineGuidedWallVerification[]>();
  for (const verification of wallVerifications) {
    const existing = verificationById.get(verification.semanticWallId) || [];
    existing.push(verification);
    verificationById.set(verification.semanticWallId, existing);
  }

  for (const baselineWall of baselineWalls) {
    const matches = verificationById.get(baselineWall.semanticWallId) || [];
    if (matches.length === 0) {
      issues.push({
        code: "missing_required_anchor",
        baselineSemanticWallId: baselineWall.semanticWallId,
        message: `Baseline wall ${baselineWall.displayName} was not verified in the staged response.`,
      });
      continue;
    }
    if (matches.length > 1) {
      issues.push({
        code: "duplicate_primary_anchor",
        baselineSemanticWallId: baselineWall.semanticWallId,
        message: `Baseline wall ${baselineWall.displayName} was returned multiple times in staged verification.`,
      });
    }
    const verification = matches[0];
    if ((verification.displayName || "").trim() !== baselineWall.displayName.trim()) {
      issues.push({
        code: "ambiguous_mapping",
        baselineSemanticWallId: baselineWall.semanticWallId,
        message: `Baseline wall ${baselineWall.displayName} was renamed to ${verification.displayName || "(missing)"} in staged verification.`,
      });
    }
    if ((baselineWall.primaryAnchorLabel || "").trim() !== (verification.primaryAnchorLabel || "").trim()) {
      issues.push({
        code: "primary_anchor_mismatch",
        baselineSemanticWallId: baselineWall.semanticWallId,
        message: `Baseline wall ${baselineWall.displayName} returned primary anchor ${(verification.primaryAnchorLabel || "(missing)")} instead of ${(baselineWall.primaryAnchorLabel || "(missing)")}.`,
      });
    }
    if (Number.isFinite(verification.confidence) && Number(verification.confidence) < 0.5) {
      issues.push({
        code: "low_confidence_mapping",
        baselineSemanticWallId: baselineWall.semanticWallId,
        message: `Baseline wall ${baselineWall.displayName} was verified with low confidence ${verification.confidence}.`,
      });
    }
  }

  return {
    passed: issues.length === 0,
    attempt,
    mappingConfidenceThreshold: 0.5,
    issues,
  };
}

function evaluateStagedExtractionIntegrity(
  baselineWalls: SemanticWallModel[],
  stagedWalls: SemanticWallModel[],
  attempt: number,
): StagedExtractionIntegrityResult {
  const issues: StagedExtractionIntegrityIssue[] = [];

  for (const wall of stagedWalls) {
    if (wall.rawAnchorTokens.length > 1) {
      issues.push({
        code: "primary_anchor_conflict",
        stagedSemanticWallId: wall.semanticWallId,
        message: `${wall.displayName} contains multiple architectural anchors: ${wall.rawArchitecturalFeatures.join(", ")}.`,
      });
    }
  }

  const stagedByPrimaryToken = new Map<string, SemanticWallModel[]>();
  for (const wall of stagedWalls) {
    if (!wall.primaryAnchorToken) continue;
    const existing = stagedByPrimaryToken.get(wall.primaryAnchorToken) || [];
    existing.push(wall);
    stagedByPrimaryToken.set(wall.primaryAnchorToken, existing);
  }
  for (const [token, walls] of stagedByPrimaryToken) {
    if (walls.length < 2) continue;
    issues.push({
      code: "duplicate_primary_anchor",
      stagedSemanticWallId: walls[0]?.semanticWallId,
      message: `Primary anchor ${token} appears on multiple staged walls: ${walls.map((wall) => wall.displayName).join(", ")}.`,
    });
  }

  for (const baselineWall of baselineWalls) {
    const candidates = stagedWalls
      .map((stagedWall) => ({ stagedWall, ...scoreSemanticWallMatch(baselineWall, stagedWall) }))
      .sort((left, right) => right.score - left.score || left.stagedWall.semanticWallId.localeCompare(right.stagedWall.semanticWallId));

    const directAnchorMatch = baselineWall.primaryAnchorToken
      ? stagedWalls.find((wall) => wall.primaryAnchorToken === baselineWall.primaryAnchorToken)
      : undefined;
    if (!directAnchorMatch) {
      issues.push({
        code: "missing_required_anchor",
        baselineSemanticWallId: baselineWall.semanticWallId,
        message: `Baseline wall ${baselineWall.displayName} could not be matched to any staged wall by primary anchor.`,
      });
      continue;
    }

    const best = candidates[0];
    const second = candidates[1];
    if (!best) continue;
    if (second && second.score === best.score) {
      issues.push({
        code: "ambiguous_mapping",
        baselineSemanticWallId: baselineWall.semanticWallId,
        message: `Baseline wall ${baselineWall.displayName} has equally strong staged matches ${best.stagedWall.displayName} and ${second.stagedWall.displayName}.`,
      });
    }
    if (best.score < SEMANTIC_WALL_MAPPING_CONFIDENCE_THRESHOLD) {
      issues.push({
        code: "low_confidence_mapping",
        baselineSemanticWallId: baselineWall.semanticWallId,
        stagedSemanticWallId: best.stagedWall.semanticWallId,
        message: `Baseline wall ${baselineWall.displayName} matched ${best.stagedWall.displayName} with low confidence score ${best.score}.`,
      });
    }
  }

  return {
    passed: issues.length === 0,
    attempt,
    mappingConfidenceThreshold: SEMANTIC_WALL_MAPPING_CONFIDENCE_THRESHOLD,
    issues,
  };
}

function stabilizeStagedSemanticWallModels(
  baselineWalls: SemanticWallModel[],
  staged?: StructuralBaseline | null,
): {
  initialWalls: SemanticWallModel[];
  finalWalls: SemanticWallModel[];
  audit: SemanticWallIdentityAudit;
} {
  const initialStates = buildSemanticWallIdentityStates(staged);
  const initialWalls = materializeSemanticWallModels(initialStates);
  const baselinePrimaryWalls = baselineWalls.filter((wall) => wall.primaryAnchorToken);
  const baselineByPrimaryToken = new Map(baselinePrimaryWalls.map((wall) => [wall.primaryAnchorToken!, wall] as const));

  const mergedStates = initialStates.filter((state) => {
    const baselinePrimaryHits = state.rawCandidates.filter((candidate) => baselineByPrimaryToken.has(candidate.token));
    return baselinePrimaryHits.length > 1;
  });
  const blankStates = initialStates.filter((state) => !state.assignedPrimary);

  if (mergedStates.length === 0 || blankStates.length === 0) {
    return {
      initialWalls,
      finalWalls: initialWalls,
      audit: {
        regenerationOccurred: false,
        mergedSemanticWallsDetected: false,
        ambiguityDetected: false,
        initialStagedWallCount: initialWalls.length,
        finalStagedWallCount: initialWalls.length,
        notes: [],
      },
    };
  }

  const auditNotes: string[] = [];
  for (const merged of mergedStates) {
    const candidateTokens = merged.rawCandidates.filter((candidate) => baselineByPrimaryToken.has(candidate.token));
    const slots = [merged, ...blankStates.filter((state) => !state.assignedPrimary)];
    const usedSlots = new Set<StagedSemanticIdentityState>();
    const assignments = new Map<string, StagedSemanticIdentityState>();

    const sortedCandidates = [...candidateTokens].sort((left, right) => {
      const leftCurrent = merged.assignedPrimary?.token === left.token ? 1 : 0;
      const rightCurrent = merged.assignedPrimary?.token === right.token ? 1 : 0;
      if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
      return left.priority - right.priority;
    });

    for (const candidate of sortedCandidates) {
      const baselineWall = baselineByPrimaryToken.get(candidate.token);
      if (!baselineWall) continue;
      let bestSlot: StagedSemanticIdentityState | undefined;
      let bestScore = -Infinity;
      for (const slot of slots) {
        if (usedSlots.has(slot)) continue;
        const slotPreview = materializeSemanticWallModel(slot, new Map(slots.map((item) => [item.descriptor.wallIndex, item.assignedPrimary ? `wall containing ${item.assignedPrimary.label}` : item.fallback?.displayName || `wall ${item.descriptor.wallIndex}`])));
        let score = wallGeometrySimilarity(baselineWall, slotPreview);
        if (slot.rawCandidates.some((raw) => raw.token === candidate.token)) score += 100;
        if (slot.descriptor.wallIndex === baselineWall.advisoryWallIndex) score += 2;
        if (slotPreview.advisoryPositionalLabel === baselineWall.advisoryPositionalLabel) score += 1;
        if (score > bestScore) {
          bestScore = score;
          bestSlot = slot;
        }
      }
      if (bestSlot) {
        assignments.set(candidate.token, bestSlot);
        usedSlots.add(bestSlot);
      }
    }

    if (assignments.size > 1) {
      for (const [token, slot] of assignments) {
        const assignedCandidate = slot.rawCandidates.find((candidate) => candidate.token === token)
          || merged.rawCandidates.find((candidate) => candidate.token === token);
        if (!assignedCandidate) continue;
        slot.assignedPrimary = assignedCandidate;
        slot.assignedSecondary = slot.rawCandidates.filter((candidate) => candidate.token !== assignedCandidate.token);
        slot.fallback = undefined;
        if (slot !== merged && !slot.rawCandidates.some((candidate) => candidate.token === token)) {
          slot.identityAmbiguity = `Primary anchor ${assignedCandidate.label} reassigned during staged semantic identity regeneration.`;
        }
      }
      if (merged.assignedPrimary) {
        merged.assignedSecondary = merged.rawCandidates.filter((candidate) => candidate.token !== merged.assignedPrimary?.token);
      }
      auditNotes.push(`Regenerated staged semantic wall identities because baseline primary anchors collapsed into staged wall ${merged.descriptor.wallIndex}.`);
    }
  }

  const finalWalls = materializeSemanticWallModels(initialStates);
  const mergedDetected = finalWalls.some((wall) => (wall.rawAnchorTokens.filter((token) => baselineByPrimaryToken.has(token)).length > 1));
  return {
    initialWalls,
    finalWalls,
    audit: {
      regenerationOccurred: auditNotes.length > 0,
      reason: auditNotes[0],
      mergedSemanticWallsDetected: mergedDetected,
      ambiguityDetected: mergedDetected,
      initialStagedWallCount: initialWalls.length,
      finalStagedWallCount: finalWalls.length,
      notes: auditNotes.length > 0 ? auditNotes : mergedDetected ? ["Merged semantic walls persisted after staged identity regeneration."] : [],
    },
  };
}

function descriptorVisibilityRank(descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number]): number {
  const magnitude = wallVisibilityMagnitude(descriptor);
  return visibilityRank(magnitude);
}

function fallbackSemanticAnchorId(
  descriptor: NonNullable<StructuralBaseline["wallDescriptors"]>[number],
  rankAmongBlankWalls: number,
): { semanticWallId: string; displayName: string; anchors: string[]; tokens: string[] } {
  if (rankAmongBlankWalls === 0) {
    return {
      semanticWallId: "largest_blank_wall",
      displayName: "largest blank wall",
      anchors: ["largest blank wall"],
      tokens: ["blank_wall:largest"],
    };
  }

  return {
    semanticWallId: `blank_wall_${rankAmongBlankWalls + 1}`,
    displayName: `secondary blank wall ${rankAmongBlankWalls + 1}`,
    anchors: [`secondary blank wall ${rankAmongBlankWalls + 1}`],
    tokens: [`blank_wall:${rankAmongBlankWalls + 1}`],
  };
}

function semanticJoinLabel(wallIdByIndex: Map<number, string>, wallIndex: number, adjacentIndex: number): string {
  return wallIdByIndex.get(adjacentIndex) || wallShortLabelForEnvelope(adjacentIndex) || `wall ${adjacentIndex}`;
}

export function buildSemanticWallModels(baseline?: StructuralBaseline | null): SemanticWallModel[] {
  return materializeSemanticWallModels(buildSemanticWallIdentityStates(baseline));
}

export function matchSemanticWalls(
  baselineWalls: SemanticWallModel[],
  stagedWalls: SemanticWallModel[],
): SemanticWallMatch[] {
  const remaining = new Set(stagedWalls.map((item) => item.semanticWallId));
  const stagedById = new Map(stagedWalls.map((item) => [item.semanticWallId, item] as const));
  const matches: SemanticWallMatch[] = [];

  for (const base of baselineWalls) {
    let best: SemanticWallModel | undefined;
    let bestScore = -1;
    let reasons: string[] = [];
    for (const staged of stagedWalls) {
      if (!remaining.has(staged.semanticWallId)) continue;
      const { score, reasons: currentReasons } = scoreSemanticWallMatch(base, staged);
      if (score > bestScore) {
        bestScore = score;
        best = staged;
        reasons = currentReasons;
      }
    }

    if (best && bestScore > 0) {
      remaining.delete(best.semanticWallId);
      matches.push({
        baselineSemanticWallId: base.semanticWallId,
        baselineDisplayName: base.displayName,
        stagedSemanticWallId: best.semanticWallId,
        stagedDisplayName: best.displayName,
        matched: true,
        score: bestScore,
        reasons,
      });
      continue;
    }

    matches.push({
      baselineSemanticWallId: base.semanticWallId,
      baselineDisplayName: base.displayName,
      matched: false,
      score: 0,
      reasons: ["no staged wall with matching semantic anchors"],
    });
  }

  for (const stagedId of remaining) {
    const staged = stagedById.get(stagedId);
    if (!staged) continue;
    matches.push({
      baselineSemanticWallId: "unmatched_baseline_wall",
      baselineDisplayName: "no baseline wall matched",
      stagedSemanticWallId: staged.semanticWallId,
      stagedDisplayName: staged.displayName,
      matched: false,
      score: 0,
      reasons: ["staged wall introduced without baseline semantic anchor match"],
    });
  }

  return matches;
}

function buildBaselineStatement(
  statement: Omit<EnvelopeBaselineVerificationStatement, "statementId">,
  index: number,
): EnvelopeBaselineVerificationStatement {
  return {
    statementId: `stmt_${String(index + 1).padStart(2, "0")}`,
    ...statement,
  };
}

function buildEnvelopeConstraintVerificationArtifacts(baseline?: StructuralBaseline | null): {
  canonicalModel: string;
  statements: EnvelopeBaselineVerificationStatement[];
} {
  if (!baseline) {
    const statements = [buildBaselineStatement({
      statement: "No additional permanent wall planes are visible beyond the authoritative baseline envelope.",
      scope: "structural",
      reasoningLayer: "structural_interpretation",
      architecturalContext: "global_geometry",
      factType: "global_visible_walls",
      failureEventHint: "new_wall_plane_introduced",
      supportingFacts: ["baseline_unavailable"],
    }, 0)];
    return {
      canonicalModel: [
        "Canonical Architectural Constraint Model",
        "- Baseline extraction unavailable.",
        "- Treat the baseline validator output as the only known envelope reference.",
      ].join("\n"),
      statements,
    };
  }

  const wallDescriptors = Array.isArray(baseline.wallDescriptors) ? baseline.wallDescriptors : [];
  const semanticWalls = buildSemanticWallModels(baseline);
  const displayNameByIndex = new Map(semanticWalls.map((wall) => [wall.advisoryWallIndex, wall.displayName] as const));
  const orderedDescriptors = semanticWalls
    .map((wall) => wallDescriptors.find((descriptor) => descriptor.wallIndex === wall.advisoryWallIndex))
    .filter((descriptor): descriptor is NonNullable<StructuralBaseline["wallDescriptors"]>[number] => !!descriptor);

  const visibleWalls = semanticWalls.map((wall) => wall.displayName);
  const modelLines: string[] = [
    "Canonical Architectural Constraint Model",
    `- Camera orientation: ${baseline.cameraOrientation || "unknown"}`,
    `- Visible wall planes: ${visibleWalls.length > 0 ? visibleWalls.join(", ") : "none explicitly extracted"}`,
  ];

  const statements: EnvelopeBaselineVerificationStatement[] = [];

  for (const descriptor of orderedDescriptors) {
    const semanticWall = semanticWalls.find((wall) => wall.advisoryWallIndex === descriptor.wallIndex);
    const wallDisplayName = semanticWall?.displayName || wallShortLabelForEnvelope(descriptor.wallIndex);
    const wallHeader = wallDisplayName.replace(/^./, (value) => value.toUpperCase());
    const wallMagnitude = wallVisibilityMagnitude(descriptor);
    const leftContext = edgeObservationContext(descriptor, "left");
    const rightContext = edgeObservationContext(descriptor, "right");
    const leftCornerMagnitude = cornerVisibilityMagnitude(descriptor, "left");
    const rightCornerMagnitude = cornerVisibilityMagnitude(descriptor, "right");
    const terminationSide = descriptor.terminatesAtCorner === true
      ? descriptor.leftCornerVisible === true && descriptor.rightCornerVisible !== true
        ? "left"
        : descriptor.rightCornerVisible === true && descriptor.leftCornerVisible !== true
          ? "right"
          : null
      : null;
    const wallLines: string[] = [
      wallHeader,
      `- semantic wall identifier: ${wallDisplayName}`,
      `- architectural anchors used only for wall identity: ${(semanticWall?.referenceAnchors || [wallDisplayName]).join(", ")}`,
      `- wall visibility observation: ${visibilityPhrase(descriptor).replace(wallShortLabelForEnvelope(descriptor.wallIndex), wallDisplayName)}`,
      `- ${magnitudeLine("wall", wallMagnitude)}`,
      "- Left edge transition",
      `  - continues beyond frame: ${leftContext === "frame_edge" ? "yes" : "no"}`,
      `  - visible corner: ${descriptor.leftCornerVisible === true ? "yes" : "no"}`,
      `  - left corner visibility magnitude: ${leftCornerMagnitude}`,
      `  - wall termination visibility: ${terminationSide === "left" ? "observed" : leftContext === "frame_edge" ? "not observed" : "not resolved from baseline view"}`,
      `  - return wall visibility: ${leftContext === "frame_edge" ? "none" : "not resolved from baseline view"}`,
      `  - adjoining wall plane visibility: ${leftContext === "frame_edge" ? "none" : "not resolved from baseline view"}`,
      `  - recess visibility: ${leftContext === "frame_edge" ? "none" : "not resolved from baseline view"}`,
      "- Right edge transition",
      `  - continues beyond frame: ${rightContext === "frame_edge" ? "yes" : "no"}`,
      `  - visible corner: ${descriptor.rightCornerVisible === true ? "yes" : "no"}`,
      `  - right corner visibility magnitude: ${rightCornerMagnitude}`,
      `  - wall termination visibility: ${terminationSide === "right" ? "observed" : rightContext === "frame_edge" ? "not observed" : "not resolved from baseline view"}`,
      `  - return wall visibility: ${rightContext === "frame_edge" ? "none" : "not resolved from baseline view"}`,
      `  - adjoining wall plane visibility: ${rightContext === "frame_edge" ? "none" : "not resolved from baseline view"}`,
      `  - recess visibility: ${rightContext === "frame_edge" ? "none" : "not resolved from baseline view"}`,
    ];

    statements.push(buildBaselineStatement({
      statement: `${visibilityPhrase(descriptor).replace(wallShortLabelForEnvelope(descriptor.wallIndex), wallDisplayName)}.`,
      scope: "structural",
      reasoningLayer: "geometric_observation",
      architecturalContext: "primary_wall_geometry",
      factType: "wall_visibility",
      failureEventHint: "wall_surface_missing",
      relatedWallIndex: descriptor.wallIndex,
      supportingFacts: [descriptor.visibility, descriptor.visibleExtent || descriptor.visibility],
    }, statements.length));

    statements.push(buildBaselineStatement({
      statement: `${wallDisplayName.replace(/^./, (value) => value.toUpperCase())} visibility remains ${wallMagnitude}.`,
      scope: "structural",
      reasoningLayer: "geometric_observation",
      architecturalContext: "primary_wall_geometry",
      factType: "wall_visibility_magnitude",
      failureEventHint: "wall_surface_missing",
      relatedWallIndex: descriptor.wallIndex,
      supportingFacts: [`baseline_magnitude:${wallMagnitude}`],
    }, statements.length));

    const continuation = describeFrameContinuation(descriptor);
    if (continuation) {
      wallLines.push(`- ${continuation.replace(wallShortLabelForEnvelope(descriptor.wallIndex), wallDisplayName)}`);
      statements.push(buildBaselineStatement({
        statement: `${continuation.replace(wallShortLabelForEnvelope(descriptor.wallIndex), wallDisplayName).replace(/^./, (value) => value.toUpperCase())}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: "frame_edge",
        edgeSide: exitedFrameSide(descriptor) || undefined,
        factType: "wall_continuation",
        failureEventHint: "wall_termination_changed",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: ["continues_beyond_frame"],
      }, statements.length));
    }

    if (descriptor.leftCornerVisible === true) {
      const joinTarget = displayNameByIndex.get(adjacentWallIndex(descriptor.wallIndex, "left"));
      const join = joinTarget
        ? `${wallDisplayName} joins ${joinTarget} at a visible left corner`
        : `A visible left corner is observed on ${wallDisplayName}`;
      statements.push(buildBaselineStatement({
        statement: `${join.replace(/^./, (value) => value.toUpperCase())}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: leftContext,
        edgeSide: "left",
        factType: "visible_corner",
        failureEventHint: "room_corner_removed",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: ["left_corner_visible"],
      }, statements.length));
      statements.push(buildBaselineStatement({
        statement: `Left corner visibility on ${wallDisplayName} remains ${leftCornerMagnitude}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: leftContext,
        edgeSide: "left",
        factType: "corner_visibility_magnitude",
        failureEventHint: "room_corner_removed",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: ["left_corner_visible", `baseline_magnitude:${leftCornerMagnitude}`],
      }, statements.length));
    } else {
      const noCorner = `No visible left corner is observed on ${wallDisplayName}`;
      statements.push(buildBaselineStatement({
        statement: `${noCorner}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: leftContext,
        edgeSide: "left",
        factType: "no_visible_corner",
        failureEventHint: "room_corner_added",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: ["left_corner_not_visible", "baseline_magnitude:none"],
      }, statements.length));
    }

    if (descriptor.rightCornerVisible === true) {
      const joinTarget = displayNameByIndex.get(adjacentWallIndex(descriptor.wallIndex, "right"));
      const join = joinTarget
        ? `${wallDisplayName} joins ${joinTarget} at a visible right corner`
        : `A visible right corner is observed on ${wallDisplayName}`;
      statements.push(buildBaselineStatement({
        statement: `${join.replace(/^./, (value) => value.toUpperCase())}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: rightContext,
        edgeSide: "right",
        factType: "visible_corner",
        failureEventHint: "room_corner_removed",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: ["right_corner_visible"],
      }, statements.length));
      statements.push(buildBaselineStatement({
        statement: `Right corner visibility on ${wallDisplayName} remains ${rightCornerMagnitude}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: rightContext,
        edgeSide: "right",
        factType: "corner_visibility_magnitude",
        failureEventHint: "room_corner_removed",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: ["right_corner_visible", `baseline_magnitude:${rightCornerMagnitude}`],
      }, statements.length));
    } else {
      const noCorner = `No visible right corner is observed on ${wallDisplayName}`;
      statements.push(buildBaselineStatement({
        statement: `${noCorner}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: rightContext,
        edgeSide: "right",
        factType: "no_visible_corner",
        failureEventHint: "room_corner_added",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: ["right_corner_not_visible", "baseline_magnitude:none"],
      }, statements.length));
    }

    if (terminationSide) {
      const statement = `${wallDisplayName} terminates at an observed corner`;
      statements.push(buildBaselineStatement({
        statement: `${statement.charAt(0).toUpperCase()}${statement.slice(1)}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: edgeObservationContext(descriptor, terminationSide),
        edgeSide: terminationSide,
        factType: "terminates_at_corner",
        failureEventHint: "wall_termination_changed",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: ["terminates_at_corner"],
      }, statements.length));
    }

    const frameSide = exitedFrameSide(descriptor);
    if (continuation && frameSide) {
      statements.push(buildBaselineStatement({
        statement: `No visible return wall is present at the ${frameSide} edge of ${wallDisplayName}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: "frame_edge",
        edgeSide: frameSide,
        factType: "no_visible_return_wall",
        failureEventHint: "new_wall_plane_introduced",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: [`edge:${frameSide}`, "baseline_magnitude:none"],
      }, statements.length));
      statements.push(buildBaselineStatement({
        statement: `No visible adjoining wall plane is present at the ${frameSide} edge of ${wallDisplayName}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: "frame_edge",
        edgeSide: frameSide,
        factType: "no_visible_adjoining_wall_plane",
        failureEventHint: "new_wall_plane_introduced",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: [`edge:${frameSide}`, "baseline_magnitude:none"],
      }, statements.length));
      statements.push(buildBaselineStatement({
        statement: `No visible recess is present at the ${frameSide} edge of ${wallDisplayName}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: "frame_edge",
        edgeSide: frameSide,
        factType: "no_visible_recess",
        failureEventHint: "new_wall_plane_introduced",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: [`edge:${frameSide}`, "baseline_magnitude:none"],
      }, statements.length));
      statements.push(buildBaselineStatement({
        statement: `No visible wall termination is present at the ${frameSide} edge of ${wallDisplayName}.`,
        scope: "structural",
        reasoningLayer: "geometric_observation",
        architecturalContext: "frame_edge",
        edgeSide: frameSide,
        factType: "no_visible_wall_termination",
        failureEventHint: "wall_termination_changed",
        relatedWallIndex: descriptor.wallIndex,
        supportingFacts: [`edge:${frameSide}`, "baseline_magnitude:none"],
      }, statements.length));
    }

    modelLines.push(...wallLines);
  }

  statements.push(buildBaselineStatement({
    statement: "No additional permanent wall planes are visible beyond the baseline wall set once all wall-edge observations are accounted for.",
    scope: "structural",
    reasoningLayer: "structural_interpretation",
    architecturalContext: "global_geometry",
    factType: "global_visible_walls",
    failureEventHint: "new_wall_plane_introduced",
    supportingFacts: [...visibleWalls, "derived_from_verified_edge_observations"],
  }, statements.length));

  return {
    canonicalModel: modelLines.join("\n"),
    statements,
  };
}

function buildEnvelopeAdvisoryStageExtractionDescription(
  staged?: StructuralBaseline | null,
  semanticWalls?: SemanticWallModel[],
): string {
  if (!staged) {
    return [
      "Advisory Stage Extraction",
      "- No staged extraction was available.",
    ].join("\n");
  }

  const stagedSemanticWalls = semanticWalls || buildSemanticWallModels(staged);

  const lines = [
    "Advisory Stage Extraction",
    `- Camera orientation: ${staged.cameraOrientation || "unknown"}`,
    `- Visible wall planes: ${stagedSemanticWalls.length}`,
  ];

  for (const wall of stagedSemanticWalls) {
    lines.push(`- ${wall.displayName} (${wall.advisoryPositionalLabel}): ${wall.descriptor}`);
  }

  return lines.join("\n");
}

function mapVerificationHintToEvent(
  hint: EnvelopeVerificationFailure["failureEventHint"],
): Pick<EnvelopeArchitecturalEventCandidate, "eventId" | "eventName" | "reasonToken"> {
  if (hint === "new_wall_plane_introduced") {
    return { eventId: "wall_added", eventName: "New wall surface added", reasonToken: "wall_added" };
  }
  if (hint === "wall_surface_missing") {
    return { eventId: "wall_removed", eventName: "Wall surface removed", reasonToken: "wall_removed" };
  }
  if (hint === "room_corner_added") {
    return { eventId: "room_corner_added", eventName: "New room corner added", reasonToken: "room_corner_added" };
  }
  if (hint === "room_corner_removed") {
    return { eventId: "room_corner_removed", eventName: "Room corner removed", reasonToken: "room_corner_removed" };
  }
  return { eventId: "wall_plane_split", eventName: "Wall termination changed", reasonToken: "wall_plane_changed" };
}

function advisoryConfidenceAdjustment(
  failures: EnvelopeVerificationFailure[],
  comparison: EnvelopeDeterministicComparison,
): number {
  if (failures.length === 0) {
    return meaningfulSuspicions(comparison).length > 0 ? -0.05 : 0;
  }

  const supportsFailure = (failure: EnvelopeVerificationFailure): boolean => {
    if (failure.failureEventHint === "new_wall_plane_introduced") {
      return comparison.suspicions.some((item) => item.code === "possible_wall_added" || item.code === "possible_new_visible_corner");
    }
    if (failure.failureEventHint === "wall_surface_missing") {
      return comparison.suspicions.some((item) => item.code === "possible_wall_removed" || item.code === "possible_missing_corner");
    }
    if (failure.failureEventHint === "room_corner_added") {
      return comparison.suspicions.some((item) => item.code === "possible_new_visible_corner" || item.code === "possible_wall_shortened");
    }
    if (failure.failureEventHint === "room_corner_removed") {
      return comparison.suspicions.some((item) => item.code === "possible_missing_corner" || item.code === "possible_wall_extended");
    }
    return comparison.suspicions.some((item) => item.code === "possible_wall_extended" || item.code === "possible_wall_shortened" || item.code === "possible_wall_interrupted");
  };

  const supportedWeight = failures
    .filter(supportsFailure)
    .reduce((sum, failure) => sum + (failure.significanceScore || changedConstraintWeight(failure)), 0);
  if (supportedWeight === 0) return -0.05;
  return Math.min(0.1, supportedWeight * 0.04);
}

function inferArchitecturalEventsFromVerificationFailures(params: {
  failures: EnvelopeVerificationFailure[];
  comparison: EnvelopeDeterministicComparison;
}): {
  candidates: EnvelopeArchitecturalEventCandidate[];
  primary?: EnvelopeArchitecturalEventInference;
  secondary?: EnvelopeArchitecturalEventInference;
} {
  const grouped = new Map<EnvelopeArchitecturalEventId, EnvelopeArchitecturalEventCandidate>();

  for (const failure of params.failures.filter((item) => item.scope === "structural")) {
    const event = mapVerificationHintToEvent(failure.failureEventHint);
    const existing = grouped.get(event.eventId);
    const observation = `${failure.statement}${failure.explanation ? ` -- ${failure.explanation}` : ""}`;
    const significance = failure.significanceScore || changedConstraintWeight(failure);
    if (existing) {
      existing.supportingObservationIds = sortUniqueStrings([...existing.supportingObservationIds, failure.statementId]);
      existing.supportingObservations = sortUniqueStrings([...existing.supportingObservations, observation]);
      existing.confidence = Math.max(existing.confidence, Math.min(1, existing.confidence + (significance * 0.12)));
      continue;
    }

    grouped.set(event.eventId, {
      eventId: event.eventId,
      eventName: event.eventName,
      claim: observation,
      question: buildArchitecturalQuestion(event.eventId),
      reasonToken: event.reasonToken,
      supportingPatternIds: [],
      supportingPatterns: [failure.failureEventHint],
      conflictingPatternIds: [],
      conflictingPatterns: [],
      supportingObservationIds: [failure.statementId],
      supportingObservations: [observation],
      conflictingObservationIds: [],
      conflictingObservations: [],
      confidence: Math.max(0.2, significance),
    });
  }

  const candidates = Array.from(grouped.values()).sort((a, b) => {
    const confidenceDelta = b.confidence - a.confidence;
    if (Math.abs(confidenceDelta) > 1e-6) return confidenceDelta;
    return b.supportingObservationIds.length - a.supportingObservationIds.length;
  });

  return {
    candidates,
    primary: candidates[0] ? toInference(candidates[0]) : undefined,
    secondary: candidates[1] ? toInference(candidates[1]) : undefined,
  };
}

function openingTypeLabel(type: StructuralOpening["type"]): string {
  if (type === "window") return "window";
  if (type === "door") return "door";
  if (type === "closet_door") return "closet door";
  return "walkthrough opening";
}

function anchorFixtureLabel(type: AnchorFixture["type"]): string {
  if (type === "ac_unit") return "built-in AC unit";
  if (type === "fireplace") return "fireplace";
  if (type === "built_in_cabinet") return "built-in cabinet";
  if (type === "kitchen_island") return "kitchen island";
  if (type === "staircase") return "staircase";
  return "other fixed architectural anchor";
}

function buildWallReferenceLine(
  wallIndex: number,
  openings: StructuralOpening[],
  anchorFixtures: AnchorFixture[]
): string {
  const openingLines = openings.map((opening) => {
    const confidence = Number.isFinite(Number(opening.confidence)) ? Number(opening.confidence).toFixed(2) : "0.00";
    return `${opening.id}: ${openingTypeLabel(opening.type)}, ${String(opening.horizontalBand).replace(/_/g, " ")}, ${String(opening.verticalBand).replace(/_/g, " ")}, occupancy ${opening.wallCoverageBand}, confidence ${confidence}`;
  });

  const anchorLines = anchorFixtures.map((fixture) => {
    const confidence = Number.isFinite(Number(fixture.confidence)) ? Number(fixture.confidence).toFixed(2) : "0.00";
    return `${fixture.id}: ${anchorFixtureLabel(fixture.type)}, ${String(fixture.horizontalBand).replace(/_/g, " ")}, confidence ${confidence}`;
  });

  if (openingLines.length === 0 && anchorLines.length === 0) {
    return `${wallLabelForEnvelope(wallIndex)}: continuous wall plane with no extracted openings or fixed architectural anchors`;
  }

  const details = [
    ...(openingLines.length > 0 ? [`reference openings: ${openingLines.join("; ")}`] : []),
    ...(anchorLines.length > 0 ? [`fixed landmarks: ${anchorLines.join("; ")}`] : []),
  ];

  return `${wallLabelForEnvelope(wallIndex)}: ${details.join(" | ")}`;
}

function normalizeWallCertainty(certainty?: string): "known" | "partial" | "unknown" {
  if (certainty === "known" || certainty === "partial" || certainty === "unknown") return certainty;
  return "partial";
}

function sortUniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function buildEnvelopeDeterministicComparison(
  baseline?: StructuralBaseline | null,
  staged?: StructuralBaseline | null,
): EnvelopeDeterministicComparison {
  const baselineDescriptors = Array.isArray(baseline?.wallDescriptors) ? baseline!.wallDescriptors! : [];
  const stagedDescriptors = Array.isArray(staged?.wallDescriptors) ? staged!.wallDescriptors! : [];

  const baselineByWall = new Map<number, typeof baselineDescriptors[number]>();
  const stagedByWall = new Map<number, typeof stagedDescriptors[number]>();
  baselineDescriptors.forEach((descriptor) => baselineByWall.set(descriptor.wallIndex, descriptor));
  stagedDescriptors.forEach((descriptor) => stagedByWall.set(descriptor.wallIndex, descriptor));

  const wallIndices = [0, 1, 2, 3];
  const suspicions: EnvelopeDeterministicSuspicion[] = [];
  const questions: string[] = [];

  for (const wallIndex of wallIndices) {
    const base = baselineByWall.get(wallIndex);
    const next = stagedByWall.get(wallIndex);
    const wallLabel = wallLabelForEnvelope(wallIndex);

    if (!base && next) {
      suspicions.push({
        observationId: `obs_wall_${wallIndex}_added`,
        code: "possible_wall_added",
        wallIndex,
        note: `${wallLabel}: staged extraction has a visible wall descriptor where baseline had none.`,
      });
      questions.push(`Deterministic comparison suggests a possible newly visible permanent wall surface on ${wallLabel}. Is this a genuine architectural modification, unsupported architectural completion, baseline visibility limitation, or perspective/framing artefact?`);
      continue;
    }

    if (base && !next) {
      suspicions.push({
        observationId: `obs_wall_${wallIndex}_removed`,
        code: "possible_wall_removed",
        wallIndex,
        note: `${wallLabel}: baseline had a visible wall descriptor but staged extraction does not.`,
      });
      questions.push(`Deterministic comparison suggests a possible missing wall surface on ${wallLabel}. Was a permanent wall surface removed, interrupted from view by framing uncertainty, or explained by baseline visibility limitation?`);
      continue;
    }

    if (!base || !next) continue;

    if (base.visibility !== next.visibility || (base.visibleExtent || base.visibility) !== (next.visibleExtent || next.visibility)) {
      suspicions.push({
        observationId: `obs_wall_${wallIndex}_visibility_changed`,
        code: "possible_wall_visibility_changed",
        wallIndex,
        note: `${wallLabel}: wall visibility classification changed from baseline to staged extraction.`,
      });
      questions.push(`Deterministic comparison suggests wall visibility changed on ${wallLabel}. Is this change due to real architectural modification, baseline visibility limits, or camera viewpoint/framing differences?`);
    }

    const baseCertainty = normalizeWallCertainty(base.architecturalCertainty);
    const stagedCertainty = normalizeWallCertainty(next.architecturalCertainty);
    if (baseCertainty !== stagedCertainty) {
      suspicions.push({
        observationId: `obs_wall_${wallIndex}_certainty_changed`,
        code: "possible_architectural_certainty_changed",
        wallIndex,
        note: `${wallLabel}: architectural certainty changed from ${baseCertainty} to ${stagedCertainty}.`,
      });
      questions.push(`Deterministic comparison suggests architectural certainty changed on ${wallLabel} (${baseCertainty} -> ${stagedCertainty}). Is this supported by direct evidence, or unsupported architectural completion?`);
    }

    const baseCorners = [base.leftCornerVisible === true, base.rightCornerVisible === true];
    const nextCorners = [next.leftCornerVisible === true, next.rightCornerVisible === true];
    if (!baseCorners[0] && nextCorners[0] || !baseCorners[1] && nextCorners[1]) {
      suspicions.push({
        observationId: `obs_wall_${wallIndex}_new_corner`,
        code: "possible_new_visible_corner",
        wallIndex,
        note: `${wallLabel}: staged extraction indicates a corner now visible where baseline did not.`,
      });
      questions.push(`Deterministic comparison suggests a newly visible corner on ${wallLabel}. Is this a genuine architectural corner, unsupported completion, perspective/framing effect, or baseline visibility limitation?`);
    }
    if (baseCorners[0] && !nextCorners[0] || baseCorners[1] && !nextCorners[1]) {
      suspicions.push({
        observationId: `obs_wall_${wallIndex}_missing_corner`,
        code: "possible_missing_corner",
        wallIndex,
        note: `${wallLabel}: a baseline-visible corner is not visible in staged extraction.`,
      });
      questions.push(`Deterministic comparison suggests a potentially missing corner on ${wallLabel}. Was a permanent corner removed/flattened, or is this visibility/extraction uncertainty?`);
    }

    if (base.terminatesAtCorner === true && next.terminatesAtCorner !== true) {
      suspicions.push({
        observationId: `obs_wall_${wallIndex}_extended`,
        code: "possible_wall_extended",
        wallIndex,
        note: `${wallLabel}: baseline wall terminated at an observed corner, staged wall does not.`,
      });
      questions.push(`Deterministic comparison suggests possible wall extension on ${wallLabel} beyond the baseline corner termination. Is this a true extension or an uncertainty/framing artefact?`);
    }

    if (base.terminatesAtCorner !== true && next.terminatesAtCorner === true) {
      suspicions.push({
        observationId: `obs_wall_${wallIndex}_shortened`,
        code: "possible_wall_shortened",
        wallIndex,
        note: `${wallLabel}: staged wall now terminates at a corner where baseline did not show a termination.`,
      });
      questions.push(`Deterministic comparison suggests possible wall shortening/interruption on ${wallLabel}. Is the envelope truly shortened, or does baseline uncertainty explain this difference?`);
    }

    if (base.continuesBeyondFrame === true && next.continuesBeyondFrame !== true && stagedCertainty === "known") {
      suspicions.push({
        observationId: `obs_wall_${wallIndex}_unsupported_completion`,
        code: "possible_unsupported_architectural_completion",
        wallIndex,
        note: `${wallLabel}: baseline wall continued beyond frame with uncertainty, staged extraction resolves known completed geometry.`,
      });
      questions.push(`Deterministic comparison suggests unsupported architectural completion on ${wallLabel}: baseline continuation beyond frame was uncertain but staged extraction appears architecturally complete. Is completion genuinely evidenced or unsupported?`);
    }

    if ((base.leftBoundaryVisible === true && next.leftBoundaryVisible !== true) || (base.rightBoundaryVisible === true && next.rightBoundaryVisible !== true)) {
      suspicions.push({
        observationId: `obs_wall_${wallIndex}_interrupted`,
        code: "possible_wall_interrupted",
        wallIndex,
        note: `${wallLabel}: a baseline-visible boundary is not visible in staged extraction.`,
      });
      questions.push(`Deterministic comparison suggests possible wall continuity interruption on ${wallLabel}. Is continuity genuinely interrupted or explained by framing/visibility limits?`);
    }
  }

  return {
    baselineWallCount: baselineDescriptors.length,
    stagedWallCount: stagedDescriptors.length,
    suspicions,
    clarificationQuestions: sortUniqueStrings(questions),
  };
}

function hasObservation(comparison: EnvelopeDeterministicComparison, code: EnvelopeDeterministicSuspicion["code"]): boolean {
  return comparison.suspicions.some((item) => item.code === code);
}

function supportingForCodes(comparison: EnvelopeDeterministicComparison, codes: EnvelopeDeterministicSuspicion["code"][]): EnvelopeDeterministicSuspicion[] {
  const allowed = new Set(codes);
  return comparison.suspicions.filter((item) => allowed.has(item.code));
}

function confidenceRank(value: "Low" | "Medium" | "High"): number {
  if (value === "High") return 3;
  if (value === "Medium") return 2;
  return 1;
}

function confidenceFromEvidence(supportCount: number, conflictCount: number): "Low" | "Medium" | "High" {
  if ((supportCount >= 3 && conflictCount === 0) || (supportCount >= 2 && conflictCount <= 1)) return "High";
  if (supportCount >= 1 && conflictCount <= 2) return "Medium";
  return "Low";
}

function formatObservationLine(item: EnvelopeDeterministicSuspicion): string {
  return `${item.code} (${wallLabelForEnvelope(item.wallIndex)}): ${item.note}`;
}

function buildEnvelopeHypothesis(params: {
  hypothesisId: string;
  category: EnvelopeDeterministicHypothesis["category"];
  title: string;
  statement: string;
  support: EnvelopeDeterministicSuspicion[];
  conflicts?: EnvelopeDeterministicSuspicion[];
  alternatives: string[];
}): EnvelopeDeterministicHypothesis {
  const conflicts = params.conflicts || [];
  return {
    hypothesisId: params.hypothesisId,
    category: params.category,
    title: params.title,
    confidence: confidenceFromEvidence(params.support.length, conflicts.length),
    statement: params.statement,
    supportingObservationIds: params.support.map((item) => item.observationId),
    supportingObservations: params.support.map(formatObservationLine),
    conflictingObservationIds: conflicts.map((item) => item.observationId),
    conflictingObservations: conflicts.map(formatObservationLine),
    alternativeExplanationsAlreadyConsidered: params.alternatives,
  };
}

function evidenceLineFromSuspicion(item: EnvelopeDeterministicSuspicion): string {
  const wall = wallLabelForEnvelope(item.wallIndex);
  if (item.code === "possible_wall_added") {
    return `${wall}: staged extraction shows a wall surface where baseline did not.`;
  }
  if (item.code === "possible_wall_removed") {
    return `${wall}: a baseline wall surface is not present in staged extraction.`;
  }
  if (item.code === "possible_wall_extended") {
    return `${wall}: the staged wall span continues beyond where baseline showed a corner termination.`;
  }
  if (item.code === "possible_wall_shortened") {
    return `${wall}: the staged wall now terminates earlier at a corner.`;
  }
  if (item.code === "possible_wall_interrupted") {
    return `${wall}: a baseline boundary segment is no longer visible in staged extraction.`;
  }
  if (item.code === "possible_new_visible_corner") {
    return `${wall}: staged extraction indicates a corner that baseline did not show.`;
  }
  if (item.code === "possible_missing_corner") {
    return `${wall}: a corner visible in baseline is not visible in staged extraction.`;
  }
  if (item.code === "possible_unsupported_architectural_completion") {
    return `${wall}: staged extraction resolves geometry that baseline left open at the frame edge.`;
  }
  if (item.code === "possible_wall_visibility_changed") {
    return `${wall}: the staged extraction changed the visible wall extent classification.`;
  }
  return `${wall}: the staged extraction changed certainty for wall geometry interpretation.`;
}

function confidenceFromSupportCount(supportCount: number): "Low" | "Medium" | "High" {
  if (supportCount >= 4) return "High";
  if (supportCount >= 2) return "Medium";
  return "Low";
}

function buildStructuralPattern(params: {
  patternId: EnvelopeStructuralPatternId;
  patternName: string;
  description: string;
  supportingCodes: EnvelopeDeterministicSuspicion["code"][];
  codeWeights?: Partial<Record<EnvelopeDeterministicSuspicion["code"], number>>;
  comparison: EnvelopeDeterministicComparison;
}): EnvelopeStructuralPattern | null {
  const supportingSet = new Set(params.supportingCodes);
  const support = params.comparison.suspicions.filter((item) => supportingSet.has(item.code));
  if (support.length === 0) {
    return null;
  }

  const weightFor = (item: EnvelopeDeterministicSuspicion): number => {
    const byCode = params.codeWeights?.[item.code];
    if (typeof byCode === "number") return byCode;
    if (item.code === "possible_wall_added" || item.code === "possible_wall_removed") return 1.0;
    if (item.code === "possible_wall_extended" || item.code === "possible_wall_shortened") return 0.9;
    if (item.code === "possible_new_visible_corner" || item.code === "possible_missing_corner") return 0.8;
    if (item.code === "possible_wall_interrupted") return 0.6;
    if (item.code === "possible_wall_visibility_changed") return 0.3;
    if (item.code === "possible_architectural_certainty_changed") return 0.3;
    return 0.5;
  };

  const supportWeight = support.reduce((sum, item) => sum + weightFor(item), 0);
  const confidence = Math.max(0, Math.min(1, supportWeight / Math.max(1, support.length)));

  return {
    patternId: params.patternId,
    patternName: params.patternName,
    description: params.description,
    supportingObservationIds: sortUniqueStrings(support.map((item) => item.observationId)),
    supportingObservations: sortUniqueStrings(support.map((item) => evidenceLineFromSuspicion(item))),
    confidence,
  };
}

function buildArchitecturalEventCandidateFromPatterns(params: {
  eventId: EnvelopeArchitecturalEventId;
  eventName: string;
  claim: string;
  question: string;
  reasonToken: string;
  supportingPatternIds: EnvelopeStructuralPatternId[];
  conflictingPatternIds?: EnvelopeStructuralPatternId[];
  priorBoost?: number;
  patterns: EnvelopeStructuralPattern[];
}): EnvelopeArchitecturalEventCandidate | null {
  const byPatternId = new Map(params.patterns.map((pattern) => [pattern.patternId, pattern] as const));
  const supporting = params.supportingPatternIds
    .map((patternId) => byPatternId.get(patternId))
    .filter((item): item is EnvelopeStructuralPattern => !!item);
  if (supporting.length === 0) {
    return null;
  }
  const conflicting = (params.conflictingPatternIds || [])
    .map((patternId) => byPatternId.get(patternId))
    .filter((item): item is EnvelopeStructuralPattern => !!item);

  const supportWeight = supporting.reduce((sum, pattern) => sum + pattern.confidence, 0);
  const conflictWeight = conflicting.reduce((sum, pattern) => sum + pattern.confidence, 0);
  const baseConfidence = Math.max(0, Math.min(1, (supportWeight + 0.2) / (supportWeight + conflictWeight + 0.4)));
  const confidence = Math.max(0, Math.min(1, baseConfidence + (params.priorBoost || 0)));

  const supportingObservationIds = sortUniqueStrings(supporting.flatMap((pattern) => pattern.supportingObservationIds));
  const supportingObservations = sortUniqueStrings(supporting.flatMap((pattern) => pattern.supportingObservations));
  const conflictingObservationIds = sortUniqueStrings(conflicting.flatMap((pattern) => pattern.supportingObservationIds));
  const conflictingObservations = sortUniqueStrings(conflicting.flatMap((pattern) => pattern.supportingObservations));

  return {
    eventId: params.eventId,
    eventName: params.eventName,
    claim: params.claim,
    question: params.question,
    reasonToken: params.reasonToken,
    supportingPatternIds: supporting.map((pattern) => pattern.patternId),
    supportingPatterns: supporting.map((pattern) => pattern.patternName),
    conflictingPatternIds: conflicting.map((pattern) => pattern.patternId),
    conflictingPatterns: conflicting.map((pattern) => pattern.patternName),
    supportingObservationIds,
    supportingObservations,
    conflictingObservationIds,
    conflictingObservations,
    confidence,
  };
}

function confidenceBandFromValue(value: number): "Low" | "Medium" | "High" {
  if (value >= 0.75) return "High";
  if (value >= 0.5) return "Medium";
  return "Low";
}

function toInference(candidate: EnvelopeArchitecturalEventCandidate): EnvelopeArchitecturalEventInference {
  return {
    eventId: candidate.eventId,
    eventName: candidate.eventName,
    suspicion: candidate.claim,
    claim: candidate.claim,
    question: candidate.question,
    reasonToken: candidate.reasonToken,
    evidence: candidate.supportingPatterns,
    alternatives: [],
    confidence: confidenceBandFromValue(candidate.confidence),
    supportingObservationIds: candidate.supportingObservationIds,
  };
}

function claimSidePhrase(observations: EnvelopeDeterministicSuspicion[]): string {
  if (observations.length === 0) return "in the staged image";
  const counts = new Map<number, number>();
  for (const item of observations) {
    counts.set(item.wallIndex, (counts.get(item.wallIndex) || 0) + 1);
  }
  const dominant = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (dominant === 3) return "on the left side of the room";
  if (dominant === 1) return "on the right side of the room";
  if (dominant === 0) return "on the front wall of the room";
  if (dominant === 2) return "on the rear wall of the room";
  return "in the staged image";
}

function meaningfulSuspicions(comparison: EnvelopeDeterministicComparison): EnvelopeDeterministicSuspicion[] {
  return comparison.suspicions.filter((item) => item.code !== "possible_wall_visibility_changed" && item.code !== "possible_architectural_certainty_changed");
}

function inferArchitecturalEvents(comparison: EnvelopeDeterministicComparison): {
  patterns: EnvelopeStructuralPattern[];
  candidates: EnvelopeArchitecturalEventCandidate[];
  primary: EnvelopeArchitecturalEventInference;
  secondary?: EnvelopeArchitecturalEventInference;
} | null {
  const meaningful = meaningfulSuspicions(comparison);
  if (meaningful.length === 0) return null;

  const side = claimSidePhrase(meaningful);
  const patterns = [
    buildStructuralPattern({
      patternId: "existing_wall_no_longer_continues",
      patternName: "Existing wall no longer continues",
      description: "A previously continuous wall run appears terminated or interrupted in staged extraction.",
      supportingCodes: ["possible_wall_removed", "possible_wall_shortened", "possible_wall_interrupted", "possible_missing_corner"],
      codeWeights: {
        possible_wall_removed: 1.0,
        possible_wall_shortened: 1.0,
        possible_wall_interrupted: 0.9,
        possible_missing_corner: 0.8,
      },
      comparison,
    }),
    buildStructuralPattern({
      patternId: "previously_unseen_wall_continues",
      patternName: "Previously unseen wall continues",
      description: "Staged extraction introduces a continuing wall run that baseline did not show.",
      supportingCodes: ["possible_wall_added", "possible_new_visible_corner", "possible_wall_extended", "possible_architectural_certainty_changed", "possible_unsupported_architectural_completion"],
      codeWeights: {
        possible_wall_added: 1.0,
        possible_new_visible_corner: 0.9,
        possible_wall_extended: 0.9,
        possible_architectural_certainty_changed: 0.55,
        possible_unsupported_architectural_completion: 0.7,
      },
      comparison,
    }),
    buildStructuralPattern({
      patternId: "new_wall_surface_introduced",
      patternName: "New wall surface introduced",
      description: "A wall surface appears in staged extraction that was not visible in baseline.",
      supportingCodes: ["possible_wall_added", "possible_wall_visibility_changed", "possible_new_visible_corner"],
      codeWeights: {
        possible_wall_added: 1.0,
        possible_new_visible_corner: 0.75,
        possible_wall_visibility_changed: 0.45,
      },
      comparison,
    }),
    buildStructuralPattern({
      patternId: "wall_termination_disappeared",
      patternName: "Wall termination disappeared",
      description: "A baseline-visible wall termination or corner is no longer visible in staged extraction.",
      supportingCodes: ["possible_missing_corner", "possible_wall_interrupted", "possible_wall_shortened"],
      codeWeights: {
        possible_missing_corner: 0.9,
        possible_wall_interrupted: 0.8,
        possible_wall_shortened: 0.75,
      },
      comparison,
    }),
  ].filter((item): item is EnvelopeStructuralPattern => item !== null);

  const candidates = [
    buildArchitecturalEventCandidateFromPatterns({
      eventId: "wall_added",
      eventName: "New wall surface added",
      claim: `We suspect a new permanent wall surface has been introduced ${side} in the staged image.`,
      question: "Is this claim TRUE or FALSE?",
      reasonToken: "wall_added",
      supportingPatternIds: ["new_wall_surface_introduced", "previously_unseen_wall_continues"],
      conflictingPatternIds: ["existing_wall_no_longer_continues", "wall_termination_disappeared"],
      priorBoost: 0.0,
      patterns,
    }),
    buildArchitecturalEventCandidateFromPatterns({
      eventId: "wall_removed",
      eventName: "Wall surface removed",
      claim: `We suspect a permanent wall surface present in baseline has been removed ${side} in the staged image.`,
      question: "Is this claim TRUE or FALSE?",
      reasonToken: "wall_removed",
      supportingPatternIds: ["existing_wall_no_longer_continues"],
      conflictingPatternIds: ["new_wall_surface_introduced", "previously_unseen_wall_continues"],
      priorBoost: 0.0,
      patterns,
    }),
    buildArchitecturalEventCandidateFromPatterns({
      eventId: "wall_plane_split",
      eventName: "Continuous wall split",
      claim: `We suspect a continuous wall now appears split into two wall planes ${side} in the staged image.`,
      question: "Is this claim TRUE or FALSE?",
      reasonToken: "wall_split",
      supportingPatternIds: ["wall_termination_disappeared", "new_wall_surface_introduced"],
      conflictingPatternIds: ["existing_wall_no_longer_continues"],
      priorBoost: 0.0,
      patterns,
    }),
  ].filter((item): item is EnvelopeArchitecturalEventCandidate => item !== null);

  const rankedCandidates = candidates
    .sort((a, b) => {
      const confidenceDelta = b.confidence - a.confidence;
      if (Math.abs(confidenceDelta) > 1e-6) return confidenceDelta;
      const supportDelta = b.supportingObservationIds.length - a.supportingObservationIds.length;
      if (supportDelta !== 0) return supportDelta;
      return a.eventId.localeCompare(b.eventId);
    });

  if (rankedCandidates.length === 0) return null;

  const ranked = rankedCandidates.map(toInference);

  return {
    patterns,
    candidates: rankedCandidates,
    primary: ranked[0],
    secondary: ranked[1],
  };
}

function buildArchitecturalEventSummary(
  primary: EnvelopeArchitecturalEventInference,
  secondary: EnvelopeArchitecturalEventInference | undefined,
  comparison: EnvelopeDeterministicComparison,
): string {
  const patternLines = primary.evidence.length > 0
    ? primary.evidence.map((line) => `- ${line}`).join("\n")
    : "- none";
  const secondaryLine = secondary
    ? `Secondary supporting claim: ${secondary.claim}`
    : "Secondary suspicion considered: none";

  return [
    "Architectural Claim",
    primary.claim,
    secondaryLine,
    "Supporting structural patterns:",
    patternLines,
    `Overall deterministic confidence: ${primary.confidence}`,
    `Pattern count: ${primary.evidence.length}`,
    `Deterministic observation count: ${comparison.suspicions.length}`,
  ].join("\n");
}

function buildArchitecturalQuestion(eventId: EnvelopeArchitecturalEventId): string {
  if (eventId === "wall_added") return "Has a new permanent wall been introduced in the staged image?";
  if (eventId === "wall_removed") return "Has a permanent wall surface been removed in the staged image?";
  if (eventId === "room_corner_added") return "Has a new permanent room corner appeared in the staged image?";
  if (eventId === "room_corner_removed") return "Has a permanent room corner been removed in the staged image?";
  if (eventId === "wall_plane_split") return "Has a continuous wall split into two wall planes in the staged image?";
  return "Has one permanent wall plane split into multiple planes in the staged image?";
}

function buildConfirmedReason(eventId: EnvelopeArchitecturalEventId): string {
  if (eventId === "wall_plane_split") return "wall_plane_changed";
  return eventId;
}

function buildDeterministicFactLines(
  comparison: EnvelopeDeterministicComparison,
  primary: EnvelopeArchitecturalEventInference,
): string[] {
  const facts: string[] = [];
  facts.push(`Visible wall count changed from ${comparison.baselineWallCount} to ${comparison.stagedWallCount}.`);

  const byObservationId = new Map(comparison.suspicions.map((item) => [item.observationId, item] as const));
  for (const observationId of primary.supportingObservationIds) {
    const matched = byObservationId.get(observationId);
    if (matched) {
      facts.push(evidenceLineFromSuspicion(matched));
    }
  }

  facts.push(`Deterministic observation count: ${comparison.suspicions.length}.`);
  return sortUniqueStrings(facts);
}

export function buildEnvelopeHypotheses(comparison: EnvelopeDeterministicComparison): EnvelopeHypothesisBundle {
  const hypotheses: EnvelopeDeterministicHypothesis[] = [];

  const addedSupport = supportingForCodes(comparison, [
    "possible_wall_added",
    "possible_new_visible_corner",
  ]);
  const removedSupport = supportingForCodes(comparison, [
    "possible_wall_removed",
    "possible_missing_corner",
  ]);
  const extendedSupport = supportingForCodes(comparison, [
    "possible_wall_extended",
    "possible_new_visible_corner",
  ]);
  const shortenedSupport = supportingForCodes(comparison, [
    "possible_wall_shortened",
    "possible_missing_corner",
  ]);
  const interruptedSupport = supportingForCodes(comparison, [
    "possible_wall_interrupted",
  ]);
  const certaintyVisibilitySupport = supportingForCodes(comparison, [
    "possible_wall_visibility_changed",
    "possible_architectural_certainty_changed",
  ]);

  const unsupportedCompletionSupport = supportingForCodes(comparison, [
    "possible_unsupported_architectural_completion",
    "possible_wall_added",
    "possible_new_visible_corner",
    "possible_wall_extended",
    "possible_architectural_certainty_changed",
  ]);
  const structuralConflictSignals = supportingForCodes(comparison, [
    "possible_wall_removed",
    "possible_wall_shortened",
    "possible_wall_interrupted",
  ]);
  const additionConflictSignals = supportingForCodes(comparison, [
    "possible_wall_added",
    "possible_wall_extended",
    "possible_new_visible_corner",
  ]);

  if (unsupportedCompletionSupport.length > 0) {
    hypotheses.push(buildEnvelopeHypothesis({
      hypothesisId: "hyp_unsupported_completion",
      category: "possible_unsupported_architectural_completion",
      title: "Visible room envelope differs from baseline extraction",
      statement: "Deterministic comparison identified newly visible structural continuity not present in baseline extraction.",
      support: unsupportedCompletionSupport,
      conflicts: structuralConflictSignals,
      alternatives: ["perspective", "framing", "camera_viewpoint"],
    }));
  }

  if (addedSupport.length > 0) {
    hypotheses.push(buildEnvelopeHypothesis({
      hypothesisId: "hyp_permanent_wall_added",
      category: "possible_permanent_wall_added",
      title: "Additional wall surface extracted",
      statement: "Deterministic comparison identified additional wall-surface extraction relative to baseline.",
      support: addedSupport,
      conflicts: removedSupport,
      alternatives: ["camera_viewpoint", "framing", "baseline_visibility_limitation"],
    }));
  }

  if (removedSupport.length > 0) {
    hypotheses.push(buildEnvelopeHypothesis({
      hypothesisId: "hyp_permanent_wall_removed",
      category: "possible_permanent_wall_removed",
      title: "Visible room envelope appears reduced",
      statement: "Deterministic comparison identified reduced or missing wall-envelope features relative to baseline.",
      support: removedSupport,
      conflicts: additionConflictSignals,
      alternatives: ["foreground_occlusion", "camera_viewpoint", "framing"],
    }));
  }

  if (extendedSupport.length > 0) {
    hypotheses.push(buildEnvelopeHypothesis({
      hypothesisId: "hyp_wall_extended",
      category: "possible_wall_extension",
      title: "Wall boundary extends further than baseline",
      statement: "Deterministic comparison identified wall boundary continuity extending beyond baseline termination cues.",
      support: extendedSupport,
      conflicts: shortenedSupport,
      alternatives: ["perspective", "framing", "camera_viewpoint"],
    }));
  }

  if (shortenedSupport.length > 0) {
    hypotheses.push(buildEnvelopeHypothesis({
      hypothesisId: "hyp_wall_shortened",
      category: "possible_wall_shortening",
      title: "Wall boundary appears shortened",
      statement: "Deterministic comparison identified shortened wall-boundary continuity relative to baseline.",
      support: shortenedSupport,
      conflicts: extendedSupport,
      alternatives: ["foreground_occlusion", "camera_viewpoint", "framing"],
    }));
  }

  if (interruptedSupport.length > 0) {
    hypotheses.push(buildEnvelopeHypothesis({
      hypothesisId: "hyp_wall_continuity_interrupted",
      category: "possible_wall_continuity_interrupted",
      title: "Wall continuity interrupted",
      statement: "Deterministic comparison identified interrupted wall continuity relative to baseline extraction.",
      support: interruptedSupport,
      conflicts: additionConflictSignals,
      alternatives: ["foreground_occlusion", "lighting_effects", "camera_viewpoint"],
    }));
  }

  const combinedStructuralSignals = sortUniqueStrings([
    ...addedSupport.map((item) => item.observationId),
    ...removedSupport.map((item) => item.observationId),
    ...extendedSupport.map((item) => item.observationId),
    ...shortenedSupport.map((item) => item.observationId),
    ...interruptedSupport.map((item) => item.observationId),
  ]);

  if (combinedStructuralSignals.length >= 3) {
    const supporting = comparison.suspicions.filter((item) => combinedStructuralSignals.includes(item.observationId));
    hypotheses.push(buildEnvelopeHypothesis({
      hypothesisId: "hyp_room_envelope_modified",
      category: "possible_room_envelope_modified",
      title: "Room envelope modified",
      statement: "Deterministic comparison identified multi-signal room-envelope differences between baseline and staged extraction.",
      support: supporting,
      conflicts: certaintyVisibilitySupport,
      alternatives: ["camera_viewpoint", "framing", "foreground_occlusion"],
    }));
  }

  if (certaintyVisibilitySupport.length > 0) {
    hypotheses.push(buildEnvelopeHypothesis({
      hypothesisId: "hyp_visibility_ambiguity",
      category: "possible_visibility_ambiguity",
      title: "Visibility ambiguity",
      statement: "Deterministic comparison identified visibility/certainty shifts that may be non-structural.",
      support: certaintyVisibilitySupport,
      conflicts: unsupportedCompletionSupport,
      alternatives: ["lighting_effects", "camera_viewpoint", "framing"],
    }));
  }

  const ambiguousSignals = hasObservation(comparison, "possible_wall_visibility_changed")
    || hasObservation(comparison, "possible_architectural_certainty_changed")
    || (hasObservation(comparison, "possible_wall_added") && hasObservation(comparison, "possible_wall_removed"));

  if (ambiguousSignals) {
    const ambiguitySupport = supportingForCodes(comparison, [
      "possible_wall_visibility_changed",
      "possible_architectural_certainty_changed",
      "possible_wall_added",
      "possible_wall_removed",
      "possible_missing_corner",
      "possible_new_visible_corner",
    ]);
    hypotheses.push(buildEnvelopeHypothesis({
      hypothesisId: "hyp_visibility_ambiguity_compound",
      category: "possible_visibility_ambiguity",
      title: "Visibility ambiguity",
      statement: "Deterministic comparison identified internally inconsistent visibility signals requiring contextual review.",
      support: ambiguitySupport,
      conflicts: combinedStructuralSignals.length > 0
        ? comparison.suspicions.filter((item) => combinedStructuralSignals.includes(item.observationId))
        : [],
      alternatives: ["perspective", "framing", "camera_viewpoint"],
    }));
  }

  const fallbackHypothesis = buildEnvelopeHypothesis({
    hypothesisId: "hyp_visibility_ambiguity_fallback",
    category: "possible_visibility_ambiguity",
    title: "Visibility ambiguity",
    statement: "Deterministic comparison identified low-certainty envelope differences requiring visual explanation.",
    support: comparison.suspicions,
    conflicts: [],
    alternatives: ["perspective", "framing", "camera_viewpoint"],
  });

  const ranked = (hypotheses.length > 0 ? hypotheses : [fallbackHypothesis])
    .sort((a, b) => {
      const confidenceDelta = confidenceRank(b.confidence) - confidenceRank(a.confidence);
      if (confidenceDelta !== 0) return confidenceDelta;
      const supportDelta = b.supportingObservationIds.length - a.supportingObservationIds.length;
      if (supportDelta !== 0) return supportDelta;
      return a.hypothesisId.localeCompare(b.hypothesisId);
    })
    .slice(0, 3);

  return {
    primaryHypothesis: ranked[0],
    hypotheses: ranked,
  };
}

function boolLabel(value: boolean | undefined, positive: string, negative: string): string {
  return value ? positive : negative;
}

export function buildEnvelopeAuthoritativeBaselineDescription(baseline?: StructuralBaseline | null): string {
  const openings = Array.isArray(baseline?.openings) ? baseline.openings : [];
  const anchorFixtures = Array.isArray(baseline?.anchorFixtures) ? baseline.anchorFixtures : [];
  const wallDescriptors = Array.isArray(baseline?.wallDescriptors) ? baseline.wallDescriptors : [];
  const wallIndices = [3, 2, 1, 0];
  const visibleWallLabels = Array.from(new Set([
    ...openings.map((opening) => wallLabelForEnvelope(opening.wallIndex)),
    ...anchorFixtures.map((fixture) => wallLabelForEnvelope(fixture.wallIndex)),
  ]));

  if (!baseline) {
    return [
      "The following description represents the authoritative architectural envelope extracted from the baseline image.",
      "This description is considered correct.",
      "Do not reinterpret the baseline architecture from the staged image.",
      "Determine whether the staged image still contains this same room envelope.",
      "",
      "Authoritative envelope features:",
      "- visible wall planes and their continuity",
      "- wall intersections and room corners",
      "- ceiling intersections and floor intersections",
      "- alcoves, recesses, bulkheads, soffits, and other fixed envelope features",
      "- edge-of-frame wall continuity and any wall plane that continues into the image boundary",
      "- room proportions, orientation, and wall segmentation",
      "- any existing qualitative envelope description already established by the validator",
    ].join("\n");
  }

  const wallDescriptionLines = wallDescriptors.length > 0
    ? [
        "",
        "Wall envelope descriptions with visibility semantics (authoritative baseline):",
        ...wallDescriptors.flatMap((descriptor) => {
          const visibleExtent = descriptor.visibleExtent || descriptor.visibility;
          const certainty = descriptor.architecturalCertainty || "partial";
          return [
            `- ${wallLabelForEnvelope(descriptor.wallIndex)}:`,
            `  - visibility: ${descriptor.visibility}`,
            `  - visible extent: ${visibleExtent}`,
            `  - architectural certainty: ${certainty}`,
            `  - left boundary: ${boolLabel(descriptor.leftBoundaryVisible, "visible", "not visible / exits frame")}`,
            `  - right boundary: ${boolLabel(descriptor.rightBoundaryVisible, "visible", "not visible / exits frame")}`,
            `  - left corner: ${boolLabel(descriptor.leftCornerVisible, "visible", "not visible")}`,
            `  - right corner: ${boolLabel(descriptor.rightCornerVisible, "visible", "not visible")}`,
            `  - terminates at observed corner: ${descriptor.terminatesAtCorner === true ? "yes" : "no"}`,
            `  - continues beyond frame: ${descriptor.continuesBeyondFrame === true ? "yes" : "no / unknown"}`,
            `  - observed continuity note: ${descriptor.description}`,
          ];
        }),
        "",
      ]
    : [];

  return [
    "The following architectural room envelope was extracted from the baseline image.",
    "This description is considered authoritative.",
    "Do not reinterpret the baseline architecture from the staged image.",
    "Determine whether the staged image still represents this same architectural room envelope.",
    "",
    "Room overview:",
    `- camera orientation: ${baseline.cameraOrientation || "unknown"}`,
    `- visible wall planes: ${visibleWallLabels.length > 0 ? visibleWallLabels.join(", ") : "not explicitly enumerated"}`,
    `- extracted reference openings: ${openings.length}`,
    `- extracted architectural landmarks: ${anchorFixtures.length}`,
    "- ceiling continuity: treat as continuous unless the staged image clearly shows a changed boundary junction",
    "- floor continuity: treat as continuous unless the staged image clearly shows a changed boundary junction",
    "",
    ...wallIndices.map((wallIndex) => buildWallReferenceLine(
      wallIndex,
      openings.filter((opening) => opening.wallIndex === wallIndex),
      anchorFixtures.filter((fixture) => fixture.wallIndex === wallIndex),
    ).split("\n")),
    ...wallDescriptionLines,
    "Architectural landmarks:",
    anchorFixtures.length > 0
      ? anchorFixtures.map((fixture) => `- ${fixture.id}: ${anchorFixtureLabel(fixture.type)}, ${wallLabelForEnvelope(fixture.wallIndex)}, ${String(fixture.horizontalBand).replace(/_/g, " ")}, confidence ${Number.isFinite(Number(fixture.confidence)) ? Number(fixture.confidence).toFixed(2) : "0.00"}`).join("\n")
      : "- none explicitly extracted",
    "",
    "Opening reference points (context only, do not validate opening preservation or resize):",
    openings.length > 0
      ? openings.map((opening) => `- ${opening.id}: ${openingTypeLabel(opening.type)}, ${wallLabelForEnvelope(opening.wallIndex)}, ${String(opening.horizontalBand).replace(/_/g, " ")}, ${String(opening.verticalBand).replace(/_/g, " ")}, occupancy ${opening.wallCoverageBand}, confidence ${Number.isFinite(Number(opening.confidence)) ? Number(opening.confidence).toFixed(2) : "0.00"}`).join("\n")
      : "- none explicitly extracted",
    "",
    "Use the baseline description as the source of truth.",
    "Do not rebuild the room envelope from the staged image.",
    "Do not reinterpret the baseline architecture from scratch.",
    "The baseline defines not only which walls are visible, but also which boundaries/corners were unknown in the original photo.",
    "If baseline certainty is partial or unknown, preserve that uncertainty unless staged imagery provides clear direct architectural evidence.",
    "Treat baseline visibility limits as authoritative: if a wall, corner, return wall, or recess is only partially visible, preserve that uncertainty.",
    "Do not infer unseen architectural geometry beyond what is evidenced in the baseline image.",
    "Do not complete room geometry where baseline evidence is incomplete.",
    "The envelope validator owns only the permanent wall envelope.",
    "Architectural openings may be used only as reference points for understanding wall continuity.",
    "Do not evaluate whether an opening itself has changed.",
    "Do not evaluate fixtures, flooring, or furniture except where they provide architectural context for understanding wall continuity.",
  ].join("\n");
}

export function parseEnvelopeResult(rawText: string): EnvelopeValidatorResult {
  const cleaned = String(rawText || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  let parsed: any;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    throw new Error("validator_error_invalid_json");
  }

  const normalizedAnswer = typeof parsed?.answer === "string"
    ? parsed.answer.trim().toUpperCase()
    : "";
  const rawVerifications = Array.isArray(parsed?.verifications)
    ? parsed.verifications
    : Array.isArray(parsed?.statementVerifications)
      ? parsed.statementVerifications
      : [];
  const statementVerifications: EnvelopeStatementVerificationResult[] = Array.isArray(rawVerifications)
    ? rawVerifications
      .map((item: any): EnvelopeStatementVerificationResult | null => {
        if (!item || typeof item !== "object") return null;
        const statementId = typeof item.statementId === "string" ? item.statementId.trim() : "";
        const statement = typeof item.statement === "string" ? item.statement.trim() : "";
        const answerValue = typeof item.answer === "string" ? item.answer.trim().toUpperCase() : "";
        const scope = item.scope === "reference" ? "reference" : "structural";
        if (!statementId || !statement || (answerValue !== "TRUE" && answerValue !== "FALSE")) return null;
        const explanation = typeof item.explanation === "string"
          ? item.explanation.trim()
          : typeof item.reason === "string"
            ? item.reason.trim()
            : undefined;
        return {
          statementId,
          statement,
          scope,
          answer: answerValue as "TRUE" | "FALSE",
          explanation,
          observedVisibilityMagnitude: typeof item.observedVisibilityMagnitude === "string"
            ? item.observedVisibilityMagnitude.trim().toLowerCase()
            : undefined,
        };
      })
      .filter((item: EnvelopeStatementVerificationResult | null): item is EnvelopeStatementVerificationResult => item !== null)
    : [];
  const wallVerifications: BaselineGuidedWallVerification[] = Array.isArray(parsed?.wallVerifications)
    ? parsed.wallVerifications
      .map((item: any): BaselineGuidedWallVerification | null => {
        if (!item || typeof item !== "object") return null;
        const semanticWallId = typeof item.semanticWallId === "string" ? item.semanticWallId.trim() : "";
        const displayName = typeof item.displayName === "string" ? item.displayName.trim() : "";
        const samePermanentWallVisible = typeof item.samePermanentWallVisible === "string"
          ? item.samePermanentWallVisible.trim().toUpperCase()
          : "";
        if (!semanticWallId || !displayName || (samePermanentWallVisible !== "TRUE" && samePermanentWallVisible !== "FALSE")) return null;
        return {
          semanticWallId,
          displayName,
          primaryAnchorLabel: typeof item.primaryAnchorLabel === "string" ? item.primaryAnchorLabel.trim() : undefined,
          samePermanentWallVisible: samePermanentWallVisible as "TRUE" | "FALSE",
          wallVisibility: normalizeVisibilityMagnitude(item.wallVisibility),
          wallExtent: normalizeVisibilityMagnitude(item.wallExtent),
          architecturalCertainty: item.architecturalCertainty === "known" || item.architecturalCertainty === "partial" || item.architecturalCertainty === "unknown"
            ? item.architecturalCertainty
            : undefined,
          leftCornerVisible: typeof item.leftCornerVisible === "boolean" ? item.leftCornerVisible : undefined,
          rightCornerVisible: typeof item.rightCornerVisible === "boolean" ? item.rightCornerVisible : undefined,
          continuesBeyondFrame: typeof item.continuesBeyondFrame === "boolean" ? item.continuesBeyondFrame : undefined,
          terminatesAtCorner: typeof item.terminatesAtCorner === "boolean" ? item.terminatesAtCorner : undefined,
          returnWallVisible: typeof item.returnWallVisible === "boolean" ? item.returnWallVisible : undefined,
          adjoiningWallVisible: typeof item.adjoiningWallVisible === "boolean" ? item.adjoiningWallVisible : undefined,
          recessVisible: typeof item.recessVisible === "boolean" ? item.recessVisible : undefined,
          confidence: Number.isFinite(item.confidence) ? Number(item.confidence) : undefined,
          reason: typeof item.reason === "string" ? item.reason.trim() : undefined,
          observations: Array.isArray(item.observations)
            ? item.observations.map((value: unknown) => typeof value === "string" ? value.trim() : "").filter((value: string) => value.length > 0)
            : [],
        };
      })
      .filter((item: BaselineGuidedWallVerification | null): item is BaselineGuidedWallVerification => item !== null)
    : [];
  const additionalWallPlanes: AdditionalWallPlanesResult | undefined = typeof parsed?.additionalPermanentWallPlanes === "string"
    ? {
      answer: parsed.additionalPermanentWallPlanes.trim().toUpperCase() === "TRUE" ? "TRUE" : "FALSE",
      descriptions: Array.isArray(parsed?.additionalPermanentWallPlaneDescriptions)
        ? parsed.additionalPermanentWallPlaneDescriptions.map((value: unknown) => typeof value === "string" ? value.trim() : "").filter((value: string) => value.length > 0)
        : [],
      confidence: Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : undefined,
      reason: typeof parsed?.reason === "string" ? parsed.reason.trim() : undefined,
    }
    : undefined;
  const additionalArchitecturalEvidence: AdditionalArchitecturalEvidence | undefined = (() => {
    const hasAnyField = typeof parsed?.additionalPermanentWallPlanes === "string"
      || typeof parsed?.additionalPermanentReturnWalls === "string"
      || typeof parsed?.additionalPermanentRecesses === "string"
      || typeof parsed?.additionalPermanentCorners === "string"
      || typeof parsed?.unmatchedPermanentArchitecturalFeatures === "string";
    if (!hasAnyField) return undefined;
    const normalizeAnswerField = (value: unknown): "TRUE" | "FALSE" => {
      const normalized = typeof value === "string" ? value.trim().toUpperCase() : "FALSE";
      return normalized === "TRUE" ? "TRUE" : "FALSE";
    };
    const normalizeDescriptions = (value: unknown): string[] => Array.isArray(value)
      ? value.map((entry: unknown) => typeof entry === "string" ? entry.trim() : "").filter((entry: string) => entry.length > 0)
      : [];
    return {
      additionalPermanentWallPlanes: normalizeAnswerField(parsed?.additionalPermanentWallPlanes),
      additionalPermanentWallPlaneDescriptions: normalizeDescriptions(parsed?.additionalPermanentWallPlaneDescriptions),
      additionalPermanentReturnWalls: normalizeAnswerField(parsed?.additionalPermanentReturnWalls),
      additionalPermanentReturnWallDescriptions: normalizeDescriptions(parsed?.additionalPermanentReturnWallDescriptions),
      additionalPermanentRecesses: normalizeAnswerField(parsed?.additionalPermanentRecesses),
      additionalPermanentRecessDescriptions: normalizeDescriptions(parsed?.additionalPermanentRecessDescriptions),
      additionalPermanentCorners: normalizeAnswerField(parsed?.additionalPermanentCorners),
      additionalPermanentCornerDescriptions: normalizeDescriptions(parsed?.additionalPermanentCornerDescriptions),
      unmatchedPermanentArchitecturalFeatures: normalizeAnswerField(parsed?.unmatchedPermanentArchitecturalFeatures),
      unmatchedPermanentFeatureDescriptions: normalizeDescriptions(parsed?.unmatchedPermanentFeatureDescriptions),
      confidence: Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : undefined,
      reason: typeof parsed?.reason === "string" ? parsed.reason.trim() : undefined,
    } satisfies AdditionalArchitecturalEvidence;
  })();
  const derivedOverallAnswer = statementVerifications.some((item) => item.scope === "structural" && item.answer === "FALSE")
    ? "TRUE"
    : statementVerifications.length > 0
      ? "FALSE"
      : undefined;
  const answer = normalizedAnswer === "TRUE" || normalizedAnswer === "FALSE"
    ? (normalizedAnswer as "TRUE" | "FALSE")
    : derivedOverallAnswer;
  const hasOk = typeof parsed?.ok === "boolean";

  if (!hasOk && !answer) {
    throw new Error("validator_error_invalid_schema");
  }

  const envelopeDetectedChange = answer
    ? answer === "TRUE"
    : parsed.ok === false;
  const semanticOk = answer
    ? answer === "FALSE"
    : parsed.ok === true;
  const geometricCertainty = envelopeDetectedChange ? hasClearGeometricChange(parsed) : false;

  let reasonCode: EnvelopeReasonCode | undefined;
  if (!envelopeDetectedChange) {
    reasonCode = undefined;
  } else if (geometricCertainty) {
    reasonCode = "envelope_confirmed_structural_change";
  } else if (parsed?.visualAmbiguity === true) {
    reasonCode = "envelope_visual_ambiguity";
  } else {
    reasonCode = "envelope_insufficient_geometric_evidence";
  }

  const adjudications: EnvelopeObservationAdjudication[] = Array.isArray(parsed?.observationAdjudications)
    ? parsed.observationAdjudications
      .map((item: any): EnvelopeObservationAdjudication | null => {
        if (!item || typeof item !== "object") return null;
        const observationId = String(item.observationId || "").trim();
        const code = String(item.code || "") as EnvelopeDeterministicSuspicion["code"];
        const wallIndex = Number(item.wallIndex);
        const decision = item.decision === "confirm" || item.decision === "dismiss"
          ? item.decision
          : null;
        const explanation = typeof item.explanation === "string" ? item.explanation.trim() : "";
        const dismissReason = typeof item.dismissReason === "string"
          ? item.dismissReason
          : undefined;
        if (!observationId || !code || !Number.isFinite(wallIndex) || !decision || explanation.length === 0) return null;
        return {
          observationId,
          code,
          wallIndex,
          decision,
          explanation,
          dismissReason: dismissReason as EnvelopeObservationAdjudication["dismissReason"],
        };
      })
      .filter((item: EnvelopeObservationAdjudication | null): item is EnvelopeObservationAdjudication => item !== null)
    : [];

  const primaryHypothesis = typeof parsed?.primaryHypothesis === "string"
    ? parsed.primaryHypothesis.trim()
    : undefined;
  const normalizedReason = typeof parsed?.reason === "string"
    ? parsed.reason.trim()
    : "";
  const selectedExplanation = typeof parsed?.selectedExplanation === "string"
    ? parsed.selectedExplanation.trim()
    : normalizedReason || primaryHypothesis;
  const hypothesisConfidence = parsed?.hypothesisConfidence === "Low"
    || parsed?.hypothesisConfidence === "Medium"
    || parsed?.hypothesisConfidence === "High"
    ? parsed.hypothesisConfidence
    : undefined;
  const hypothesisVerdict = parsed?.verdict === "confirmed" || parsed?.verdict === "rejected"
    ? parsed.verdict
    : undefined;
  const hypothesisDismissalReason = typeof parsed?.dismissalReason === "string"
    ? parsed.dismissalReason.trim()
    : undefined;
  const hypothesisAnalysis = typeof parsed?.analysis === "string"
    ? parsed.analysis.trim()
    : undefined;

  const baseReason = normalizedReason.length > 0
    ? normalizedReason
    : semanticOk ? "envelope_preserved" : "envelope_changed";
  const reason = reasonCode ? `${reasonCode}: ${baseReason}` : baseReason;
  const confidence = Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : 0.5;
  const advisorySignals = semanticOk ? [] : [reason, ...(reasonCode ? [reasonCode] : [])];
  const tokens = splitIssueTokens(reason, advisorySignals);
  const has = (prefix: string): boolean => tokens.some((token) => token === prefix || token.startsWith(`${prefix}_`));
  const issueType = semanticOk
    ? ISSUE_TYPES.NONE
    : has("room_envelope_changed")
      ? ISSUE_TYPES.ROOM_ENVELOPE_CHANGED
      : has("wall_changed") || has("wall_plane") || has("wall")
        ? ISSUE_TYPES.WALL_CHANGED
        : ISSUE_TYPES.ENVELOPE_ANOMALY;
  const issueTier = classifyIssueTier(issueType);
  const hardFailEligible = envelopeDetectedChange && geometricCertainty && reasonCode === "envelope_confirmed_structural_change";
  const hardFail = hardFailEligible && confidence >= ENVELOPE_HARD_FAIL_CONFIDENCE_THRESHOLD;
  const structuredIssues = buildEnvelopeStructuredIssues({
    issueType,
    issueTier,
    confidence,
    reasonCode,
    boundaryLinesMissing: parsed?.boundaryLinesMissing === true,
    continuousSurfaceReplacement: parsed?.continuousSurfaceReplacement === true,
    noPlausibleVisualExplanation: parsed?.noPlausibleVisualExplanation === true,
    visualAmbiguity: parsed?.visualAmbiguity === true,
  });

  console.log("[ENVELOPE_GEOMETRIC_CERTAINTY]", {
    envelopeDetectedChange,
    geometricCertainty,
    reason: reasonCode || "envelope_preserved",
  });

  // ENVELOPE ADVISORY DEMOTION: Envelope validator is always advisory.
  // Subtle geometry changes (recess flattened, indentation removed, corner smoothed,
  // vertical edge loss) must NOT hard-fail. These signals are passed to Unified for
  // adjudication. True opening removals are caught by the opening validator.
  return {
    status: semanticOk ? "pass" : "fail",
    reason,
    confidence,
    hardFail,
    issueType,
    issueTier,
    advisorySignals,
    advisory: envelopeDetectedChange && !hardFail ? true : undefined,
    primaryStructuredIssue: structuredIssues[0],
    structuredIssues,
    selectedExplanation,
    stagedWallVerifications: wallVerifications,
    additionalWallPlanes,
    additionalArchitecturalEvidence,
    baselineVerificationResults: statementVerifications,
    constraintVerificationResults: statementVerifications,
    primaryHypothesis,
    hypothesisConfidence,
    hypothesisVerdict: hypothesisVerdict || (answer ? (answer === "TRUE" ? "confirmed" : "rejected") : undefined),
    hypothesisDismissalReason: hypothesisDismissalReason || (answer === "FALSE" ? normalizedReason : undefined),
    hypothesisAnalysis,
    architecturalClaim: typeof parsed?.claim === "string"
      ? parsed.claim.trim()
      : typeof parsed?.architecturalClaim === "string"
        ? parsed.architecturalClaim.trim()
        : undefined,
    architecturalQuestion: typeof parsed?.architecturalQuestion === "string"
      ? parsed.architecturalQuestion.trim()
      : undefined,
    architecturalAnswer: answer,
    architecturalReason: normalizedReason.length > 0 ? normalizedReason : undefined,
    deterministicObservationAdjudications: adjudications,
    rawGeminiJson: jsonCandidate,
  };
}

export async function runEnvelopeValidator(
  beforeImageUrl: string,
  afterImageUrl: string,
  options?: {
    jobId?: string;
    imageId?: string;
    attempt?: number;
    baseline?: StructuralBaseline | null;
    detectedBaseline?: StructuralBaseline | null;
  }
): Promise<EnvelopeValidatorResult> {
  const validatorStartedAt = Date.now();
  logEnvelopeEvent("ENVELOPE_VALIDATOR_START", {
    jobId: options?.jobId || "unknown",
    validator: "envelope",
    phase: "validator_total",
    durationMs: 0,
  });
  const ai = getGeminiClient();
  const imagePrepareStartedAt = Date.now();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;
  logEnvelopePhaseEnd(options?.jobId, "image_prepare", Date.now() - imagePrepareStartedAt);

  const baselineVerificationArtifacts = buildEnvelopeConstraintVerificationArtifacts(options?.baseline ?? null);
  const semanticBaselineWallModel = buildSemanticWallModels(options?.baseline ?? null);
  const baselineCandidateWallQualifications = buildCandidateWallQualifications(options?.baseline ?? null);
  const baselineAdvisoryGeometry = buildAdvisoryGeometryObservations(options?.baseline ?? null, baselineCandidateWallQualifications);
  const deterministicComparison = buildEnvelopeDeterministicComparison(options?.baseline ?? null, options?.baseline ?? null);
  const deterministicHypotheses = buildEnvelopeHypotheses(deterministicComparison);
  const primaryHypothesis = deterministicHypotheses.primaryHypothesis;
  const inferredEvents = inferArchitecturalEvents(deterministicComparison);
  const meaningfulObservationCount = deterministicComparison.suspicions.filter((item) => item.code !== "possible_wall_visibility_changed" && item.code !== "possible_architectural_certainty_changed").length;

  const comparisonPrimary = inferredEvents?.primary;
  const comparisonSecondary = inferredEvents?.secondary;
  const architecturalChangeSummary = comparisonPrimary
    ? buildArchitecturalEventSummary(
      comparisonPrimary,
      comparisonSecondary,
      deterministicComparison,
    )
    : "No comparison-claim architectural event was inferred from deterministic observations.";
  const architecturalClaim = comparisonPrimary?.claim || primaryHypothesis.statement;
  const architecturalQuestion = comparisonPrimary?.question
    || (comparisonPrimary ? buildArchitecturalQuestion(comparisonPrimary.eventId) : "Do the staged images preserve the baseline room envelope?");
  const confirmedReason = comparisonPrimary ? buildConfirmedReason(comparisonPrimary.eventId) : "envelope_confirmed_structural_change";
  const deterministicFacts = comparisonPrimary
    ? buildDeterministicFactLines(deterministicComparison, comparisonPrimary)
    : sortUniqueStrings([
      `Visible wall count changed from ${deterministicComparison.baselineWallCount} to ${deterministicComparison.stagedWallCount}.`,
      `Deterministic observation count: ${deterministicComparison.suspicions.length}.`,
    ]);
  const buildPrompt = (retryReason?: string) => buildBaselineGuidedVerificationPrompt({
    canonicalModel: baselineVerificationArtifacts.canonicalModel,
    semanticBaselineWalls: semanticBaselineWallModel,
    advisoryGeometry: baselineAdvisoryGeometry,
    retryReason,
  });

  let prompt = buildPrompt();

  const runWithModel = async (
    model: string,
    phaseLabel: "flash" | "pro"
  ): Promise<EnvelopeValidatorResult> => {
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
        maxOutputTokens: 768,
        responseMimeType: "application/json",
      },
    });
    logEnvelopePhaseEnd(options?.jobId, phaseLabel === "flash" ? "flash_call" : "pro_escalation", Date.now() - requestStartedAt, {
      model,
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

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parseStartedAt = Date.now();
    const parsed = parseEnvelopeResult(text);
    logEnvelopePhaseEnd(options?.jobId, phaseLabel === "flash" ? "flash_parse" : "pro_parse", Date.now() - parseStartedAt, {
      model,
    });
    parsed.rawGeminiJson = text;
    return parsed;
  };

  const runVerificationAttempt = async (retryReason?: string): Promise<EnvelopeValidatorResult> => {
    prompt = buildPrompt(retryReason);
    const flashResult = await runWithModel(ENVELOPE_MODEL_PRIMARY, "flash");
    if (Number.isFinite(flashResult.confidence) && flashResult.confidence >= ENVELOPE_ESCALATION_CONFIDENCE) {
      logEnvelopePhaseEnd(options?.jobId, "pro_escalation", 0, { skipped: true });
      logEnvelopePhaseEnd(options?.jobId, "pro_parse", 0, { skipped: true });
      return flashResult;
    }
    try {
      const proResult = await runWithModel(ENVELOPE_MODEL_ESCALATION, "pro");
      return (Number.isFinite(proResult.confidence) && proResult.confidence >= ENVELOPE_ESCALATION_CONFIDENCE)
        ? proResult
        : flashResult;
    } catch {
      logEnvelopePhaseEnd(options?.jobId, "pro_parse", 0, { skipped: true, error: "pro_call_failed" });
      return flashResult;
    }
  };

  try {
    const verticalEdgeStartedAt = Date.now();
    // Run vertical-edge delta detection in parallel with Gemini calls.
    // It is non-blocking – if it fails we fall through to Gemini-only result.
    const verticalEdgeDeltaPromise = computeVerticalEdgeDelta(beforeImageUrl, afterImageUrl)
      .then((result) => {
        logEnvelopePhaseEnd(options?.jobId, "verticalEdgeDelta", Date.now() - verticalEdgeStartedAt, {
          success: true,
        });
        return result;
      })
      .catch((err) => {
        console.warn("[ENVELOPE_VERTICAL_EDGE_DELTA] local analysis failed (non-blocking):", err?.message || err);
        logEnvelopePhaseEnd(options?.jobId, "verticalEdgeDelta", Date.now() - verticalEdgeStartedAt, {
          success: false,
          error: err?.message || String(err),
        });
        return undefined;
      });

    // Gemini semantic analysis
    const initialAttemptResult = await runVerificationAttempt();
    const initialStagedWallVerifications = initialAttemptResult.stagedWallVerifications || [];
    const initialAdditionalWallPlanes = initialAttemptResult.additionalWallPlanes;
    const initialAdvisoryStageExtraction = buildStageVerificationDescription(initialStagedWallVerifications, initialAdditionalWallPlanes);
    let geminiResult = initialAttemptResult;
    let stagedExtractionIntegrity = evaluateStagedVerificationIntegrity(semanticBaselineWallModel, initialStagedWallVerifications, 1);
    let stagedExtractionRetryStatus: StagedExtractionRetryStatus = {
      triggered: false,
      attempts: 1,
      finalAttempt: 1,
      retrySucceeded: stagedExtractionIntegrity.passed,
    };
    let stagedWallVerifications = initialStagedWallVerifications;
    let additionalWallPlanes = initialAdditionalWallPlanes;

    if (!stagedExtractionIntegrity.passed) {
      stagedExtractionRetryStatus = {
        triggered: true,
        attempts: 2,
        finalAttempt: 2,
        retrySucceeded: false,
        reason: stagedExtractionIntegrity.issues[0]?.message,
      };
      geminiResult = await runVerificationAttempt(stagedExtractionIntegrity.issues[0]?.message);
      stagedWallVerifications = geminiResult.stagedWallVerifications || [];
      additionalWallPlanes = geminiResult.additionalWallPlanes;
      stagedExtractionIntegrity = evaluateStagedVerificationIntegrity(semanticBaselineWallModel, stagedWallVerifications, 2);
      stagedExtractionRetryStatus.retrySucceeded = stagedExtractionIntegrity.passed;
    }

    const semanticStagedWallModel = materializeSemanticWallModelsFromVerifications(semanticBaselineWallModel, stagedWallVerifications);
    const initialSemanticStagedWallModel = materializeSemanticWallModelsFromVerifications(semanticBaselineWallModel, initialStagedWallVerifications);
    const advisoryStageExtraction = buildStageVerificationDescription(stagedWallVerifications, additionalWallPlanes);
    const semanticWallMatches = semanticBaselineWallModel.map((wall) => ({
      baselineSemanticWallId: wall.semanticWallId,
      baselineDisplayName: wall.displayName,
      stagedSemanticWallId: stagedWallVerifications.some((item) => item.semanticWallId === wall.semanticWallId && item.samePermanentWallVisible === "TRUE") ? wall.semanticWallId : undefined,
      stagedDisplayName: stagedWallVerifications.find((item) => item.semanticWallId === wall.semanticWallId)?.displayName,
      matched: stagedWallVerifications.some((item) => item.semanticWallId === wall.semanticWallId),
      score: stagedWallVerifications.some((item) => item.semanticWallId === wall.semanticWallId) ? 100 : 0,
      reasons: stagedWallVerifications.some((item) => item.semanticWallId === wall.semanticWallId)
        ? ["baseline-guided verification identity preserved"]
        : ["wall verification missing"],
    } satisfies SemanticWallMatch));

    if (!stagedExtractionIntegrity.passed) {
      const integrityFailureResult: EnvelopeValidatorResult = {
        ...geminiResult,
        status: "fail",
        reason: "extraction_integrity_failed",
        confidence: 1,
        hardFail: true,
        issueType: ISSUE_TYPES.ENVELOPE_ANOMALY,
        issueTier: classifyIssueTier(ISSUE_TYPES.ENVELOPE_ANOMALY),
        advisorySignals: stagedExtractionIntegrity.issues.map((issue) => issue.message),
        selectedExplanation: stagedExtractionIntegrity.issues[0]?.message || "Staged verification failed integrity validation.",
        deterministicEnvelopeComparison: deterministicComparison,
        deterministicHypotheses: deterministicHypotheses,
        baselineAdvisoryGeometry,
        initialAdvisoryStageExtraction,
        advisoryStageExtraction,
        stagedExtractionIntegrity,
        stagedExtractionRetryStatus,
        initialStagedWallVerifications,
        stagedWallVerifications,
        initialAdditionalWallPlanes,
        additionalWallPlanes,
        baselineCandidateWallQualifications,
        semanticBaselineWallModel,
        initialSemanticStagedWallModel,
        semanticStagedWallModel,
        semanticWallMatches,
        baselineArchitecturalConstraintModel: baselineVerificationArtifacts.canonicalModel,
        baselineArchitecturalModel: baselineVerificationArtifacts.canonicalModel,
        constraintVerificationMode: "constraint_statement_verification",
        baselineVerificationMode: "baseline_statement_verification",
        constraintVerificationStatements: baselineVerificationArtifacts.statements,
        baselineVerificationStatements: baselineVerificationArtifacts.statements,
        architecturalEventCandidates: [],
        finalGeminiPrompt: prompt,
        guidedObservationPrompt: prompt,
        guidedObservationRawGeminiJson: geminiResult.rawGeminiJson,
      };
      logEnvelopePhaseEnd(options?.jobId, "final_decision", 0, { status: "fail", issueType: integrityFailureResult.issueType });
      logEnvelopeEvent("ENVELOPE_VALIDATOR_END", {
        jobId: options?.jobId || "unknown",
        validator: "envelope",
        phase: "validator_total",
        durationMs: Date.now() - validatorStartedAt,
      });
      return integrityFailureResult;
    }

    // Merge vertical edge delta signals into the envelope outcome
    const joinWaitStartedAt = Date.now();
    const vedResult = await verticalEdgeDeltaPromise;
    logEnvelopePhaseEnd(options?.jobId, "join_wait", Date.now() - joinWaitStartedAt);
    const deterministicComparisonFinal = buildEnvelopeDeterministicComparison(options?.baseline ?? null, {
      cameraOrientation: options?.baseline?.cameraOrientation,
      openings: options?.baseline?.openings || [],
      anchorFixtures: options?.baseline?.anchorFixtures || [],
      wallDescriptors: (options?.baseline?.wallDescriptors || []).map((descriptor) => {
        const staged = stagedWallVerifications.find((item) => {
          const wall = semanticBaselineWallModel.find((baselineWall) => baselineWall.advisoryWallIndex === descriptor.wallIndex);
          return wall?.semanticWallId === item.semanticWallId;
        });
        if (!staged || staged.samePermanentWallVisible !== "TRUE") return descriptor;
        return {
          ...descriptor,
          visibility: staged.wallVisibility === "full" || staged.wallVisibility === "substantial" || staged.wallVisibility === "complete"
            ? "full"
            : staged.wallVisibility === "minimal"
              ? "minimal"
              : "partial",
          visibleExtent: staged.wallExtent === "full" || staged.wallExtent === "substantial" || staged.wallExtent === "complete"
            ? "full"
            : staged.wallExtent === "minimal"
              ? "minimal"
              : "partial",
          architecturalCertainty: staged.architecturalCertainty || descriptor.architecturalCertainty,
          leftCornerVisible: staged.leftCornerVisible,
          rightCornerVisible: staged.rightCornerVisible,
          terminatesAtCorner: staged.terminatesAtCorner,
          continuesBeyondFrame: staged.continuesBeyondFrame,
        };
      }),
    });
    const deterministicStructuralInterpretations = deriveDeterministicStructuralInterpretations({
      baseline: options?.baseline ?? null,
      baselineWalls: semanticBaselineWallModel,
      stagedObservations: stagedWallVerifications,
    });
    const additionalArchitecturalEvidence = geminiResult.additionalArchitecturalEvidence;
    const finalDeterministicStructuralInterpretations = deriveDeterministicStructuralInterpretations({
      baseline: options?.baseline ?? null,
      baselineWalls: semanticBaselineWallModel,
      stagedObservations: stagedWallVerifications,
      additionalEvidence: additionalArchitecturalEvidence,
    });
    const finalDeterministicHypotheses = buildEnvelopeHypotheses(deterministicComparisonFinal);
    const finalInferredEvents = inferArchitecturalEvents(deterministicComparisonFinal);
    const finalMergeStartedAt = Date.now();
    geminiResult.constraintVerificationMode = "constraint_statement_verification";
    geminiResult.baselineVerificationMode = "baseline_statement_verification";
    geminiResult.baselineArchitecturalConstraintModel = baselineVerificationArtifacts.canonicalModel;
    geminiResult.baselineArchitecturalModel = baselineVerificationArtifacts.canonicalModel;
    geminiResult.constraintVerificationStatements = baselineVerificationArtifacts.statements;
    geminiResult.baselineVerificationStatements = baselineVerificationArtifacts.statements;
    geminiResult.deterministicEnvelopeComparison = deterministicComparisonFinal;
    geminiResult.deterministicStructuralInterpretations = finalDeterministicStructuralInterpretations;
    geminiResult.baselineAdvisoryGeometry = baselineAdvisoryGeometry;
    geminiResult.initialAdvisoryStageExtraction = initialAdvisoryStageExtraction;
    geminiResult.stagedExtractionIntegrity = stagedExtractionIntegrity;
    geminiResult.stagedExtractionRetryStatus = stagedExtractionRetryStatus;
    geminiResult.initialStagedWallVerifications = initialStagedWallVerifications;
    geminiResult.stagedWallVerifications = stagedWallVerifications;
    geminiResult.initialAdditionalArchitecturalEvidence = initialAttemptResult.additionalArchitecturalEvidence;
    geminiResult.additionalArchitecturalEvidence = additionalArchitecturalEvidence;
    geminiResult.initialAdditionalWallPlanes = initialAdditionalWallPlanes;
    geminiResult.additionalWallPlanes = additionalWallPlanes;
    geminiResult.baselineCandidateWallQualifications = baselineCandidateWallQualifications;
    geminiResult.semanticBaselineWallModel = semanticBaselineWallModel;
    geminiResult.initialSemanticStagedWallModel = initialSemanticStagedWallModel;
    geminiResult.semanticStagedWallModel = semanticStagedWallModel;
    geminiResult.semanticWallMatches = semanticWallMatches;
    geminiResult.guidedObservationPrompt = prompt;
    geminiResult.guidedObservationRawGeminiJson = geminiResult.rawGeminiJson;
    geminiResult.finalGeminiPrompt = prompt;
    geminiResult.advisoryStageExtraction = advisoryStageExtraction;

    const significantInterpretations = finalDeterministicStructuralInterpretations.filter((item) => item.severity === "significant");
    const advisoryInterpretations = finalDeterministicStructuralInterpretations.filter((item) => item.severity === "advisory");
    geminiResult.changedConstraints = [];
    geminiResult.baselineVerificationFailures = [];
    geminiResult.architecturalEventCandidates = significantInterpretations.map((item, index) => ({
      eventId: index === 0 ? "wall_added" : "wall_plane_split",
      eventName: item.summary,
      supportingStructuralPatterns: item.supportingFacts,
      conflictingStructuralPatterns: item.contradictingEvidence,
      supportingObservations: item.corroboratingEvidence,
      conflictingObservations: item.contradictingEvidence,
      confidence: item.confidence === "high" ? 1 : item.confidence === "medium" ? 0.7 : 0.4,
    }));
    geminiResult.architecturalChangeSummary = significantInterpretations.length > 0
      ? [
        "Deterministic structural interpretations:",
        ...significantInterpretations.map((item) => `- ${item.summary}`),
      ].join("\n")
      : advisoryInterpretations.length > 0
        ? [
          "Only advisory deterministic geometry differences were found:",
          ...advisoryInterpretations.map((item) => `- ${item.summary}`),
        ].join("\n")
        : "No deterministic structural differences were identified.";
    geminiResult.architecturalClaim = significantInterpretations.length > 0
      ? significantInterpretations[0].summary
      : "No deterministic structural differences were identified.";
    geminiResult.architecturalClaimSupport = significantInterpretations.flatMap((item) => item.supportingFacts);
    geminiResult.architecturalAnswer = significantInterpretations.length > 0 ? "TRUE" : "FALSE";
    geminiResult.architecturalReason = significantInterpretations.length > 0
      ? "envelope_confirmed_structural_change"
      : advisoryInterpretations.length > 0
        ? "envelope_insufficient_geometric_evidence"
        : "envelope_preserved";
    geminiResult.status = significantInterpretations.length > 0 ? "fail" : "pass";
    geminiResult.hardFail = significantInterpretations.some((item) => item.confidence === "high");
    geminiResult.issueType = significantInterpretations.length > 0 ? ISSUE_TYPES.ENVELOPE_ANOMALY : ISSUE_TYPES.NONE;
    geminiResult.issueTier = classifyIssueTier(geminiResult.issueType);
    geminiResult.advisory = significantInterpretations.length === 0 && advisoryInterpretations.length > 0 ? true : undefined;
    geminiResult.reason = significantInterpretations.length > 0
      ? `envelope_confirmed_structural_change: ${significantInterpretations[0].summary}`
      : advisoryInterpretations.length > 0
        ? `envelope_insufficient_geometric_evidence: ${advisoryInterpretations[0].summary}`
        : "envelope_preserved";
    geminiResult.confidence = significantInterpretations.length > 0
      ? 1
      : advisoryInterpretations.length > 0
        ? 0.65
        : 1;
    geminiResult.constraintVerificationResults = [];
    geminiResult.baselineVerificationResults = [];

    if (vedResult) {
      (geminiResult as EnvelopeValidatorResult).verticalEdgeDelta = vedResult;
      console.log("[ENVELOPE_VERTICAL_EDGE_DELTA]", {
        verticalEdgeLoss: vedResult.verticalEdgeLossDetected,
        cornerPersistenceFailure: vedResult.cornerPersistenceFailure,
        worstRetention: vedResult.worstRetention.toFixed(3),
        junctionCount: vedResult.junctions.length,
        beforeEdges: vedResult.beforeVerticalEdgeCount,
        afterEdges: vedResult.afterVerticalEdgeCount,
      });

      // ── Feature 1: Vertical Projection Histogram flag ──────────────
      // SINGLE-AUTHORITY: VED is advisory only. It must NOT override Gemini's
      // semantic decision. Advisory signals are emitted for Unified adjudication.
      if (vedResult.verticalEdgeLossDetected) {
        geminiResult.advisorySignals.push("envelope_vertical_edge_loss");
        // Upgrade issue type if Gemini didn't already flag a critical envelope issue
        if (geminiResult.issueType === ISSUE_TYPES.NONE || geminiResult.issueType === ISSUE_TYPES.ENVELOPE_ANOMALY) {
          geminiResult.issueType = ISSUE_TYPES.ENVELOPE_VERTICAL_EDGE_LOSS;
          geminiResult.issueTier = classifyIssueTier(ISSUE_TYPES.ENVELOPE_VERTICAL_EDGE_LOSS);
        }
        // Only upgrade status to fail when Gemini also detected an envelope issue
        // (i.e. Gemini already returned ok: false). Do NOT override a Gemini PASS.
        if (geminiResult.status !== "pass") {
          geminiResult.reason = `envelope_vertical_edge_loss: ${geminiResult.reason}`;
        }
      }

      // ── Feature 2: Corner Persistence → Structural Signal for Gemini ──
      // SINGLE-AUTHORITY: VED corner persistence is advisory only.
      // Emit advisory signals and structural signals for Unified adjudication.
      // Do NOT override Gemini's own semantic verdict.
      if (vedResult.cornerPersistenceFailure) {
        geminiResult.advisorySignals.push("envelope_corner_flattened");
        // Only upgrade status/issueType when Gemini also detected an issue (ok: false).
        // When Gemini returned ok: true (pass), keep it as advisory signal only.
        if (geminiResult.status !== "pass") {
          geminiResult.issueType = ISSUE_TYPES.ENVELOPE_CORNER_FLATTENED;
          geminiResult.issueTier = classifyIssueTier(ISSUE_TYPES.ENVELOPE_CORNER_FLATTENED);
          if (!geminiResult.reason.includes("corner")) {
            geminiResult.reason = `envelope_corner_flattened: wall-plane corner collapsed – two planes merged into single surface. ${geminiResult.reason}`;
          }
        }
        // Do NOT hard-fail autonomously — emit structural signal and let Gemini adjudicate via mandatory verification.
        // Hard-fail will come from Gemini confirming the structural claim in runValidation.
        console.log("[SPECIALIST_REVIEW][ENVELOPE]", {
          event: "corner_persistence_failure",
          worstRetention: vedResult.worstRetention.toFixed(3),
          junctionCount: vedResult.junctions.length,
          action: "advisory_signal_emitted_for_gemini_adjudication",
        });
      }

      // ── Emit structural signals from junction analysis ────────────
      const envelopeStructuralSignals: StructuralSignal[] = [];
      const lostJunctions = vedResult.junctions.filter((j) => j.lost);
      if (lostJunctions.length > 0) {
        // Cluster nearby lost junctions so distant ones become separate signals.
        // Two junctions merge into one cluster if they are within GAP_THRESHOLD
        // analysis-space columns of each other.
        const ANALYSIS_WIDTH = 512;
        const JUNCTION_PADDING = 0.03;
        const GAP_THRESHOLD = 30; // cols — ~6% of image width
        const MAX_REGION_WIDTH = 0.25; // tighter than before (was 0.40)

        const sorted = [...lostJunctions].sort((a, b) => a.column - b.column);
        const clusters: Array<{ cols: number[] }> = [];
        let current: number[] = [sorted[0].column];
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].column - sorted[i - 1].column <= GAP_THRESHOLD) {
            current.push(sorted[i].column);
          } else {
            clusters.push({ cols: current });
            current = [sorted[i].column];
          }
        }
        clusters.push({ cols: current });

        const claim: StructuralSignal["claim"] = vedResult.cornerPersistenceFailure
          ? "corner_flattened"
          : vedResult.verticalEdgeLossDetected
            ? "wall_plane_modified"
            : null as any;

        if (claim) {
          for (const cluster of clusters) {
            const colMin = Math.min(...cluster.cols);
            const colMax = Math.max(...cluster.cols);
            const x1 = Math.max(0, (colMin / ANALYSIS_WIDTH) - JUNCTION_PADDING);
            const x2 = Math.min(1, ((colMax + 1) / ANALYSIS_WIDTH) + JUNCTION_PADDING);
            const width = x2 - x1;
            // Reject regions that are still too wide after clustering
            if (width > MAX_REGION_WIDTH) continue;
            // Reject vanishingly narrow regions (noise)
            if (width < 0.02) continue;
            const conf = claim === "corner_flattened"
              ? Math.max(0.85, geminiResult.confidence)
              : geminiResult.confidence;
            envelopeStructuralSignals.push({
              claim,
              region: { x1, y1: 0.05, x2, y2: 0.95 },
              confidence: conf,
              source: "envelope",
            });
          }
        }
      }
      geminiResult.structuralSignals = envelopeStructuralSignals;
    }

    logEnvelopePhaseEnd(options?.jobId, "final_merge", Date.now() - finalMergeStartedAt);
    logEnvelopePhaseEnd(options?.jobId, "final_decision", 0, {
      status: geminiResult.status,
      issueType: geminiResult.issueType,
    });

    const adjudications = Array.isArray(geminiResult.deterministicObservationAdjudications)
      ? geminiResult.deterministicObservationAdjudications
      : [];
    const covered = new Set(adjudications.map((item) => String(item.observationId)));
    const unresolved = deterministicComparison.suspicions
      .filter((item) => !covered.has(String(item.observationId)))
      .map((item) => ({ code: item.code, wallIndex: item.wallIndex }));

    geminiResult.deterministicEnvelopeComparison = deterministicComparisonFinal;
    geminiResult.deterministicHypotheses = finalDeterministicHypotheses;
    geminiResult.structuralPatterns = finalInferredEvents?.patterns.map((pattern) => ({
      patternId: pattern.patternId,
      patternName: pattern.patternName,
      supportingObservations: pattern.supportingObservations,
      confidence: pattern.confidence,
    })) || [];
    geminiResult.selectedExplanation = significantInterpretations.length > 0
      ? significantInterpretations[0].summary
      : advisoryInterpretations.length > 0
        ? advisoryInterpretations[0].summary
        : "No deterministic structural differences were identified.";
    geminiResult.primaryHypothesis = geminiResult.primaryHypothesis || geminiResult.selectedExplanation || primaryHypothesis.statement;
    geminiResult.hypothesisConfidence = geminiResult.hypothesisConfidence || primaryHypothesis.confidence;
    geminiResult.deterministicAdjudicationCoverage = {
      totalSuspicions: deterministicComparison.suspicions.length,
      addressedSuspicions: deterministicComparison.suspicions.length - unresolved.length,
      unresolvedSuspicions: unresolved,
      allSuspicionsAddressed: unresolved.length === 0,
    };

    return geminiResult;
  } catch (error: any) {
    throw new Error(`validator_error_envelope:${error?.message || String(error)}`);
  } finally {
    logEnvelopeEvent("ENVELOPE_VALIDATOR_END", {
      jobId: options?.jobId || "unknown",
      validator: "envelope",
      phase: "validator_total",
      durationMs: Math.max(0, Math.round(Date.now() - validatorStartedAt)),
    });
  }
}
