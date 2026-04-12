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
import { classifyIssueTier, ISSUE_TYPES, splitIssueTokens, type ValidationIssueType } from "./issueTypes";
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

/**
 * Signal coherence gate: only allow hard-fail when the opening signal is
 * internally consistent — a clear structural removal/infill without
 * contradictory resize, occlusion, or addition signals that indicate noise.
 */
function isOpeningSignalCoherent(params: {
  issueType: string;
  allIssueTypes: string[];
  hasResize: boolean;
  hasOcclusion: boolean;
  hasBandMismatch: boolean;
}): boolean {
  const structuralTypes = ["opening_removed", "opening_infilled", "opening_sealed"];

  const hasPrimaryStructural = structuralTypes.includes(params.issueType);

  const hasConflictingSignals =
    params.hasResize ||
    params.hasOcclusion ||
    params.hasBandMismatch ||
    params.allIssueTypes.includes("opening_added") ||
    params.allIssueTypes.includes("opening_resized_major");

  return hasPrimaryStructural && !hasConflictingSignals;
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
  if (has("opening_size_reduction_ge") || has("opening_resize_ge_0_30")) return ISSUE_TYPES.OPENING_RESIZED_MAJOR;
  if (has("opening_resized")) return ISSUE_TYPES.OPENING_RESIZED_MINOR;
  if (has("window_occlusion") || has("door_or_closet_blocked") || has("occlusion")) return ISSUE_TYPES.OPENING_OCCLUSION;
  return params.hardFail ? ISSUE_TYPES.OPENING_RELOCATED : ISSUE_TYPES.OPENING_ANOMALY;
}

function parseOpeningResult(rawText: string): OpeningValidatorResult {
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
    issueTier: classifyIssueTier(issueType),
    advisorySignals,
    details,
    explanation: reason,
  };
}

