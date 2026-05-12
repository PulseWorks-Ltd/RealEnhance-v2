export const ISSUE_TYPES = {
  NONE: "none",
  OPENING_REMOVED: "opening_removed",
  OPENING_INFILLED: "opening_infilled",
  OPENING_SEALED: "opening_sealed",
  OPENING_RELOCATED: "opening_relocated",
  OPENING_RESIZED_MAJOR: "opening_resized_major",
  OPENING_RESIZED_MINOR: "opening_resized_minor",
  OPENING_OCCLUSION: "opening_occlusion",
  OPENING_ANOMALY: "opening_anomaly",
  ROOM_ENVELOPE_CHANGED: "room_envelope_changed",
  WALL_CHANGED: "wall_changed",
  ENVELOPE_ANOMALY: "envelope_anomaly",
  ENVELOPE_VERTICAL_EDGE_LOSS: "envelope_vertical_edge_loss",
  ENVELOPE_CORNER_FLATTENED: "envelope_corner_flattened",
  FIXTURE_CHANGED: "fixture_changed",
  FIXTURE_ANOMALY: "fixture_anomaly",
  HVAC_CHANGED: "hvac_changed",
  FAUCET_CHANGED: "faucet_changed",
  FLOOR_CHANGED: "floor_changed",
  FLOOR_ANOMALY: "floor_anomaly",
  GEMINI_STRUCTURE: "gemini_structure",
  GEMINI_OPENING_BLOCKED: "gemini_opening_blocked",
  UNIFIED_FAILURE: "unified_failure",
} as const;

export type ValidationIssueType = (typeof ISSUE_TYPES)[keyof typeof ISSUE_TYPES];
export type ValidationIssueTier = "none" | "advisory" | "review" | "critical";

export type StructuredIssueType =
  | "opening_change"
  | "fixture_change"
  | "floor_change"
  | "envelope_change"
  | "camera_change"
  | "built_in_change"
  | "unknown";

export type StructuredIssueSeverity = "none" | "advisory" | "review" | "critical";

export type StructuredIssue = {
  type: StructuredIssueType;
  object: string;
  action: string;
  severity: StructuredIssueSeverity;
  source: string;
  // Issue-level confidence only. This is preserved for future arbitration and
  // routing, but Stage 0 does not make any runtime decisions from it.
  confidence?: number;
  // Evidence is provenance only: machine-readable support markers such as
  // tokens, claim IDs, or raw validator reason fragments. It is not the
  // primary semantic contract and must not become fallback prose summaries.
  evidence?: string[];
};

export const CRITICAL_ISSUES = new Set<ValidationIssueType>([
  ISSUE_TYPES.OPENING_REMOVED,
  ISSUE_TYPES.OPENING_INFILLED,
  ISSUE_TYPES.OPENING_SEALED,
  ISSUE_TYPES.OPENING_RELOCATED,
  ISSUE_TYPES.OPENING_RESIZED_MAJOR,
  ISSUE_TYPES.WALL_CHANGED,
  ISSUE_TYPES.ROOM_ENVELOPE_CHANGED,
  ISSUE_TYPES.FIXTURE_CHANGED,
  ISSUE_TYPES.HVAC_CHANGED,
  ISSUE_TYPES.FAUCET_CHANGED,
  ISSUE_TYPES.GEMINI_STRUCTURE,
  ISSUE_TYPES.GEMINI_OPENING_BLOCKED,
  ISSUE_TYPES.ENVELOPE_VERTICAL_EDGE_LOSS,
  ISSUE_TYPES.ENVELOPE_CORNER_FLATTENED,
]);

export const REVIEW_ISSUES = new Set<ValidationIssueType>([
  ISSUE_TYPES.OPENING_RESIZED_MINOR,
  ISSUE_TYPES.OPENING_OCCLUSION,
  ISSUE_TYPES.OPENING_ANOMALY,
  ISSUE_TYPES.ENVELOPE_ANOMALY,
  ISSUE_TYPES.FIXTURE_ANOMALY,
  ISSUE_TYPES.FLOOR_CHANGED,
  ISSUE_TYPES.FLOOR_ANOMALY,
  ISSUE_TYPES.UNIFIED_FAILURE,
]);

export const ADVISORY_ISSUES = new Set<ValidationIssueType>([
  ISSUE_TYPES.NONE,
]);

export function normalizeReason(reason: string): string {
  return String(reason || "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyIssueTier(issueType: ValidationIssueType): ValidationIssueTier {
  if (CRITICAL_ISSUES.has(issueType)) return "critical";
  if (REVIEW_ISSUES.has(issueType)) return "review";
  if (ADVISORY_ISSUES.has(issueType)) return "advisory";
  return "review";
}

export function mapIssueTierToSeverity(issueTier: ValidationIssueTier): StructuredIssueSeverity {
  switch (issueTier) {
    case "none":
      return "none";
    case "advisory":
      return "advisory";
    case "review":
      return "review";
    case "critical":
      return "critical";
    default:
      return "review";
  }
}

export function createStructuredIssue(issue: StructuredIssue): StructuredIssue {
  return {
    ...issue,
    evidence: Array.isArray(issue.evidence) ? issue.evidence.filter(Boolean) : undefined,
  };
}

export function isStructuredIssue(value: unknown): value is StructuredIssue {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StructuredIssue>;
  return typeof candidate.type === "string"
    && typeof candidate.object === "string"
    && typeof candidate.action === "string"
    && typeof candidate.severity === "string"
    && typeof candidate.source === "string";
}

function normalizeToken(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

export function splitIssueTokens(reason?: string, advisorySignals?: string[]): string[] {
  const splitTokens = (value: string): string[] =>
    normalizeReason(value)
      .split(/[|,;]/g)
      .map((token) => normalizeToken(token))
      .filter(Boolean);

  return [
    ...splitTokens(reason || ""),
    ...(Array.isArray(advisorySignals)
      ? advisorySignals.flatMap((signal) => splitTokens(String(signal || "")))
      : []),
  ];
}