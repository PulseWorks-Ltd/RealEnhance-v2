import {
  ISSUE_TYPES,
  normalizeReason,
  splitIssueTokens,
  type StructuredIssue,
  type ValidationIssueType,
} from "./issueTypes";

export type EnvelopeOpeningRelationAnalysis = {
  envelopeConfirmsStructuralChange: boolean;
  envelopeHasSemanticAuthority: boolean;
  explicitContradiction: boolean;
  contradictionReason?: string;
  explicitPreservationSignals: string[];
  semanticSupportSignals: string[];
  nonContradictoryAdvisory: boolean;
};

function collectIssueEvidence(issues?: StructuredIssue[]): string[] {
  if (!Array.isArray(issues)) return [];

  return issues.flatMap((issue) => {
    const values = [issue.type, issue.object, issue.action, ...(Array.isArray(issue.evidence) ? issue.evidence : [])];
    return values.map((value) => String(value || "")).filter(Boolean);
  });
}

const EXPLICIT_PRESERVATION_PATTERNS: Array<{ signal: string; pattern: RegExp }> = [
  { signal: "envelope_preserved", pattern: /\benvelope preserved\b/ },
  { signal: "architectural_envelope_identical", pattern: /\barchitectural envelope\b.*\b(identical|unchanged|preserved)\b/ },
  { signal: "wall_planes_identical", pattern: /\bwall planes?\b.*\b(identical|unchanged|preserved)\b/ },
  { signal: "continuous_wall_geometry_preserved", pattern: /\bcontinuous wall geometry preserved\b/ },
  { signal: "opening_boundary_continuity_preserved", pattern: /\bopening boundary continuity preserved\b/ },
  { signal: "no_envelope_discontinuity", pattern: /\bno envelope discontinuity\b/ },
  { signal: "no_structural_change", pattern: /\bno structural change\b/ },
  { signal: "baseline_staged_identical", pattern: /\b(remains|remain|is) identical between the baseline and staged images\b/ },
];

const STRUCTURAL_SUPPORT_PATTERNS: Array<{ signal: string; pattern: RegExp }> = [
  { signal: "envelope_confirmed_structural_change", pattern: /\benvelope confirmed structural change\b/ },
  { signal: "envelope_corner_flattened", pattern: /\benvelope corner flattened\b/ },
  { signal: "envelope_vertical_edge_loss", pattern: /\benvelope vertical edge loss\b/ },
  { signal: "boundary_lines_missing", pattern: /\bboundary lines missing\b/ },
  { signal: "continuous_surface_replacement", pattern: /\bcontinuous surface replacement\b/ },
  { signal: "no_plausible_visual_explanation", pattern: /\bno plausible visual explanation\b/ },
  { signal: "room_envelope_changed", pattern: /\broom envelope changed\b/ },
  { signal: "wall_changed", pattern: /\bwall changed\b/ },
];

export function analyzeEnvelopeOpeningRelation(params: {
  reason?: string;
  advisorySignals?: string[];
  issueType?: ValidationIssueType;
  semanticIssueType?: ValidationIssueType;
  primaryStructuredIssue?: StructuredIssue;
  structuredIssues?: StructuredIssue[];
  pass?: boolean;
  hardFail?: boolean;
}): EnvelopeOpeningRelationAnalysis {
  const structuredIssues = [
    ...(params.primaryStructuredIssue ? [params.primaryStructuredIssue] : []),
    ...(Array.isArray(params.structuredIssues) ? params.structuredIssues : []),
  ];
  const issueEvidence = collectIssueEvidence(structuredIssues);
  const sourceText = [
    params.reason || "",
    ...(Array.isArray(params.advisorySignals) ? params.advisorySignals : []),
    params.issueType || "",
    params.semanticIssueType || "",
    ...issueEvidence,
  ].join(" ");
  const normalizedText = normalizeReason(sourceText);
  const tokens = new Set([
    ...splitIssueTokens(params.reason, params.advisorySignals),
    ...issueEvidence.flatMap((value) => splitIssueTokens(value)),
  ]);

  const explicitPreservationSignals = EXPLICIT_PRESERVATION_PATTERNS
    .filter(({ pattern }) => pattern.test(normalizedText))
    .map(({ signal }) => signal);

  const semanticSupportSignals = STRUCTURAL_SUPPORT_PATTERNS
    .filter(({ pattern }) => pattern.test(normalizedText))
    .map(({ signal }) => signal);

  const semanticIssueType = params.semanticIssueType || params.issueType;
  if (semanticIssueType && semanticIssueType !== ISSUE_TYPES.NONE) {
    semanticSupportSignals.push(semanticIssueType);
  }
  if (structuredIssues.some((issue) => issue.type === "envelope_change")) {
    semanticSupportSignals.push("structured_envelope_change");
  }
  if (tokens.has("envelope_confirmed_structural_change")) {
    semanticSupportSignals.push("envelope_confirmed_structural_change");
  }
  if (tokens.has("envelope_corner_flattened")) {
    semanticSupportSignals.push("envelope_corner_flattened");
  }
  if (tokens.has("envelope_vertical_edge_loss")) {
    semanticSupportSignals.push("envelope_vertical_edge_loss");
  }

  const dedupedSemanticSupportSignals = Array.from(new Set(semanticSupportSignals));
  const envelopeHasSemanticAuthority =
    dedupedSemanticSupportSignals.length > 0 ||
    structuredIssues.length > 0;
  const envelopeConfirmsStructuralChange = dedupedSemanticSupportSignals.some((signal) =>
    signal === "envelope_confirmed_structural_change"
    || signal === ISSUE_TYPES.ROOM_ENVELOPE_CHANGED
    || signal === ISSUE_TYPES.WALL_CHANGED
    || signal === ISSUE_TYPES.ENVELOPE_CORNER_FLATTENED
    || signal === ISSUE_TYPES.ENVELOPE_VERTICAL_EDGE_LOSS
    || signal === "structured_envelope_change"
  );

  const explicitContradiction =
    explicitPreservationSignals.length > 0 && !envelopeHasSemanticAuthority;

  return {
    envelopeConfirmsStructuralChange,
    envelopeHasSemanticAuthority,
    explicitContradiction,
    contradictionReason: explicitContradiction ? explicitPreservationSignals[0] : undefined,
    explicitPreservationSignals,
    semanticSupportSignals: dedupedSemanticSupportSignals,
    nonContradictoryAdvisory:
      params.pass === true &&
      params.hardFail !== true &&
      !explicitContradiction &&
      envelopeHasSemanticAuthority,
  };
}