type OpeningLightAnchorVerdict = {
  openingInfilled: boolean;
  openingRemoved: boolean;
  openingRelocated: boolean;
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

Compare BEFORE vs AFTER for architectural opening infill.

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

Return JSON only:
{
  "openingInfilled": boolean,
  "openingRemoved": boolean,
  "openingRelocated": boolean,
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

export async function runOpeningValidator(
  beforeImageUrl: string,
  afterImageUrl: string,
  options?: {
    jobId?: string;
    imageId?: string;
    attempt?: number;
    /** Pre-extracted structural baseline. When provided, skips re-extraction (saves a Gemini call). */
    baseline?: StructuralBaseline;
  }
): Promise<OpeningValidatorResult> {
  if (!String(beforeImageUrl || "").trim() || !String(afterImageUrl || "").trim()) {
    throw new Error("VALIDATION_INPUT_MISSING");
  }

  const baseline = options?.baseline ?? await extractStructuralBaseline(beforeImageUrl, {
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: options?.attempt,
  });
  const baselineOpenings = extractBaselineOpenings(baseline);
  console.log("[OPENINGS_BASELINE]", baselineOpenings);

  if (Array.isArray(baseline.openings) && baseline.openings.length > 0) {
    const deterministic = await validateOpeningPreservation(baseline, afterImageUrl, {
      jobId: options?.jobId,
      imageId: options?.imageId,
      attempt: options?.attempt,
    });
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

    // Partial occlusion from staging (furniture, decor, camera angle)
    // is allowed. Only fail when the opening is functionally or
    // structurally lost, changed into another opening type, or newly added.
    const hasStrongStructuralOpeningEvidence =
      deterministic.summary.openingRemoved ||
      deterministic.summary.openingInfilled ||
      deterministic.summary.openingSealed ||
      deterministic.summary.openingClassMismatch ||
      hasAddedOpenings;

    let strictDoorOcclusionFail = false;
    let strictWindowOcclusionFail = false;

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

    const openingRegions = buildOpeningRegions(deterministic.detectedOpenings || []);
    const deterministicHardFailIssue =
      deterministic.summary.openingRemoved ||
      deterministic.summary.openingInfilled ||
      deterministic.summary.openingSealed ||
      deterministic.summary.openingClassMismatch ||
      hasAddedOpenings;

    const reasonParts: string[] = [];
    const advisorySignals: string[] = [];
    if (deterministic.summary.openingRemoved) reasonParts.push("opening_removed");
    if (deterministic.summary.openingInfilled) reasonParts.push("opening_infilled");
    if (deterministic.summary.openingSealed) reasonParts.push("opening_sealed");
    if (deterministic.summary.openingClassMismatch) {
      reasonParts.push("opening_type_changed");
      reasonParts.push("opening_class_mismatch");
    }
    if (hasAddedOpenings) reasonParts.push("opening_added");
    if (deterministic.summary.openingRelocated || relocationDetected) {
      advisorySignals.push("opening_relocated_review");
      reasonParts.push("opening_relocated_review");
    }
    if (openingSizeReductionDetected || deterministic.summary.openingResized) {
      reasonParts.push("opening_resized");
      if (openingSizeReductionDetected && maxSizeReductionDelta > 0) {
        advisorySignals.push(`opening_resized_minor:${maxSizeReductionDelta.toFixed(3)}`);
      }
      if (maxSizeReductionDelta >= OPENING_SIZE_REDUCTION_HARD_FAIL_THRESHOLD) {
        reasonParts.push(`opening_size_reduction_ge_${OPENING_SIZE_REDUCTION_HARD_FAIL_THRESHOLD.toFixed(2)}:${maxSizeReductionDelta.toFixed(3)}`);
      }
    }
    if (deterministic.summary.openingBandMismatch) reasonParts.push("opening_band_mismatch");
    if ((deterministic.summary as any).openingSignatureMismatch === true) {
      advisorySignals.push("opening_signature_mismatch");
    }
    if (strictDoorOcclusionFail) advisorySignals.push("door_or_closet_occluded_review");
    if (strictWindowOcclusionFail) advisorySignals.push("window_occlusion_review");

    const microCheckRisk =
      !deterministicHardFailIssue && (
        deterministic.summary.openingResized ||
        areaDelta >= 0.25
      );

    const baseConfidence = Number(deterministic.summary.confidence || 0);
    let hardFailConfidence = baseConfidence;
    let hardFail = deterministicHardFailIssue && hardFailConfidence >= HARD_FAIL_CONFIDENCE_THRESHOLD;

    if (microCheckRisk) {
      const micro = await runOpeningLightAnchorMicroCheck(
        beforeImageUrl,
        afterImageUrl,
        options?.jobId,
        options?.imageId,
        options?.attempt,
      );
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
      }
    }

    const hasHighConfidenceMicroHardFailSignal = reasonParts.some((part) =>
      part === "light_anchor_opening_infilled" || part === "light_anchor_opening_removed"
    );

    // ── COHERENCE GATE: only hard-fail when signals are internally consistent ──
    const primaryIssueType = deterministic.summary.openingRemoved
      ? "opening_removed"
      : deterministic.summary.openingInfilled
        ? "opening_infilled"
        : deterministic.summary.openingSealed
          ? "opening_sealed"
          : "none";

    const signalCoherent = isOpeningSignalCoherent({
      issueType: primaryIssueType,
      allIssueTypes: reasonParts,
      hasResize: openingSizeReductionDetected || !!deterministic.summary.openingResized,
      hasOcclusion: strictDoorOcclusionFail || strictWindowOcclusionFail,
      hasBandMismatch: !!deterministic.summary.openingBandMismatch,
    });

    hardFail = (deterministicHardFailIssue || hasHighConfidenceMicroHardFailSignal) &&
      hardFailConfidence >= HARD_FAIL_CONFIDENCE_THRESHOLD &&
      signalCoherent;

    if (!signalCoherent && (deterministicHardFailIssue || hasHighConfidenceMicroHardFailSignal) && hardFailConfidence >= HARD_FAIL_CONFIDENCE_THRESHOLD) {
      advisorySignals.push("opening_signal_incoherent_downgraded");
      console.log("[OPENING_COHERENCE_DOWNGRADE]", {
        primaryIssueType,
        reasonParts,
        hasResize: openingSizeReductionDetected || !!deterministic.summary.openingResized,
        hasOcclusion: strictDoorOcclusionFail || strictWindowOcclusionFail,
        hasBandMismatch: !!deterministic.summary.openingBandMismatch,
        action: "downgrade_to_advisory",
      });
    }

    if (reasonParts.length === 0) reasonParts.push("openings_preserved");
    const reason = reasonParts.join("|");
    const findings = Array.isArray(deterministic.findings) ? deterministic.findings : [];
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
    const findingById = new Map(findings.map((finding) => [finding.id, finding]));
    const comparisonResult = {
      pass: !hardFail,
      issueType,
      confidence: relocationOnly
        ? Math.min(baseConfidence, 0.6)
        : hardFailConfidence,
      reason,
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

    console.log("[OPENINGS_COMPARISON]", comparisonResult);
    console.log("[SPECIALIST_REVIEW][OPENING]", {
      hardFail,
      deterministicHardFailIssue,
      hardFailConfidence: hardFailConfidence.toFixed(3),
      hasHighConfidenceMicroHardFailSignal,
      reason,
      structuralSignalCount: deterministic.structuralSignals?.length ?? 0,
    });

    return {
      status: hardFail ? "fail" : "pass",
      reason,
      confidence: comparisonResult.confidence,
      hardFail,
      issueType,
      issueTier: classifyIssueTier(issueType),
      advisorySignals,
      explanation,
      findings,
      advisoryObservations,
      details: comparisonResult.details,
      structuralSignals: deterministic.structuralSignals,
      openingRegions,
    };
  }

  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;

  const openingSignal = await computeOpeningGeometrySignal(before, after).catch(() => ({
    openingAreaDelta: 0,
    aspectRatioDelta: 0,
    suspiciousOpeningGeometry: false,
  }));

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

  const runWithModel = async (model: string): Promise<OpeningValidatorResult> => {
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

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseOpeningResult(text);
  };

  try {
    if (openingSignal.suspiciousOpeningGeometry) {
      const result = await runWithModel(OPENING_MODEL_ESCALATION);
      return {
        ...result,
        openingRegions: [],
      };
    }

    const flashResult = await runWithModel(OPENING_MODEL_PRIMARY);
    /*
    Flash FAIL is trusted immediately because it normally
    indicates an obvious architectural violation.
    */
    if (flashResult.status === "fail") {
      return {
        ...flashResult,
        openingRegions: [],
      };
    }

    /*
    Flash PASS must always be verified by Pro because Flash
    can miss subtle geometry changes (window shrink,
    opening boundary movement, etc.)
    */
    const proResult = await runWithModel(OPENING_MODEL_ESCALATION);
    return {
      ...proResult,
      openingRegions: [],
    };
  } catch (error: any) {
    throw new Error(`validator_error_opening:${error?.message || String(error)}`);
  }
}
