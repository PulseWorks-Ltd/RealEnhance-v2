import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import type { ValidationEvidence, RiskLevel } from "./validationEvidence";
import { createEmptyEvidence, shouldInjectEvidence } from "./validationEvidence";
import { getEvidenceGatingVariant, isEvidenceGatingEnabledForJob } from "./evidenceGating";
import { VALIDATION_FOCUS_MODE } from "../utils/logFocus";
import type { Stage2ValidationMode } from "./stage2ValidationMode";
import { validateStage2Refresh } from "./stage2/refresh.validator";
import { validateStage2Full } from "./stage2/full.validator";
import { detectWindowsLocal, type BBox } from "./local-windows";
import {
  hasStage1BStructuralSignal,
  isStage1BMinorReconstructionSignal,
} from "./stageAwareConfig";

const logger = console;
const VALIDATOR_LOGS_FOCUS = process.env.VALIDATOR_LOGS_FOCUS === "1";
const VALIDATOR_AUDIT_ENABLED = process.env.VALIDATOR_AUDIT === "1";

function debugInfo(...args: any[]) {
  if (!VALIDATOR_LOGS_FOCUS) {
    logger.info(...args);
  }
}

function debugLog(...args: any[]) {
  if (!VALIDATOR_LOGS_FOCUS) {
    console.log(...args);
  }
}

function isKitchenContext(roomType?: string): boolean {
  return roomType?.toLowerCase().includes("kitchen") ?? false;
}

// AUDIT FIX: Validator thresholds consolidated and documented
// MIN_CONFIDENCE: Below this, never hard-fail (low confidence = uncertain → allow through)
const MIN_CONFIDENCE = 0.75;
// BUILTIN_HARDFAIL_CONFIDENCE: Built-in violation requires this + ≥2 structural anchors to hard-fail
const BUILTIN_HARDFAIL_CONFIDENCE = 0.85;

/**
 * Model routing: LOW risk → fast model, MEDIUM/HIGH risk → strong model
 */
function getModelForRisk(riskLevel?: RiskLevel): string {
  const strongModel = process.env.GEMINI_VALIDATOR_MODEL_STRONG || "gemini-2.5-pro";
  const fastModel = process.env.GEMINI_VALIDATOR_MODEL_FAST || "gemini-2.5-flash";

  if (!riskLevel || riskLevel === "LOW") return fastModel;
  return strongModel; // MEDIUM and HIGH → strong model
}

function collectEvidenceKeys(evidence: ValidationEvidence): string[] {
  const keys: string[] = [];
  const windowsDelta = evidence.openings.windowsAfter - evidence.openings.windowsBefore;
  const doorsDelta = evidence.openings.doorsAfter - evidence.openings.doorsBefore;
  const hasAnchors = Object.values(evidence.anchorChecks || {}).some(Boolean);
  const hasDrift = (evidence.drift?.wallPercent ?? 0) > 0 ||
    (evidence.drift?.maskedEdgePercent ?? 0) > 0 ||
    (evidence.drift?.angleDegrees ?? 0) > 0;
  const ssimSignal = evidence.ssimPassed === false || evidence.ssim < evidence.ssimThreshold;

  if (ssimSignal) keys.push("ssim");
  if (windowsDelta !== 0 || doorsDelta !== 0) keys.push("openings");
  if (hasAnchors) keys.push("anchors");
  if (hasDrift) keys.push("drift");
  if (evidence.localFlags && evidence.localFlags.length > 0) keys.push("localFlags");

  return keys;
}

function gateEvidenceForGemini(stage: "1B" | "2", evidence: ValidationEvidence, jobId?: string): ValidationEvidence {
  if (!isEvidenceGatingEnabledForJob(jobId)) return evidence;

  const gated = createEmptyEvidence(evidence.jobId, evidence.stage, evidence.roomType);

  const windowsDelta = evidence.openings.windowsAfter - evidence.openings.windowsBefore;
  const doorsDelta = evidence.openings.doorsAfter - evidence.openings.doorsBefore;
  const openingsChanged = windowsDelta !== 0 || doorsDelta !== 0;
  const hasAnchors = Object.values(evidence.anchorChecks || {}).some(Boolean);

  const allowFlags: string[] = [];
  if (hasAnchors) {
    gated.anchorChecks = { ...evidence.anchorChecks };
    allowFlags.push(...evidence.localFlags.filter((flag) => flag.startsWith("anchor:")));
  }

  if (openingsChanged) {
    gated.openings = { ...evidence.openings };
  }

  const wallRemovalDetected = evidence.localFlags.some((flag) =>
    flag.toLowerCase().includes("wall") && flag.toLowerCase().includes("remove")
  );
  const structuralMaskFailed = evidence.localFlags.some((flag) =>
    flag.toLowerCase().includes("structuralmask") || flag.toLowerCase().includes("structural mask")
  );

  if (wallRemovalDetected) {
    allowFlags.push(...evidence.localFlags.filter((flag) =>
      flag.toLowerCase().includes("wall") && flag.toLowerCase().includes("remove")
    ));
  }

  if (structuralMaskFailed) {
    allowFlags.push(...evidence.localFlags.filter((flag) =>
      flag.toLowerCase().includes("structuralmask") || flag.toLowerCase().includes("structural mask")
    ));
  }

  if (stage === "1B") {
    const allowDrift = (evidence.drift?.wallPercent ?? 0) > 35 ||
      (evidence.drift?.maskedEdgePercent ?? 0) > 55 ||
      (evidence.drift?.angleDegrees ?? 0) > 25;
    if (allowDrift) {
      gated.drift = { ...evidence.drift };
    }
  }

  gated.localFlags = Array.from(new Set(allowFlags));
  gated.geometryProfile = evidence.geometryProfile;

  return gated;
}

/**
 * Build evidence-injected adjudicator prompt
 *
 * Architecture:
 * - SYSTEM BLOCK: Role definition + decision rules
 * - SIGNAL BLOCK: Auto-inserted ValidationEvidence (no human edits)
 * - RULE OVERRIDE BLOCK: Anchor overrides (any anchor flag → must say "structure")
 */
function buildAdjudicatorPrompt(
  basePrompt: string,
  evidence?: ValidationEvidence,
  riskLevel?: RiskLevel
): string {
  const structuralFocusRules = `

NON-STRUCTURAL DIFFERENCE FILTER (MANDATORY):
- Ignore furniture changes and object movement.
- Ignore lighting differences.
- Ignore shadows.
- Ignore color variation.
- Only evaluate permanent architectural structure.`;

  return `${basePrompt}${structuralFocusRules}`;
}

export type GeminiSemanticVerdict = {
  hardFail: boolean;
  category: "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown";
  reasons: string[];
  confidence: number;
  openingRemoved?: boolean;
  openingRelocated?: boolean;
  openingInfilled?: boolean;
  violationType?: "opening_change" | "wall_change" | "camera_shift" | "built_in_moved" | "fixture_change" | "ceiling_fixture_change" | "plumbing_change" | "faucet_change" | "layout_only" | "other";
  builtInDetected?: boolean;
  structuralAnchorCount?: number;
  beforeOpeningCount?: number;
  afterOpeningCount?: number;
  openingChangeSignificant?: boolean;
  openingToleranceReason?: "opening_minor_drift";
  openingDriftMetrics?: {
    countChanged: boolean;
    maxAreaDeltaRatio: number;
    maxCentroidShiftRatio: number;
    maxAspectRatioDeltaRatio: number;
    stateChanged: boolean;
  };
  rawText?: string;
};

export type Stage1BValidationMode =
  | "LIGHT_DECLUTTER"
  | "STRUCTURED_RETAIN";

type GeminiViolationType = NonNullable<GeminiSemanticVerdict["violationType"]>;

type OpeningSignificanceResult = {
  significant: boolean;
  countChanged: boolean;
  maxAreaDeltaRatio: number;
  maxCentroidShiftRatio: number;
  maxAspectRatioDeltaRatio: number;
};

const OPENING_AREA_DELTA_THRESHOLD = 0.08;
const OPENING_CENTROID_SHIFT_THRESHOLD = 0.03;
const OPENING_ASPECT_RATIO_DELTA_THRESHOLD = 0.05;

function bboxToMetrics(bbox: BBox) {
  const [x, y, width, height] = bbox;
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const area = safeWidth * safeHeight;
  const cx = x + safeWidth / 2;
  const cy = y + safeHeight / 2;
  const aspect = safeWidth / safeHeight;
  return { area, cx, cy, aspect };
}

function hasOpeningStateChangeSignal(reasons: string[]): boolean {
  const reasonText = reasons.join(" ").toLowerCase();
  return [
    "opening sealed",
    "sealed opening",
    "blocked opening",
    "opening blocked",
    "window removed",
    "door removed",
    "removed opening",
    "new opening",
    "opening added",
    "closed opening",
  ].some((token) => reasonText.includes(token));
}

export function isOpeningChangeSignificant(
  beforeBBoxes: BBox[],
  afterBBoxes: BBox[],
  imageWidth: number,
  imageHeight: number
): OpeningSignificanceResult {
  const countChanged = beforeBBoxes.length !== afterBBoxes.length;
  if (countChanged) {
    return {
      significant: true,
      countChanged,
      maxAreaDeltaRatio: 1,
      maxCentroidShiftRatio: 1,
      maxAspectRatioDeltaRatio: 1,
    };
  }

  if (beforeBBoxes.length === 0 || !imageWidth || !imageHeight) {
    return {
      significant: false,
      countChanged: false,
      maxAreaDeltaRatio: 0,
      maxCentroidShiftRatio: 0,
      maxAspectRatioDeltaRatio: 0,
    };
  }

  const norm = Math.max(1, Math.max(imageWidth, imageHeight));
  const used = new Set<number>();
  let maxAreaDeltaRatio = 0;
  let maxCentroidShiftRatio = 0;
  let maxAspectRatioDeltaRatio = 0;

  for (const before of beforeBBoxes) {
    const beforeM = bboxToMetrics(before);
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let idx = 0; idx < afterBBoxes.length; idx += 1) {
      if (used.has(idx)) continue;
      const afterM = bboxToMetrics(afterBBoxes[idx]);
      const dx = afterM.cx - beforeM.cx;
      const dy = afterM.cy - beforeM.cy;
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = idx;
      }
    }

    if (bestIndex < 0) {
      return {
        significant: true,
        countChanged: true,
        maxAreaDeltaRatio: 1,
        maxCentroidShiftRatio: 1,
        maxAspectRatioDeltaRatio: 1,
      };
    }

    used.add(bestIndex);
    const afterM = bboxToMetrics(afterBBoxes[bestIndex]);
    const areaDeltaRatio = Math.abs(afterM.area - beforeM.area) / Math.max(1, beforeM.area);
    const centroidShiftRatio = Math.hypot(afterM.cx - beforeM.cx, afterM.cy - beforeM.cy) / norm;
    const aspectDeltaRatio = Math.abs(afterM.aspect - beforeM.aspect) / Math.max(0.01, Math.abs(beforeM.aspect));

    if (areaDeltaRatio > maxAreaDeltaRatio) maxAreaDeltaRatio = areaDeltaRatio;
    if (centroidShiftRatio > maxCentroidShiftRatio) maxCentroidShiftRatio = centroidShiftRatio;
    if (aspectDeltaRatio > maxAspectRatioDeltaRatio) maxAspectRatioDeltaRatio = aspectDeltaRatio;
  }

  const significant =
    maxAreaDeltaRatio > OPENING_AREA_DELTA_THRESHOLD ||
    maxCentroidShiftRatio > OPENING_CENTROID_SHIFT_THRESHOLD ||
    maxAspectRatioDeltaRatio > OPENING_ASPECT_RATIO_DELTA_THRESHOLD;

  return {
    significant,
    countChanged: false,
    maxAreaDeltaRatio,
    maxCentroidShiftRatio,
    maxAspectRatioDeltaRatio,
  };
}

function isBuiltInDowngradeAllowed(input: {
  violationType: GeminiViolationType;
  builtInDetected: boolean;
  structuralAnchorCount: number;
  confidence: number;
}): boolean {
  if (input.violationType !== "built_in_moved") return false;
  if (!input.builtInDetected) return false;
  return input.structuralAnchorCount < 2 || input.confidence < BUILTIN_HARDFAIL_CONFIDENCE;
}

function normalizeStage2FullStructuralViolationType(input: {
  rawViolationType: GeminiViolationType;
  reasonText: string;
}): GeminiViolationType {
  const reasonText = input.reasonText;
  const rawViolationType = input.rawViolationType || "other";

  if (rawViolationType === "opening_change") return "opening_change";
  if (rawViolationType === "camera_shift") return "camera_shift";
  if (rawViolationType === "wall_change") return "wall_change";
  if (rawViolationType === "built_in_moved") return "built_in_moved";

  const openingTokens = [
    "opening",
    "window",
    "door",
    "sealed",
    "blocked doorway",
    "resized",
    "added opening",
    "removed opening",
  ];
  if (openingTokens.some((token) => reasonText.includes(token))) return "opening_change";

  const cameraTokens = [
    "camera shift",
    "viewpoint",
    "fov",
    "field of view",
    "perspective",
    "vanishing",
    "crop",
    "framing shift",
  ];
  if (cameraTokens.some((token) => reasonText.includes(token))) return "camera_shift";

  const wallTokens = [
    "wall drift",
    "envelope",
    "geometry drift",
    "wall",
    "corner",
    "ceiling plane",
    "room width",
    "room depth",
    "functional zone expansion",
  ];
  if (wallTokens.some((token) => reasonText.includes(token))) return "wall_change";

  const builtInTokens = [
    "built-in",
    "built in",
    "kitchen island",
    "island footprint",
    "island length",
    "hvac",
    "heat pump",
    "vent grille",
    "plumbing fixture",
    "faucet",
    "tap",
    "pendant light",
    "downlight",
    "ceiling fan",
  ];
  if (builtInTokens.some((token) => reasonText.includes(token))) return "built_in_moved";

  return "other";
}

function hasStage2FullPrimaryStructuralIdentityViolation(input: {
  category: GeminiSemanticVerdict["category"];
  violationType: GeminiViolationType;
  reasonText: string;
}): boolean {
  if (
    input.violationType === "opening_change" ||
    input.violationType === "wall_change" ||
    input.violationType === "camera_shift"
  ) {
    return true;
  }

  const structuralTokens = [
    "opening added",
    "opening removed",
    "opening resized",
    "opening sealed",
    "window removed",
    "window added",
    "door removed",
    "door added",
    "camera shift",
    "viewpoint shift",
    "camera angle",
    "perspective shift",
    "envelope geometry drift",
    "wall drift",
    "wall added",
    "wall removed",
    "room volume changed",
    "room width",
    "room depth",
    "architectural footprint",
    "functional zone expansion",
  ];

  return structuralTokens.some((token) => input.reasonText.includes(token));
}

function hasStage2PrimaryStructuralViolation(input: {
  violationType: GeminiViolationType;
  reasonText: string;
  stage2FullPrimaryStructuralIdentityViolation: boolean;
  builtInDetected: boolean;
  structuralAnchorCount: number;
  confidence: number;
}): {
  primaryStructuralViolationDetected: boolean;
  hasOpeningChange: boolean;
  hasWallGeometryDrift: boolean;
  hasCameraShift: boolean;
  hasEnvelopeDeformation: boolean;
  hasConfirmedBuiltInRelocation: boolean;
} {
  const hasOpeningChange = input.violationType === "opening_change";

  const hasWallGeometryDrift =
    input.violationType === "wall_change" ||
    [
      "wall removed",
      "wall added",
      "wall deletion",
      "wall addition",
      "wall plane",
      "wall geometry",
      "load-bearing",
    ].some((token) => input.reasonText.includes(token));

  const hasCameraShift =
    input.violationType === "camera_shift" ||
    [
      "camera shift",
      "camera angle",
      "viewpoint shift",
      "perspective shift",
      "field of view",
      "fov",
    ].some((token) => input.reasonText.includes(token));

  const hasEnvelopeDeformation =
    input.stage2FullPrimaryStructuralIdentityViolation ||
    [
      "room envelope",
      "envelope geometry",
      "room volume changed",
      "room width",
      "room depth",
      "ceiling plane",
      "architectural footprint",
    ].some((token) => input.reasonText.includes(token));

  const hasConfirmedBuiltInRelocation =
    (input.violationType === "built_in_moved" || input.builtInDetected) &&
    input.structuralAnchorCount >= 2 &&
    input.confidence >= BUILTIN_HARDFAIL_CONFIDENCE;

  const primaryStructuralViolationDetected =
    hasOpeningChange ||
    hasWallGeometryDrift ||
    hasCameraShift ||
    hasEnvelopeDeformation ||
    hasConfirmedBuiltInRelocation;

  return {
    primaryStructuralViolationDetected,
    hasOpeningChange,
    hasWallGeometryDrift,
    hasCameraShift,
    hasEnvelopeDeformation,
    hasConfirmedBuiltInRelocation,
  };
}

function hasOpeningIdentityViolationSignal(
  violationType: GeminiViolationType | string | undefined,
  reasonText: string
): boolean {
  const violation = String(violationType || "").toLowerCase();
  if (
    violation === "opening_change" ||
    violation === "opening_removed" ||
    violation === "opening_infilled" ||
    violation === "opening_relocated" ||
    violation === "door_removed" ||
    violation === "window_removed" ||
    violation === "closet_removed"
  ) {
    return true;
  }

  const openingIdentityTokens = [
    "opening removed",
    "removed opening",
    "opening infilled",
    "opening filled",
    "opening relocated",
    "opening moved",
    "window removed",
    "door removed",
    "closet removed",
    "closet door removed",
    "sealed opening",
    "walled over",
    "continuous wall",
  ];

  return openingIdentityTokens.some((token) => reasonText.includes(token));
}

export function buildFinalFixtureConfirmPrompt(input: {
  sceneType?: "interior" | "exterior";
  localFindings?: string[];
  validationMode?: Stage2ValidationMode;
} = {}): string {
  const findings = (input.localFindings || []).filter(Boolean);

  const parsePercentFromFindings = (patterns: RegExp[]): number => {
    for (const finding of findings) {
      for (const pattern of patterns) {
        const match = finding.match(pattern);
        if (match?.[1]) {
          const value = Number(match[1]);
          if (Number.isFinite(value)) return value;
        }
      }
    }
    return 0;
  };

  const parseOpeningDeltaTotal = (): number => {
    for (const finding of findings) {
      const openingsDeltaMatch = finding.match(/openings_delta_total\s*:\s*([+-]?[\d.]+)/i);
      if (openingsDeltaMatch?.[1]) {
        const value = Number(openingsDeltaMatch[1]);
        if (Number.isFinite(value)) return value;
      }
    }

    let windowsDelta = 0;
    let doorsDelta = 0;
    let foundWindows = false;
    let foundDoors = false;

    for (const finding of findings) {
      if (!foundWindows) {
        const windowsMatch = finding.match(/window_count_delta\s*:\s*(-?\d+)\s*->\s*(-?\d+)/i);
        if (windowsMatch) {
          windowsDelta = Number(windowsMatch[2]) - Number(windowsMatch[1]);
          foundWindows = true;
        }
      }

      if (!foundDoors) {
        const doorsMatch = finding.match(/door_count_delta\s*:\s*(-?\d+)\s*->\s*(-?\d+)/i);
        if (doorsMatch) {
          doorsDelta = Number(doorsMatch[2]) - Number(doorsMatch[1]);
          foundDoors = true;
        }
      }

      if (foundWindows && foundDoors) break;
    }

    if (foundWindows || foundDoors) return windowsDelta + doorsDelta;

    for (const finding of findings) {
      const semanticOpeningsMatch = finding.match(/openings\s*\+\s*(\d+)\s*\/\s*-\s*(\d+)/i);
      if (semanticOpeningsMatch) {
        return Number(semanticOpeningsMatch[1]) - Number(semanticOpeningsMatch[2]);
      }
    }

    return 0;
  };

  const openingDeltaTotal = parseOpeningDeltaTotal();
  const openingDeltaAdvisoryBlock = openingDeltaTotal !== 0
    ? `- advisory_opening_delta_signal: openings_delta_total=${openingDeltaTotal >= 0 ? "+" : ""}${openingDeltaTotal}
- advisory_opening_delta_note: validate opening continuity visually before final decision (advisory only)`
    : "";

  const findingsBlock = findings.length
    ? [findings.map((f) => `- ${f}`).join("\n"), openingDeltaAdvisoryBlock].filter(Boolean).join("\n")
    : openingDeltaAdvisoryBlock || "- none";

  const openingDriftPct = parsePercentFromFindings([
    /opening(?:_|\s*)drift(?:_|\s*)pct\s*[:=]\s*([\d.]+)/i,
    /opening(?:_|\s*)drift\s*([\d.]+)%/i,
  ]);

  const maskedEdgeDriftPct = parsePercentFromFindings([
    /masked(?:_|\s*)drift(?:_|\s*)pct\s*[:=]\s*([\d.]+)/i,
    /masked_edge_failed:\s*drift\s*([\d.]+)%/i,
    /masked(?:_|\s*)edge(?:_|\s*)drift\s*([\d.]+)%/i,
  ]);

  const semanticWallDriftFlag = findings.some((f) =>
    /semantic_validator_failed|wall_drift_pct\s*:|wall_drift\s*[\d.]+%/i.test(f)
  );

  const openingCountMismatch = findings.some((f) => {
    const windowsMatch = f.match(/window_count_delta\s*:\s*(-?\d+)\s*->\s*(-?\d+)/i);
    if (windowsMatch) return Number(windowsMatch[1]) !== Number(windowsMatch[2]);

    const doorsMatch = f.match(/door_count_delta\s*:\s*(-?\d+)\s*->\s*(-?\d+)/i);
    if (doorsMatch) return Number(doorsMatch[1]) !== Number(doorsMatch[2]);

    const openingsDeltaMatch = f.match(/openings_delta_total\s*:\s*([+-]?[\d.]+)/i);
    if (openingsDeltaMatch) return Number(openingsDeltaMatch[1]) !== 0;

    const semanticOpeningsMatch = f.match(/openings\s*\+\s*(\d+)\s*\/\s*-\s*(\d+)/i);
    if (semanticOpeningsMatch) {
      return Number(semanticOpeningsMatch[1]) !== 0 || Number(semanticOpeningsMatch[2]) !== 0;
    }

    return false;
  });

  let structuralConcernScore = 0;
  if (openingCountMismatch) structuralConcernScore += 2;
  if (semanticWallDriftFlag) structuralConcernScore += 1;
  if (openingDriftPct >= 20) structuralConcernScore += 2;
  else if (openingDriftPct >= 8) structuralConcernScore += 1;
  if (maskedEdgeDriftPct >= 60) structuralConcernScore += 2;
  else if (maskedEdgeDriftPct >= 30) structuralConcernScore += 1;

  let structuralConcernLevel: "Tier 1" | "Tier 2" | "Tier 3" | null = null;
  if (structuralConcernScore >= 4) structuralConcernLevel = "Tier 3";
  else if (structuralConcernScore >= 2) structuralConcernLevel = "Tier 2";
  else if (
    openingDriftPct > 0 ||
    maskedEdgeDriftPct > 0 ||
    semanticWallDriftFlag ||
    openingCountMismatch
  ) {
    structuralConcernLevel = "Tier 1";
  }

  const structuralGuidanceBlock = structuralConcernLevel
    ? structuralConcernLevel === "Tier 3"
      ? `
STRUCTURAL GUIDANCE (${structuralConcernLevel} — HIGH ADVISORY)
- Local drift signals are strong. Perform a focused second-pass visual inspection on openings, wall envelope, and fixed built-ins.
- Treat this as an inspection priority signal only.
- Do NOT force hardFail from drift metrics alone; require clear visual evidence in BEFORE vs AFTER.`
      : structuralConcernLevel === "Tier 2"
        ? `
STRUCTURAL GUIDANCE (${structuralConcernLevel} — MODERATE ADVISORY)
- Local signals suggest possible structural inconsistency. Inspect openings and wall boundaries carefully before deciding.
- Use drift as directional guidance, not proof.
- Do NOT force hardFail from drift metrics alone; require clear visual evidence in BEFORE vs AFTER.`
        : `
STRUCTURAL GUIDANCE (${structuralConcernLevel} — MILD ADVISORY)
- Minor local drift signals detected. Do a light targeted check for opening continuity and envelope consistency.
- Keep furniture-occlusion false positives in mind.
- Do NOT force hardFail from drift metrics alone; require clear visual evidence in BEFORE vs AFTER.`
    : "";

  const mode = input.validationMode || "REFRESH_OR_DIRECT";
  const modeContextBlock = mode === "FULL_STAGE_ONLY"
    ? `IMPORTANT CONTEXT:

This transformation represents FULL VIRTUAL STAGING of an originally empty room.

In this mode:
- Furniture additions are expected.
- Furniture may partially occlude windows and doors.
- Pixel similarity (SSIM) may drop significantly due to new furniture.
- Anchor detections (e.g., island_changed) may fire due to added furniture.

You MUST NOT treat the following as structural violations by themselves:
- Furniture occlusion of openings
- Decor changes
- Freestanding object additions
- Lighting or texture drift

Only return NON-COMPLIANT if:
- A wall was removed or added.
- A permanent structural opening (door/window) was removed.
- The architectural footprint changed.
- Structural cabinetry was deleted (not just visually modified).

For FULL_STAGE_ONLY:
Low SSIM alone is NOT evidence of structural change in full staging mode.

PRIMARY VS SECONDARY ENFORCEMENT (FULL_STAGE_ONLY):
- PRIMARY (must hard-fail when clearly changed): walls, windows/doors/openings, camera viewpoint, room envelope/volume.
- SECONDARY (advisory unless strongly corroborated): pendant lights, HVAC, kitchen island, plumbing fixtures.

Do NOT set hardFail=true for secondary fixture-only changes unless confidence is very high and evidence indicates a true non-movable structural identity violation.`
    : `IMPORTANT CONTEXT:

This transformation represents REFRESH STAGING.
Structural layout and architectural features must remain unchanged.

In this mode:
- Furniture should remain anchored.
- Openings must remain visible and unaltered.
- Structural elements must not change.

If local signals indicate opening removal or anchor relocation, evaluate strictly.

For REFRESH mode:
Keep stricter interpretation of SSIM and anchor/opening consistency together with visual verification.`;

  return `ROLE — Final Fixture & Built-In Identity Auditor

You are the final-pass adjudicator for fixed fixtures and built-in identity consistency.

Compare BEFORE (Stage 1A baseline/original-enhanced image) vs AFTER (Stage 2 candidate image).

Hard rule:
Removal or addition of freestanding furniture, wall art, decor, shelving, desks,
bedside tables, or bedding does NOT constitute structural change.
Only walls, openings (doors/windows), camera position, room envelope,
and permanently built-in fixtures are structural.

CRITICAL STRUCTURAL OPENING VERIFICATION

OCCLUSION & REVEAL PROTECTION (CRITICAL)

Structural visibility must remain consistent with BEFORE.

If a structural surface was partially obscured (e.g., by curtains, blinds, or soft furnishings),
AFTER must not:

• Remove occluding elements to reveal new wall area
• Reveal previously unseen structural boundaries
• Reveal new opening geometry
• Extend visible wall envelope beyond what was visible in BEFORE

Hard fail if newly visible structural surfaces appear that were not clearly visible in BEFORE.

If detected:
→ category = structure
→ violationType = layout_only
→ hardFail = true

You MUST verify that every doorway and window visible in BEFORE
still exists in AFTER.

If an opening has been sealed, covered with wall surface,
visually removed, or converted into solid wall area,
this is structural removal.

This MUST be classified as:
→ category = structure
→ violationType = opening_change
→ hardFail = true

Focus ONLY on these fixed/built-in checks:
• faucets and taps
• sinks and sink count
• built-in ovens
• cooktops
• rangehoods
• built-in cabinetry
• cabinet count
• cabinet layout
• cabinet door style class
• kitchen islands
• pendant lights
• downlights
• fixed ceiling fixtures

CEILING FIXTURE STRUCTURAL ENFORCEMENT (CRITICAL)

Ceiling-mounted fixtures are structural elements.

Adding, removing, relocating, resizing, or changing the count of:

• pendant lights
• downlights
• fixed ceiling fixtures

is structural.

Hard fail if any of the above changes are detected.

If detected:
→ category = structure
→ violationType = built_in_moved
→ hardFail = true

• vents and grilles
• HVAC / heat pump units
• thermostats and control panels
• switch plates and outlet plates
• doorway openings added or removed

BUILT-IN GEOMETRIC ENVELOPE LOCK (CRITICAL)

Built-in elements must preserve their exact geometric footprint and silhouette envelope.

This includes:

• Edge boundary alignment
• Countertop length
• Cabinet depth
• Cabinet termination points
• Island footprint dimensions
• Spatial alignment relative to walls

Hard fail if:

• A kitchen island footprint expands or contracts
• A cabinet run extends into new floor area
• Counter length increases or decreases
• Built-in geometry encloses previously open space
• Silhouette envelope changes even if material appears similar

Subtle perspective-adjusted enlargement counts as built-in movement.

If detected:
→ category = structure
→ violationType = built_in_moved
→ hardFail = true

IGNORE (out of scope):
• general wall surface color differences
• general wall texture differences
• cosmetic repainting
• staging furniture styling
• decor differences
• lighting tone differences

FINAL LOCAL VALIDATOR FINDINGS — MUST ADJUDICATE
The following automated validator signals are advisory heuristics and may include false positives.
Treat them as hints to verify visually, not confirmed violations.

Advisory structural signals detected by local heuristics (may include false positives):
- opening visibility delta
- anchor detection (e.g., island_changed)
- SSIM drift

${modeContextBlock}

${structuralGuidanceBlock}

${findingsBlock}

────────────────────────────────────────
CRITICAL OPENING CONTINUITY CHECK (HARD FAIL)

You are comparing TWO images:
- ORIGINAL (pre-stage)
- ENHANCED (post-stage)

Architectural openings (doors, closets, recesses, pass-throughs)
that are visible in the ORIGINAL must remain architecturally present
in the ENHANCED.

You must explicitly verify:

1. If a door frame, doorway, or recess opening exists in the ORIGINAL,
  it must still exist in the ENHANCED.

2. It is a HARD FAIL if any of the following occur:
  - The opening is replaced with flat continuous wall surface
  - The opening is painted over or visually removed
  - The opening is filled in or extended into wall plane
  - Furniture is placed directly in front of the opening AND
    the opening structure is no longer visible
  - A door location is converted into seamless wall backing

3. Furniture placement does NOT justify architectural deletion.
  Architectural continuity takes priority over layout plausibility.

4. Minor lighting changes or shadow shifts are NOT structural changes.
  Only removal or suppression of an opening counts.

If an opening existed in the ORIGINAL and is not clearly present
in the ENHANCED, you must return:

violationType = "opening_suppressed"
hardFail = true

Do not remove or replace any existing prompt content.

Adjudication rule:
If findings suggest openings delta ≠ 0,
doorway removed/added, opening sealed,
anchor moved, or built-in changed,
visually verify first, then classify based on image evidence.
Do not treat heuristic signals as facts without visual confirmation.

Return JSON only.

Output schema (unchanged):
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": [string],
  "confidence": number,
  "violationType": "opening_change"|"wall_change"|"camera_shift"|"built_in_moved"|"layout_only"|"other",
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}

Scene: ${(input.sceneType || "interior").toUpperCase()}`;
}

const STAGE1B_HARDENED_STRUCTURAL_PROMPT = `🔐 STAGE 1B — STRUCTURAL ENVELOPE LOCK VALIDATOR
You are a Stage 1B Structural Integrity Auditor for NZ real estate imagery.

Minor surface reconstruction caused by furniture removal is expected and acceptable.
Do NOT classify small wall reconstruction, edge cleanup, or occluded surface recovery as structural change.
Only classify as structural change if doors, windows, walls, or permanent openings were clearly added, removed, or relocated.

Compare BEFORE and AFTER images.

Return JSON only.


─────────────────────────────
STAGE 1B CONTEXT
─────────────────────────────
BEFORE = original furnished room.
AFTER = decluttered output.

Stage 1B is STRICTLY SUBTRACTIVE.

Only clutter and movable furniture may be removed.

The architectural shell MUST remain visually identical.


─────────────────────────────
STRUCTURE DEFINITION (ONLY WHAT MATTERS)
─────────────────────────────
Structure consists of:

• walls and wall positions
• wall angles and corner locations
• ceilings and ceiling height
• floors and floor boundaries
• windows and doors (openings)
• built-in cabinetry and architectural millwork
• plumbing fixtures
• fixed lighting
• HVAC units and vents
• camera viewpoint and perspective


OPENING PRESERVATION — ABSOLUTE RULE:

If any doorway, doorframe, door recess, archway, or window visible in BEFORE is missing, sealed, flattened, painted over, or converted into solid wall in AFTER, this is a structural identity violation.

This includes:
- Doors painted into wall texture
- Door frames removed
- Door recesses filled
- Negative space replaced with flat wall surface
- Archways removed or flattened

These are structural failures.
If detected, return hardFail=true immediately.

Removal of freestanding objects near doors does NOT permit alteration of the door itself.


─────────────────────────────
ZERO-TOLERANCE ENVELOPE LOCK
─────────────────────────────
The architectural envelope must appear visually identical.

Hard fail if ANY of the following differ:

• room width or depth appears changed
• wall lengths appear altered
• corner positions shift
• ceiling geometry differs
• floor boundary or depth perspective differs
• window-to-wall ratio differs
• door-to-wall ratio differs
• visible wall spacing differs
• camera viewpoint shifts
• vanishing lines differ
• field of view differs
• room appears wider or narrower
• perspective compression differs

If envelope similarity appears less than ~95% visually identical:
→ hardFail true


─────────────────────────────
OPENINGS LOCK (STRICT)
─────────────────────────────
All windows and doors must:

• exist in identical positions
• maintain identical proportions
• maintain identical framing
• maintain identical visible scale relative to wall

Hard fail if:

• any opening is resized
• any opening is repositioned
• framing thickness changes
• new opening appears
• opening geometry is extended or completed beyond visible evidence


─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered in any way:

• walls, ceilings, floors, baseboards
• windows and doors (including frames)
• built-in cabinetry
• kitchen islands and counters
• plumbing fixtures
• fixed lighting
• HVAC units
• curtain rails, rods, tracks, blind housings
• exterior view through windows

Addition OR removal OR resizing → hardFail true


─────────────────────────────
CAMERA LOCK (DETERMINISTIC)
─────────────────────────────
Camera must remain fixed.

Hard fail if:

• vanishing point shifts
• perspective depth changes
• relative wall angles change
• framing crops differently
• field of view widens or narrows


─────────────────────────────
NUMERIC SIGNAL ENFORCEMENT
─────────────────────────────
If structural IoU, edge alignment, or spatial similarity appear reduced,
err toward hardFail true.

Do NOT downgrade based on confidence.


─────────────────────────────
OUTPUT
─────────────────────────────
If ANY structural drift detected:

{
  "hardFail": true,
  "category": "structure",
  "violationType": "wall_change" | "opening_change" | "camera_shift",
  "reasons": [string],
  "confidence": number
}

If structure appears identical:

{
  "hardFail": false,
  "category": "structure",
  "violationType": "other",
  "reasons": [],
  "confidence": number
}`;

function extractOpeningCountsFromStage1BText(text: string): { beforeOpeningCount?: number; afterOpeningCount?: number } {
  if (!text) return {};

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const target = jsonMatch ? jsonMatch[0] : text;

  try {
    const parsed = JSON.parse(target);
    const beforeCandidate =
      parsed.beforeOpeningCount ??
      parsed.openingsBefore ??
      parsed.beforeOpenings ??
      parsed.before_opening_count;
    const afterCandidate =
      parsed.afterOpeningCount ??
      parsed.openingsAfter ??
      parsed.afterOpenings ??
      parsed.after_opening_count;

    const beforeOpeningCount = typeof beforeCandidate === "number" ? beforeCandidate : undefined;
    const afterOpeningCount = typeof afterCandidate === "number" ? afterCandidate : undefined;

    return { beforeOpeningCount, afterOpeningCount };
  } catch {
    return {};
  }
}

export async function validateStage1BStructure(
  beforeImage: string,
  afterImage: string,
  evidence?: ValidationEvidence
): Promise<GeminiSemanticVerdict> {
  const ai = getGeminiClient();
  const before = toBase64(beforeImage).data;
  const after = toBase64(afterImage).data;
  const model = process.env.GEMINI_VALIDATOR_MODEL_PRIMARY || "gemini-2.5-flash";
  const jobId = evidence?.jobId;
  const variant = getEvidenceGatingVariant(jobId);
  const gatingEnabled = isEvidenceGatingEnabledForJob(jobId);

  const windowsDelta = evidence
    ? (evidence.openings.windowsAfter - evidence.openings.windowsBefore)
    : 0;
  const doorsDelta = evidence
    ? (evidence.openings.doorsAfter - evidence.openings.doorsBefore)
    : 0;
  const openingCountDelta = windowsDelta + doorsDelta;
  const openingRemovalDetected = openingCountDelta < 0;
  const suspiciousWallExpansion = evidence?.localFlags.includes("suspicious_wall_expansion") === true;
  const newWallRatioStructuralSignal = evidence?.localFlags.includes("new_wall_ratio_gt_0_01") === true;
  const structuralSignalPresent = hasStage1BStructuralSignal({
    newWallRatio: newWallRatioStructuralSignal ? 0.02 : 0,
    suspiciousWallExpansion,
    openingCountDelta,
  });
  const minorReconstructionSignal = isStage1BMinorReconstructionSignal({
    newWallRatio: newWallRatioStructuralSignal ? 0.02 : 0,
    suspiciousWallExpansion,
    openingCountDelta,
  });
  const shouldInjectStage1BSignals = false;
  const stage1BPrompt = STAGE1B_HARDENED_STRUCTURAL_PROMPT;

  const contents = [
    { role: "user", parts: [{ text: stage1BPrompt }] },
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/webp", data: before } },
        { inlineData: { mimeType: "image/webp", data: after } },
      ],
    },
  ];

  if (VALIDATOR_AUDIT_ENABLED) {
    const requestAuditPayload = {
      model,
      generationConfig: {
        temperature: 0,
        topP: 0,
        maxOutputTokens: 256,
      },
      contents: [
        { role: "user", parts: [{ text: stage1BPrompt }] },
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/webp", byteLength: before.length } },
            { inlineData: { mimeType: "image/webp", byteLength: after.length } },
          ],
        },
      ],
    };

    console.log(`[VALIDATOR AUDIT][GEMINI_STAGE1B_REQUEST] job=${jobId || "unknown"} payload=${JSON.stringify(requestAuditPayload)}`);
  }

  if (VALIDATION_FOCUS_MODE) {
    debugInfo("[EVIDENCE_GATING_VARIANT]", {
      jobId: jobId || "unknown",
      variant,
      stage: "1B",
      injected: shouldInjectStage1BSignals,
      openingRemovalDetected,
      suspiciousWallExpansion,
      openingCountDelta,
    });
  }

  try {
    const response = await (ai as any).models.generateContent({
      model,
      contents,
      generationConfig: {
        temperature: 0,
        topP: 0,
        maxOutputTokens: 256,
      },
    } as any);

    const textParts = (response as any)?.candidates?.[0]?.content?.parts || [];
    const text = textParts.map((p: any) => p?.text || "").join(" ").trim();

    if (VALIDATOR_AUDIT_ENABLED) {
      console.log(`[VALIDATOR AUDIT][GEMINI_STAGE1B_RESPONSE_RAW] job=${jobId || "unknown"} raw=${text}`);
    }

    const parsed = parseGeminiSemanticText(text);
    const openingCounts = extractOpeningCountsFromStage1BText(text);
    const category = parsed.category === "structure" ? "structure" : "unknown";
    const baseHardFail = parsed.hardFail === true && category === "structure";
    const parsedViolationType =
      parsed.violationType === "wall_change" || parsed.violationType === "opening_change" || parsed.violationType === "camera_shift"
        ? parsed.violationType
        : "wall_change";

    let openingChangeSignificant = true;
    let openingToleranceReason: "opening_minor_drift" | undefined;
    let openingDriftMetrics: GeminiSemanticVerdict["openingDriftMetrics"];

    if (parsedViolationType === "opening_change") {
      try {
        const [beforeDetections, afterDetections] = await Promise.all([
          detectWindowsLocal(beforeImage),
          detectWindowsLocal(afterImage),
        ]);

        const significance = isOpeningChangeSignificant(
          beforeDetections.windows.map((window) => window.bbox),
          afterDetections.windows.map((window) => window.bbox),
          beforeDetections.width,
          beforeDetections.height
        );

        const windowsDelta = evidence
          ? (evidence.openings.windowsAfter - evidence.openings.windowsBefore)
          : 0;
        const doorsDelta = evidence
          ? (evidence.openings.doorsAfter - evidence.openings.doorsBefore)
          : 0;
        const countChanged = windowsDelta !== 0 || doorsDelta !== 0 || significance.countChanged;
        const stateChanged = hasOpeningStateChangeSignal(parsed.reasons || []);

        openingChangeSignificant =
          countChanged ||
          stateChanged ||
          significance.significant;

        openingDriftMetrics = {
          countChanged,
          maxAreaDeltaRatio: significance.maxAreaDeltaRatio,
          maxCentroidShiftRatio: significance.maxCentroidShiftRatio,
          maxAspectRatioDeltaRatio: significance.maxAspectRatioDeltaRatio,
          stateChanged,
        };

        if (!openingChangeSignificant) {
          openingToleranceReason = "opening_minor_drift";
          console.log("[STAGE1B_OPENING_TOLERATED_DRIFT]", {
            maxAreaDeltaRatio: Number(significance.maxAreaDeltaRatio.toFixed(4)),
            maxCentroidShiftRatio: Number(significance.maxCentroidShiftRatio.toFixed(4)),
            maxAspectRatioDeltaRatio: Number(significance.maxAspectRatioDeltaRatio.toFixed(4)),
            thresholds: {
              areaDeltaRatio: OPENING_AREA_DELTA_THRESHOLD,
              centroidShiftRatio: OPENING_CENTROID_SHIFT_THRESHOLD,
              aspectRatioDeltaRatio: OPENING_ASPECT_RATIO_DELTA_THRESHOLD,
            },
            countChanged,
            stateChanged,
          });
        }
      } catch (openingAssessErr) {
        console.warn("[stage1b_structure_validator] opening significance assessment failed; defaulting to significant", openingAssessErr);
      }
    }

    let hardFail =
      baseHardFail &&
      (parsedViolationType !== "opening_change" || openingChangeSignificant);

    if (minorReconstructionSignal && !structuralSignalPresent) {
      hardFail = false;
    }

    if (VALIDATOR_AUDIT_ENABLED) {
      console.log(
        `[VALIDATOR AUDIT][GEMINI_STAGE1B_DECISION] job=${jobId || "unknown"} category=${category} violationType=${hardFail ? parsedViolationType : "other"} confidence=${Number.isFinite(parsed.confidence) ? parsed.confidence : 0} hardFail=${hardFail} finalDecision=${hardFail ? "BLOCK" : "PASS"}`
      );
    }

    return {
      hardFail,
      category,
      reasons: parsed.reasons || [],
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0,
      violationType: hardFail
        ? parsedViolationType
        : "other",
      builtInDetected: false,
      structuralAnchorCount: 0,
      beforeOpeningCount: openingCounts.beforeOpeningCount,
      afterOpeningCount: openingCounts.afterOpeningCount,
      openingChangeSignificant,
      openingToleranceReason,
      openingDriftMetrics,
      rawText: text,
    };
  } catch (err: any) {
    if (VALIDATOR_AUDIT_ENABLED) {
      console.log(`[VALIDATOR AUDIT][GEMINI_STAGE1B_ERROR] job=${jobId || "unknown"} message=${err?.message || String(err)} finalDecision=BLOCK`);
    }
    return {
      hardFail: true,
      category: "structure",
      reasons: [`stage1b_structure_validator_error: ${err?.message || String(err)}`],
      confidence: 0,
      violationType: "other",
      builtInDetected: false,
      structuralAnchorCount: 0,
      rawText: err?.message || String(err),
    };
  }
}

const STAGE1B_LIGHT_DECLUTTER_CONTEXT_BLOCK = `
─────────────────────────────
STAGE CONTEXT — LIGHT DECLUTTER
─────────────────────────────
The BEFORE image is the original furnished room.
The AFTER image is a light decluttered version.

Light declutter MAY remove:
• small loose items
• decor objects
• table-top items
• small floor clutter
• portable accessories

Light declutter MAY:
• simplify surfaces
• clear visual clutter
• remove small movable objects

Light declutter MUST NOT:
• remove built-in furniture
• remove large primary furniture
• modify structure
• change layout anchors
• change fixtures
• change camera viewpoint
`;

const STAGE1B_LIGHT_DECLUTTER_ALLOWED_DIFFERENCES_BLOCK = `
─────────────────────────────
ALLOWED DIFFERENCES — DO NOT FLAG
─────────────────────────────
Do NOT flag as violations:
• missing small decor
• cleared tabletops
• removed small objects
• simplified shelves
• fewer loose accessories

These are expected results of decluttering.
`;

const STAGE1B_LIGHT_DECLUTTER_FURNITURE_RULE_BLOCK = `
─────────────────────────────
FURNITURE RULE — LIGHT DECLUTTER
─────────────────────────────
Large primary furniture (sofas, beds, dining tables, cabinets, desks) should normally remain.

If a large primary furniture item is missing in AFTER:
→ category: furniture_change
→ hardFail: false (warning), not structure fail

Only mark hardFail true if a built-in or structural anchor is removed.
`;

const STAGE1B_STRUCTURED_RETAIN_CONTEXT_BLOCK = `
─────────────────────────────
STAGE CONTEXT — STRUCTURED RETAIN DECLUTTER
─────────────────────────────
The BEFORE image is the original furnished room.
The AFTER image is a structured-retain decluttered version.

This edit removes clutter and secondary/non-core items while retaining
primary anchor furniture and layout structure.

Empty-room output is NOT expected.
`;

const STAGE1B_STRUCTURED_RETAIN_ALLOWED_DIFFERENCES_BLOCK = `
─────────────────────────────
ALLOWED DIFFERENCES — STRUCTURED RETAIN
─────────────────────────────
Do NOT flag the following as structural violations:

• removed clutter and loose decor
• removed wall art and accessories
• removed secondary seating or small movable furniture
• reduced non-core movable objects
• decor removal
• accessory cleanup

These are expected results of structured retain decluttering.
`;

const STAGE1B_STRUCTURED_RETAIN_STRUCTURAL_SIGNAL_RULE_BLOCK = `
─────────────────────────────
STRUCTURAL SIGNAL RULE — WHAT COUNTS AS STRUCTURE
─────────────────────────────
Judge structure ONLY by:

• wall positions
• door and window openings
• built-in cabinetry and islands
• plumbing fixtures
• fixed lighting
• HVAC units and vents
• camera perspective and framing

Do NOT judge structure using:

• shadows
• furniture outlines
• decor presence
• floor shading differences
• contact marks
`;

const STAGE1B_STRUCTURED_RETAIN_SUBTRACTIVE_ENVELOPE_LOCK_BLOCK = `
─────────────────────────────
STAGE 1B CORE PRINCIPLE — SUBTRACTIVE ONLY
─────────────────────────────
Stage 1B structured retain is strictly subtractive.

It may remove clutter and secondary furniture.

It must NEVER:
• regenerate the room
• alter architectural geometry
• change camera position
• change room proportions
• replace walls
• replace windows
• alter envelope scale

If the room envelope appears materially different, this is structural failure.

─────────────────────────────
GLOBAL ENVELOPE LOCK — CRITICAL
─────────────────────────────
The architectural shell must remain visually identical between BEFORE and AFTER.

The following must match:
• wall positions and angles
• corner locations
• ceiling height and geometry
• floor boundaries and depth perspective
• window-to-wall ratio
• door-to-wall ratio
• room depth perception
• camera position and field of view

If AFTER appears to depict different room geometry, wall spacing,
window proportion, or camera viewpoint:
→ category: structure
→ violationType: wall_change OR camera_shift
→ hardFail: true

Even if openings still exist, geometry must match BEFORE.

─────────────────────────────
ZERO-TOLERANCE GEOMETRY RULE
─────────────────────────────
For Stage 1B structured retain, material envelope drift is structural drift.

Low structural similarity is sufficient to escalate structural investigation.
If visual envelope similarity is low, err toward structural violation.
`;

const STAGE1B_STRUCTURED_RETAIN_OPENING_CAMERA_LOCK_BLOCK = `
─────────────────────────────
OPENINGS LOCK
─────────────────────────────
Windows and doors must:
• exist in identical positions
• maintain identical proportions
• maintain identical relative wall placement

Even if not removed, if proportion relative to wall changes,
this is structural drift.

─────────────────────────────
CAMERA LOCK
─────────────────────────────
Camera viewpoint must remain consistent.

The following indicate camera shift:
• vanishing point change
• room appears wider or narrower
• perspective depth changes
• window framing differs significantly
• wall convergence differs

Minor micro-straightening is acceptable.
Material viewpoint shift is not.
`;

const STAGE1B_STRUCTURED_RETAIN_ALLOWED_DIFFERENCES_STRICT_BLOCK = `
─────────────────────────────
ALLOWED DIFFERENCES (ONLY)
─────────────────────────────
Only the following are allowed:
• removal of clutter
• removal of wall art
• removal of secondary movable furniture
• removal of decor
• minor surface exposure from object removal

Declutter must not alter geometry.
`;

const STAGE1B_STRUCTURED_RETAIN_FAILURE_CONDITIONS_BLOCK = `
─────────────────────────────
FAILURE CONDITIONS (ANY = HARD FAIL)
─────────────────────────────
• architectural envelope appears different
• wall boundary shifts
• room proportions differ
• window-to-wall ratio differs
• ceiling geometry differs
• camera perspective shifts materially
• structural edges do not align

Return:
category: structure
hardFail: true
`;

const STAGE1B_STRUCTURED_RETAIN_NUMERIC_SIGNAL_ENFORCEMENT_BLOCK = `
─────────────────────────────
NUMERIC SIGNAL INTERPRETATION — STAGE 1B
─────────────────────────────
Low structural IoU OR
low edge alignment OR
low spatial similarity

→ increases likelihood of structural drift.

Do NOT downgrade these to advisory in Stage 1B structured retain.
Investigate visually and fail if geometry differs.
`;

const STAGE1B_OPENING_HALLUCINATION_RULE_BLOCK = `
─────────────────────────────
NEW OPENING HALLUCINATION RULE (HARD FAIL)
─────────────────────────────
If any doorway, window, pass-through, or opening appears in AFTER
that was NOT clearly visible in BEFORE, this is structural hallucination.

→ category: structure
→ violationType: opening_change
→ hardFail: true

This includes newly invented openings in wall regions that were previously
plain wall or ambiguous due to reconstruction.
`;

const STAGE1B_PARTIAL_FRAME_COMPLETION_RULE_BLOCK = `
─────────────────────────────
PARTIAL FRAME COMPLETION RULE (HARD FAIL)
─────────────────────────────
Do NOT allow inferred completion of partially visible openings.

Hard fail if AFTER shows completed or extended opening geometry that is not
clearly supported by BEFORE, including:
• completed door frames from partial edges
• extended jambs
• inferred lintels/headers
• completed recess depth or alcove geometry

If frame geometry is completed beyond visible evidence:
→ category: structure
→ violationType: opening_change
→ hardFail: true
`;

const STAGE1B_STRUCTURED_RETAIN_FURNITURE_RULE_BLOCK = `
─────────────────────────────
FURNITURE RULE — STRUCTURED RETAIN
─────────────────────────────
Primary anchor furniture is expected to remain.

Preserved anchors must NOT be treated as violations.

Secondary furniture and non-core movable items are expected to be reduced/removed.

If a primary anchor appears missing, classify as furniture_change (warning) unless
clear structural/built-in alteration is also present.

Missing secondary movable items should not trigger structural failure.

If remaining furniture is boundary-adjacent (window frame, sliding door,
visible seam, or partially occluded by a structural boundary), classify as
furniture_change advisory when structure is intact.

Do not hard-fail boundary-adjacent preserved items unless there is clear
opening, wall, or camera structural violation.

Only built-in or structural element removal may trigger hardFail true.
`;

export function buildStage1BLightDeclutterValidatorPrompt(_options: {
  scene?: string;
} = {}): string {
  return `You are a Structural Integrity & Edit Compliance Auditor for NZ real estate imagery — Stage 1B Light Declutter.

Compare BEFORE and AFTER images.

Return JSON only. No prose outside JSON.

${STAGE1B_LIGHT_DECLUTTER_CONTEXT_BLOCK}

${STAGE1B_LIGHT_DECLUTTER_ALLOWED_DIFFERENCES_BLOCK}

─────────────────────────────
STRUCTURAL PRIORITY HIERARCHY
─────────────────────────────
Priority order:

1. Structural anchors and built-ins
2. Openings and access
3. Floors, walls, ceilings
4. Fixed fixtures and lighting
5. Camera and perspective
6. Furniture and decor

Higher priority always overrides lower.

─────────────────────────────
PERSPECTIVE & VISIBILITY TOLERANCE — OPENINGS
─────────────────────────────
Do not classify a window or opening as structurally modified if the
difference is caused by:
• Perspective correction
• Vertical line straightening
• Minor camera geometry normalization
• Small crop or framing shift
• Slightly increased or decreased visible window area

These are considered camera or lens corrections, not architectural changes.

Only flag a structural violation if the window or opening itself has been:
✗ Moved to a new wall position
✗ Removed entirely
✗ Newly created
✗ Shape changed
✗ Proportionally resized relative to wall structure

A change in how much of the window is visible is NOT a structural modification.

${STAGE1B_OPENING_HALLUCINATION_RULE_BLOCK}

${STAGE1B_PARTIAL_FRAME_COMPLETION_RULE_BLOCK}

─────────────────────────────
ANCHOR RELOCATION RULE
─────────────────────────────
If a structural anchor (kitchen island, counter run, built-in wardrobe,
vanity, fixed cabinetry) appears in a DIFFERENT POSITION in the AFTER
image compared to the BEFORE image:

→ This is RELOCATION, not declutter.
→ category: structure, hardFail: true

Anchors are physically fixed to the building. They cannot move.
Any positional shift — even if the element looks identical — is a failure.

─────────────────────────────
BUILT-IN vs MOVABLE DISAMBIGUATION (STRICT)
─────────────────────────────
Only classify an object as BUILT-IN if it meets at least TWO physical criteria.

BUILT-IN OBJECT = MUST meet >= 2:
• Physically continuous with wall surface
• No visible rear gap
• No visible legs or movable base
• Extends from floor to wall or wall to ceiling
• Shares material + finish with wall cabinetry
• Enclosed in recess or alcove
• Part of a continuous cabinetry run
• Cannot be moved without tools or demolition

MOVABLE OBJECT = ANY object with:
• Legs
• Visible rear gap
• Shadow gap behind
• Separate base
• Freestanding footprint
• Visible floor clearance

Set builtInDetected = true only if structuralAnchorCount >= 2.
structuralAnchorCount = number of built-in criteria matched.
Only block for built-in violations when builtInDetected == true AND structuralAnchorCount >= 2.

Desk + shelving units with legs or visible floor clearance MUST be treated as movable furniture — not built-in — even if positioned against a wall.

If uncertain, treat as MOVABLE (do NOT elevate to built-in without evidence).

─────────────────────────────
STRUCTURAL BUILT-IN CLASSIFICATION — STRICT DEFINITION
─────────────────────────────
Only classify an object as a structural built-in if it is permanently
integrated into the architecture and would require construction work to remove.

TRUE structural built-ins include:
• Kitchen cabinetry fixed to walls
• Kitchen counters and islands
• Bathroom vanities connected to plumbing
• Recessed built-in wardrobes
• Fixed wall cabinetry
• Fireplaces
• Staircases
• Permanently installed window seating
• Architectural millwork fixed into walls

The following are NOT structural built-ins and must NOT trigger
structural violation failures:
✗ Desks
✗ Freestanding shelving units
✗ Bookcases
✗ Dressers
✗ Tallboys
✗ Sideboards
✗ Staging wardrobes
✗ Modular storage systems
✗ Removable shelving
✗ Office furniture
✗ Nightstands
✗ Staging cabinets

Desks and shelving units must be treated as movable furniture unless
clearly recessed into wall structure.

Never classify freestanding desks or shelving as structural built-ins.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered, replaced, restyled, recolored, resized, or removed:
- Walls, ceilings, floors, baseboards
- Windows, doors, frames, sliding tracks
- Built-in cabinetry, wardrobes, shelving
- Kitchen islands, counters, vanities, splashbacks
- Fixed lighting (pendants, downlights, sconces)
- Heat pumps, vents, radiators
- Plumbing fixtures
- Exterior views through windows

ANY violation → category: structure, hardFail: true

─────────────────────────────
CRITICAL CHECKLIST
─────────────────────────────
STRUCTURAL FUNCTION ANCHOR CHECK (CRITICAL)
If any of the following appear in BEFORE image, they MUST remain unchanged:
• Kitchen islands and counters
• Built-in cabinets and wardrobes
• Bathroom fixtures
• Heat pumps and vents
• Pendant lights and fixed lighting
• Curtain rails, rods, tracks, blind systems (NOT fabric)
• Fireplaces
• Staircases
• Built-in shelving

Removed, replaced, relocated, or altered → structure hardFail true

🪟 WINDOW COVERING STRUCTURE RULE (REVISED)

Window covering STRUCTURE = rails, rods, tracks, blind housings.

HARD FAIL (structure):
• Blind systems added where none existed
• Blind systems removed
• Curtain rails or tracks added where none existed
• Curtain rails or tracks removed

WARNING ONLY (style_only — NOT hardFail):
• Curtain fabric changed but rail already existed
• Curtains added to an EXISTING rail
• Curtain color or material changed

Curtain fabric is decor.
Rails/tracks/blind systems are structure.

FLOOR COLOR/MATERIAL LOCK
• Floor material AND color must match
• Carpet color must match
• No floor recoloring allowed

Any violation → structure hardFail true

${STAGE1B_LIGHT_DECLUTTER_FURNITURE_RULE_BLOCK}

─────────────────────────────
NUMERIC DRIFT ADVISORY
─────────────────────────────
SSIM failure alone is NOT structural.
Edge IoU failure alone is NOT structural.
Angle deviation alone is NOT structural.

These signals are advisory unless accompanied by:
• opening count change
• anchor removal/addition
• built-in joinery change
• window/door relocation

─────────────────────────────
CATEGORIES
─────────────────────────────
- structure (HARD FAIL)
- opening_blocked (HARD FAIL)
- furniture_change (warning for large furniture removal)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

BUILT-IN DOWNGRADE RULE:
If builtInDetected == true AND (structuralAnchorCount < 2 OR confidence < 0.85)
→ hardFail = false (warning only)

VIOLATION TYPE (REQUIRED)
Choose exactly one:
- opening_change = window/door/opening added/removed/moved
- wall_change = wall added/removed/shifted
- camera_shift = viewpoint or perspective changed
- built_in_moved = built-in cabinetry or anchored fixture changed
- layout_only = furniture/layout/staging only
- other = none of the above

─────────────────────────────
OUTPUT JSON
─────────────────────────────
Return JSON only. Include builtInDetected and structuralAnchorCount.
structuralAnchorCount = number of built-in criteria matched (0-8).
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": [string],
  "confidence": number,
  "violationType": "opening_change"|"wall_change"|"camera_shift"|"built_in_moved"|"layout_only"|"other",
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}`;
}

export function buildStage1BStructuredRetainValidatorPrompt(_options: {
  scene?: string;
} = {}): string {
  return `You are a Structural Integrity & Edit Compliance Auditor for NZ real estate imagery — Stage 1B Structured Retain Declutter.

Compare BEFORE and AFTER images.

Return JSON only. No prose outside JSON.

${STAGE1B_STRUCTURED_RETAIN_CONTEXT_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_ALLOWED_DIFFERENCES_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_STRUCTURAL_SIGNAL_RULE_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_SUBTRACTIVE_ENVELOPE_LOCK_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_OPENING_CAMERA_LOCK_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_ALLOWED_DIFFERENCES_STRICT_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_FAILURE_CONDITIONS_BLOCK}

${STAGE1B_OPENING_HALLUCINATION_RULE_BLOCK}

${STAGE1B_PARTIAL_FRAME_COMPLETION_RULE_BLOCK}

─────────────────────────────
STRUCTURAL PRIORITY HIERARCHY
─────────────────────────────
Priority order:

1. Structural anchors and built-ins
2. Openings and access
3. Floors, walls, ceilings
4. Fixed fixtures and lighting
5. Camera and perspective
6. Furniture and decor

Higher priority always overrides lower.

─────────────────────────────
ANCHOR RELOCATION RULE
─────────────────────────────
If a structural anchor (kitchen island, counter run, built-in wardrobe,
vanity, fixed cabinetry) appears in a DIFFERENT POSITION in the AFTER
image compared to the BEFORE image:

→ This is RELOCATION, not declutter.
→ category: structure, hardFail: true

Anchors are physically fixed to the building. They cannot move.
Any positional shift — even if the element looks identical — is a failure.

─────────────────────────────
BUILT-IN vs MOVABLE DISAMBIGUATION (STRICT)
─────────────────────────────
Only classify an object as BUILT-IN if it meets at least TWO physical criteria.

BUILT-IN OBJECT = MUST meet >= 2:
• Physically continuous with wall surface
• No visible rear gap
• No visible legs or movable base
• Extends from floor to wall or wall to ceiling
• Shares material + finish with wall cabinetry
• Enclosed in recess or alcove
• Part of a continuous cabinetry run
• Cannot be moved without tools or demolition

MOVABLE OBJECT = ANY object with:
• Legs
• Visible rear gap
• Shadow gap behind
• Separate base
• Freestanding footprint
• Visible floor clearance

Set builtInDetected = true only if structuralAnchorCount >= 2.
structuralAnchorCount = number of built-in criteria matched.
Only block for built-in violations when builtInDetected == true AND structuralAnchorCount >= 2.

Desk + shelving units with legs or visible floor clearance MUST be treated as movable furniture — not built-in — even if positioned against a wall.

If uncertain, treat as MOVABLE (do NOT elevate to built-in without evidence).

─────────────────────────────
STRUCTURAL BUILT-IN CLASSIFICATION — STRICT DEFINITION
─────────────────────────────
Only classify an object as a structural built-in if it is permanently
integrated into the architecture and would require construction work to remove.

TRUE structural built-ins include:
• Kitchen cabinetry fixed to walls
• Kitchen counters and islands
• Bathroom vanities connected to plumbing
• Recessed built-in wardrobes
• Fixed wall cabinetry
• Fireplaces
• Staircases
• Permanently installed window seating
• Architectural millwork fixed into walls

The following are NOT structural built-ins and must NOT trigger
structural violation failures:
✗ Desks
✗ Freestanding shelving units
✗ Bookcases
✗ Dressers
✗ Tallboys
✗ Sideboards
✗ Staging wardrobes
✗ Modular storage systems
✗ Removable shelving
✗ Office furniture
✗ Nightstands
✗ Staging cabinets

Desks and shelving units must be treated as movable furniture unless
clearly recessed into wall structure.

Never classify freestanding desks or shelving as structural built-ins.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered, replaced, restyled, recolored, resized, or removed:
- Walls, ceilings, floors, baseboards
- Windows, doors, frames, sliding tracks
- Built-in cabinetry, wardrobes, shelving
- Kitchen islands, counters, vanities, splashbacks
- Fixed lighting (pendants, downlights, sconces)
- Heat pumps, vents, radiators
- Plumbing fixtures
- Exterior views through windows

ANY violation → category: structure, hardFail: true

─────────────────────────────
CRITICAL CHECKLIST
─────────────────────────────
STRUCTURAL FUNCTION ANCHOR CHECK (CRITICAL)
If any of the following appear in BEFORE image, they MUST remain unchanged:
• Kitchen islands and counters
• Built-in cabinets and wardrobes
• Bathroom fixtures
• Heat pumps and vents
• Pendant lights and fixed lighting
• Curtain rails, rods, tracks, blind systems (NOT fabric)
• Fireplaces
• Staircases
• Built-in shelving

Removed, replaced, relocated, or altered → structure hardFail true

🪟 WINDOW COVERING STRUCTURE RULE (REVISED)

Window covering STRUCTURE = rails, rods, tracks, blind housings.

HARD FAIL (structure):
• Blind systems added where none existed
• Blind systems removed
• Curtain rails or tracks added where none existed
• Curtain rails or tracks removed

WARNING ONLY (style_only — NOT hardFail):
• Curtain fabric changed but rail already existed
• Curtains added to an EXISTING rail
• Curtain color or material changed

Curtain fabric is decor.
Rails/tracks/blind systems are structure.

FLOOR COLOR/MATERIAL LOCK
• Floor material AND color must match
• Carpet color must match
• No floor recoloring allowed

Any violation → structure hardFail true

${STAGE1B_STRUCTURED_RETAIN_FURNITURE_RULE_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_NUMERIC_SIGNAL_ENFORCEMENT_BLOCK}

─────────────────────────────
CATEGORIES
─────────────────────────────
- structure (HARD FAIL)
- opening_blocked (HARD FAIL)
- furniture_change (warning for large furniture removal)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

BUILT-IN DOWNGRADE RULE:
If builtInDetected == true AND (structuralAnchorCount < 2 OR confidence < 0.85)
→ hardFail = false (warning only)

VIOLATION TYPE (REQUIRED)
Choose exactly one:
- opening_change = window/door/opening added/removed/moved
- wall_change = wall added/removed/shifted
- camera_shift = viewpoint or perspective changed
- built_in_moved = built-in cabinetry or anchored fixture changed
- layout_only = furniture/layout/staging only
- other = none of the above

─────────────────────────────
OUTPUT JSON
─────────────────────────────
Return JSON only. Include builtInDetected and structuralAnchorCount.
structuralAnchorCount = number of built-in criteria matched (0-8).
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": [string],
  "confidence": number,
  "violationType": "opening_change"|"wall_change"|"camera_shift"|"built_in_moved"|"layout_only"|"other",
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}`;
}

function buildPrompt(
  stage: "1A" | "1B" | "2",
  scene?: string,
  sourceStage?: "1A" | "1B-light" | "1B-stage-ready",
  validationMode?: Stage2ValidationMode,
  stage1BValidationMode?: Stage1BValidationMode
) {
  if (stage === "1B") {
    if (stage1BValidationMode === "STRUCTURED_RETAIN") {
      return buildStage1BStructuredRetainValidatorPrompt({ scene });
    }
    return buildStage1BLightDeclutterValidatorPrompt({ scene });
  }

  if (stage === "2") {
    const resolvedValidationMode: Stage2ValidationMode =
      validationMode ?? (sourceStage === "1A" ? "FULL_STAGE_ONLY" : "REFRESH_OR_DIRECT");
    const contextHeader = buildStage2ContextHeader(resolvedValidationMode);
    const validatorPrompt = resolvedValidationMode === "FULL_STAGE_ONLY"
      ? validateStage2Full()
      : validateStage2Refresh();

    return `${contextHeader}\n\n${validatorPrompt}`;
  }

  const stageLabel = stage === "1A" ? "Stage 1A (color/cleanup)" : stage;
  const sceneLabel = scene === "exterior" ? "EXTERIOR" : "INTERIOR";

  return `You are a Structural Integrity Auditor for New Zealand real estate imagery.

You will receive two images:
- BEFORE (original image)
- AFTER (processed / staged image)

Your sole task is to determine whether the AFTER image violates structural or functional integrity when compared to the BEFORE image.

Return JSON only. Do NOT include any prose outside JSON.

────────────────────────────────
DECISION PRIORITY HIERARCHY
────────────────────────────────
When evaluating the AFTER image, apply rules in this strict order:

1. STRUCTURAL ANCHORS — Kitchen islands, counter runs, built-in cabinetry,
   plumbing fixtures, HVAC, fixed lighting. If ANY anchor is removed,
   relocated, resized, reshaped, or replaced → structure, hardFail: true.
   This takes ABSOLUTE PRIORITY over all other rules.

2. OPENINGS & ACCESS — Doors, windows, pass-throughs must remain functional.
   Blocked or sealed → opening_blocked, hardFail: true.

3. MATERIAL & SURFACE — Floors, walls, ceilings must retain original
   material, color, and finish. Changes → structure, hardFail: true.

4. CURTAIN & FLOOR LOCK — Window coverings and floor color/material must
   match the BEFORE image exactly. Changes → structure, hardFail: true.

5. STAGING / FURNITURE — Furniture placement, style, and completeness.
   Furniture rules may NEVER override rules 1–4 above.

If a lower-priority rule conflicts with a higher-priority rule,
the higher-priority rule ALWAYS wins.

────────────────────────────────
PERSPECTIVE & VISIBILITY TOLERANCE — OPENINGS
────────────────────────────────
Do not classify a window or opening as structurally modified if the
difference is caused by:
• Perspective correction
• Vertical line straightening
• Minor camera geometry normalization
• Small crop or framing shift
• Slightly increased or decreased visible window area

These are considered camera or lens corrections, not architectural changes.

Only flag a structural violation if the window or opening itself has been:
✗ Moved to a new wall position
✗ Removed entirely
✗ Newly created
✗ Shape changed
✗ Proportionally resized relative to wall structure

A change in how much of the window is visible is NOT a structural modification.

────────────────────────────────
ANCHOR RELOCATION RULE
────────────────────────────────
If a structural anchor (kitchen island, counter run, built-in wardrobe,
vanity, fixed cabinetry) appears in a DIFFERENT POSITION in the AFTER
image compared to the BEFORE image:

→ This is RELOCATION, not staging.
→ category: structure, hardFail: true

Anchors are physically fixed to the building. They cannot move.
Any positional shift — even if the element looks identical — is a failure.

────────────────────────────────
BUILT-IN vs MOVABLE DISAMBIGUATION (STRICT)
────────────────────────────────
Only classify an object as BUILT-IN if it meets at least TWO physical criteria.

BUILT-IN OBJECT = MUST meet >= 2:
• Physically continuous with wall surface
• No visible rear gap
• No visible legs or movable base
• Extends from floor to wall or wall to ceiling
• Shares material + finish with wall cabinetry
• Enclosed in recess or alcove
• Part of a continuous cabinetry run
• Cannot be moved without tools or demolition

MOVABLE OBJECT = ANY object with:
• Legs
• Visible rear gap
• Shadow gap behind
• Separate base
• Freestanding footprint
• Visible floor clearance

Set builtInDetected = true only if structuralAnchorCount >= 2.
structuralAnchorCount = number of built-in criteria matched.
Only block for built-in violations when builtInDetected == true AND structuralAnchorCount >= 2.

Desk + shelving units with legs or visible floor clearance MUST be treated as movable furniture — not built-in — even if positioned against a wall.

If uncertain, treat as MOVABLE (do NOT elevate to built-in without evidence).

────────────────────────────────
STRUCTURAL BUILT-IN CLASSIFICATION — STRICT DEFINITION
────────────────────────────────
Only classify an object as a structural built-in if it is permanently
integrated into the architecture and would require construction work to remove.

TRUE structural built-ins include:
• Kitchen cabinetry fixed to walls
• Kitchen counters and islands
• Bathroom vanities connected to plumbing
• Recessed built-in wardrobes
• Fixed wall cabinetry
• Fireplaces
• Staircases
• Permanently installed window seating
• Architectural millwork fixed into walls

The following are NOT structural built-ins and must NOT trigger
structural violation failures:
✗ Desks
✗ Freestanding shelving units
✗ Bookcases
✗ Dressers
✗ Tallboys
✗ Sideboards
✗ Staging wardrobes
✗ Modular storage systems
✗ Removable shelving
✗ Office furniture
✗ Nightstands
✗ Staging cabinets

Desks and shelving units must be treated as movable furniture unless
clearly recessed into wall structure.

Never classify freestanding desks or shelving as structural built-ins.

────────────────────────────────
STAGING CONTEXT OVERRIDE RULE
────────────────────────────────
If furniture appears newly added, replaced, refreshed, or staged as part
of the enhancement process, it must be treated as movable staging furniture
— not as a structural built-in — even if it visually aligns with walls.

Staged furniture must not trigger structural violation blocks.

────────────────────────────────
CORE PRINCIPLE
────────────────────────────────

You must verify that FIXED ARCHITECTURE in the AFTER image remains
geometrically, materially, and functionally identical to the BEFORE image.

Movable furniture and décor may change unless they block access or appear permanently fixed.

────────────────────────────────
PHASE 1: GEOMETRIC & COUNT VERIFICATION (CRITICAL)
────────────────────────────────

1. OPENING COUNT
Count all windows, doors, and pass-through openings in BOTH images.

If the number of openings changes (added or removed):
→ category = structure
→ hardFail = true

2. EDGE & GEOMETRIC ALIGNMENT
Check fixed vertical and horizontal edges:
- Walls
- Door frames
- Window frames
- Major openings

If edges are shifted, resized, warped, slanted, or spatially moved:
→ category = structure
→ hardFail = true

Minor lens correction or perspective straightening is acceptable.

3. MATERIAL CONSISTENCY
Check fixed finishes:
- Floors
- Walls
- Ceilings

If a fixed material changes (e.g., carpet → timber, painted wall removed):
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 2: FUNCTIONAL ACCESS & BLOCKAGE (CRITICAL)
────────────────────────────────

DOORS:
- Must remain realistically passable
- Furniture must not barricade doorways
- Swinging doors must appear able to open
- Sliding doors must retain a usable sliding path

If a door exists but is not realistically usable:
→ category = opening_blocked
→ hardFail = true

────────────────────────────────
CRITICAL OPENING CONTINUITY LOCK (HARD FAIL)
────────────────────────────────

Any BEFORE opening (door, window, or pass-through) must remain
functionally continuous in AFTER.

If an opening still visually exists but is effectively unusable due to
staging placement, this is a hard failure.

Treat as blocked if ANY of the following are true:

• Door swing path is physically blocked by furniture
• Sliding door travel path is blocked by furniture
• Door threshold/circulation path is fully obstructed
• Opening is visually sealed or converted into non-openable surface
• Furniture placement makes real-world passage clearly impossible

Classify as:
→ category = opening_blocked
→ hardFail = true

Do NOT classify these cases as furniture_change.

Minor proximity without functional obstruction is NOT a violation.
Perspective compression alone is NOT a violation.

WINDOWS:
- Partial visual occlusion by movable furniture is acceptable
- The window must still clearly exist as a window
- Objects must NOT appear permanently fixed to window panes or frames

If a window is fully sealed, replaced, or functionally removed:
→ category = structure OR opening_blocked
→ hardFail = true

────────────────────────────────
PHASE 3: IMPROPER FIXATION (ALWAYS FAILURE)
────────────────────────────────

Treat as STRUCTURAL FAILURE if any movable item appears:
- Permanently attached to a wall, window, door, or opening
- Used to cover, replace, or seal a structural element

Examples (non-exhaustive):
- Artwork or mirrors mounted over doors or windows
- Objects visually replacing glazing
- Panels fixed across openings

If improper fixation is detected:
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 4: STRUCTURAL ANCHORS (HIGH-RISK ELEMENTS)
────────────────────────────────

The following elements must be treated as FIXED unless clearly movable:
- Window coverings defining openness (curtains, blinds, rods, tracks)
- Built-in wardrobes or shelving
- Heat pumps / wall-mounted HVAC units
- Fixed lighting and wall-mounted fixtures

If these are removed, relocated, or materially altered:
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 5: FALSE POSITIVE FILTER
────────────────────────────────

DO NOT flag the following as failures:
- Exposure, brightness, colour, or white balance changes
- Virtual staging furniture changes alone
- Minor perspective correction
- Partial visual occlusion by movable furniture that does not block access

────────────────────────────────
CATEGORIES (SELECT ONE)
────────────────────────────────

structure:
- Fixed architecture changed, resized, added, removed, warped
- Openings added/removed
- Structural anchors altered
- Room geometry or proportions manipulated

opening_blocked:
- Doors or windows exist but are functionally unusable
- Circulation paths fully blocked

furniture_change:
- Movable furniture or décor added, removed, or repositioned only

style_only:
- Lighting, exposure, or colour changes only

unknown:
- Insufficient information to decide confidently

────────────────────────────────
CATEGORY PRIORITY
────────────────────────────────

1. structure
2. opening_blocked
3. furniture_change
4. style_only
5. unknown

If fixation or loss of function is involved:
→ NEVER downgrade to furniture_change

────────────────────────────────
DECISION RULES
────────────────────────────────

structure → hardFail = true  
opening_blocked → hardFail = true  
furniture_change → hardFail = false  
style_only → hardFail = false  
If confidence < ${MIN_CONFIDENCE} → hardFail = false  
If builtInDetected == true AND (structuralAnchorCount < 2 OR confidence < 0.85) → hardFail = false  

VIOLATION TYPE (REQUIRED)
Choose exactly one:
- opening_change = window/door/opening added/removed/moved
- wall_change = wall added/removed/shifted
- camera_shift = viewpoint or perspective changed
- built_in_moved = built-in cabinetry or anchored fixture changed
- layout_only = furniture/layout/staging only
- other = none of the above

────────────────────────────────
OUTPUT FORMAT (JSON ONLY)
────────────────────────────────
Return JSON only. Include builtInDetected and structuralAnchorCount.
structuralAnchorCount = number of built-in criteria matched (0-8).
{
  "hardFail": boolean,
  "category": "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown",
  "reasons": [
    "Concise, specific reasons such as 'Window count changed from 2 to 1'",
    "or 'Doorway blocked by fixed wardrobe'"
  ],
  "confidence": number,
  "violationType": "opening_change"|"wall_change"|"camera_shift"|"built_in_moved"|"layout_only"|"other",
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}

Stage: ${stageLabel}
Scene: ${sceneLabel}`;
}

export function parseGeminiSemanticText(text: string): GeminiSemanticVerdict {
  const fallback: GeminiSemanticVerdict = {
    hardFail: false,
    category: "unknown",
    reasons: [],
    confidence: 0,
    violationType: "other",
    builtInDetected: false,
    structuralAnchorCount: 0,
    rawText: text,
  };

  if (!text) return fallback;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const target = jsonMatch ? jsonMatch[0] : text;

  try {
    const parsed = JSON.parse(target);
    const hasDeterministicOpeningSchema =
      typeof parsed?.openingRemoved === "boolean" &&
      typeof parsed?.openingRelocated === "boolean" &&
      typeof parsed?.openingInfilled === "boolean";

    if (hasDeterministicOpeningSchema) {
      const openingRemoved = parsed.openingRemoved === true;
      const openingRelocated = parsed.openingRelocated === true;
      const openingInfilled = parsed.openingInfilled === true;
      const hardFail = openingRemoved || openingRelocated || openingInfilled;
      const confidence =
        typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0;

      return {
        hardFail,
        category: hardFail ? "structure" : "style_only",
        openingRemoved,
        openingRelocated,
        openingInfilled,
        reasons: hardFail
          ? [
              ...(openingRemoved ? ["openingRemoved=true"] : []),
              ...(openingRelocated ? ["openingRelocated=true"] : []),
              ...(openingInfilled ? ["openingInfilled=true"] : []),
            ]
          : [],
        confidence,
        violationType: hardFail ? "opening_change" : "layout_only",
        builtInDetected: false,
        structuralAnchorCount: 0,
        rawText: text,
      };
    }

    if (typeof parsed.ok === "boolean") {
      const parsedResponse = parsed as {
        ok: boolean;
        confidence?: unknown;
        reason?: unknown;
      };
      const geminiConfidence =
        typeof parsedResponse.confidence === "number" && Number.isFinite(parsedResponse.confidence)
          ? parsedResponse.confidence
          : 0.0;
      const reasonText = typeof parsedResponse.reason === "string"
        ? parsedResponse.reason
        : "";
      const normalizedReason = reasonText.trim();

      return {
        hardFail: !parsedResponse.ok,
        category: parsedResponse.ok ? "style_only" : "structure",
        reasons: normalizedReason ? [normalizedReason] : [],
        confidence: geminiConfidence,
        violationType: parsedResponse.ok ? "layout_only" : "other",
        builtInDetected: false,
        structuralAnchorCount: 0,
        rawText: text,
      };
    }

    const violationType = typeof parsed.violationType === "string"
      ? parsed.violationType.toLowerCase()
      : "other";
    const openingAliasViolationType =
      violationType === "opening_removed" ||
      violationType === "opening_infilled" ||
      violationType === "opening_relocated" ||
      violationType === "door_removed" ||
      violationType === "window_removed" ||
      violationType === "closet_removed";

    const normalizedViolationType = (
      violationType === "opening_change" ||
      violationType === "wall_change" ||
      violationType === "camera_shift" ||
      violationType === "built_in_moved" ||
      violationType === "fixture_change" ||
      violationType === "ceiling_fixture_change" ||
      violationType === "plumbing_change" ||
      violationType === "faucet_change" ||
      violationType === "layout_only" ||
      violationType === "other"
    )
      ? (violationType as GeminiSemanticVerdict["violationType"])
      : openingAliasViolationType
        ? "opening_change"
        : "other";
    return {
      hardFail: Boolean(parsed.hardFail),
      category: parsed.category || "unknown",
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      violationType: normalizedViolationType,
      builtInDetected: Boolean(parsed.builtInDetected),
      structuralAnchorCount: typeof parsed.structuralAnchorCount === "number"
        ? Math.max(0, Math.floor(parsed.structuralAnchorCount))
        : 0,
      rawText: text,
    };
  } catch (err) {
    return fallback;
  }
}

export async function runGeminiSemanticValidator(opts: {
  basePath: string;
  candidatePath: string;
  stage: "1A" | "1B" | "2";
  sceneType?: string;
  sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
  validationMode?: Stage2ValidationMode;
  stage1BValidationMode?: Stage1BValidationMode;
  promptOverride?: string;
  modelOverride?: string;
  evidence?: ValidationEvidence;
  riskLevel?: RiskLevel;
  deterministicStructureJson?: boolean;
}): Promise<GeminiSemanticVerdict> {
  const ai = getGeminiClient();
  const before = toBase64(opts.basePath).data;
  const after = toBase64(opts.candidatePath).data;

  // Build base prompt, then inject evidence signals
  if (opts.stage === "1B") {
    debugInfo("Stage1B validator mode", { mode: opts.stage1BValidationMode || "LIGHT_DECLUTTER" });
  }
  const basePrompt = opts.promptOverride || buildPrompt(opts.stage, opts.sceneType, opts.sourceStage, opts.validationMode, opts.stage1BValidationMode);
  if (opts.stage === "2" && opts.validationMode) {
    debugInfo("Stage2 validator mode", { validationMode: opts.validationMode });
  }
  const prompt = buildAdjudicatorPrompt(basePrompt, opts.evidence, opts.riskLevel);

  // Model routing: LOW risk → fast, MEDIUM/HIGH → strong
  const model = opts.modelOverride || getModelForRisk(opts.riskLevel);

  const contents = [
    { role: "user", parts: [{ text: prompt }] },
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/webp", data: before } },
        { inlineData: { mimeType: "image/webp", data: after } },
      ],
    },
  ];

  try {
    const start = Date.now();
    const deterministicStructureJson = opts.deterministicStructureJson === true;
    const response = await (ai as any).models.generateContent({
      model,
      contents,
      generationConfig: {
        temperature: 0,
        topP: 0,
        maxOutputTokens: 256,
        responseMimeType: deterministicStructureJson ? "application/json" : undefined,
      },
    } as any);

    const textParts = (response as any)?.candidates?.[0]?.content?.parts || [];
    const text = textParts.map((p: any) => p?.text || "").join(" ").trim();
    const parsed = parseGeminiSemanticText(text);
    parsed.rawText = text;

    const lowConfidence = !Number.isFinite(parsed.confidence) || parsed.confidence < MIN_CONFIDENCE;
    let category = parsed.category as GeminiSemanticVerdict["category"];
    const builtInDetected = parsed.builtInDetected === true;
    const structuralAnchorCount = typeof parsed.structuralAnchorCount === "number"
      ? parsed.structuralAnchorCount
      : 0;
    const builtInLowConfidence = builtInDetected && parsed.confidence < BUILTIN_HARDFAIL_CONFIDENCE;
    let violationType: GeminiViolationType = parsed.violationType || "other";
    const builtInDowngradeAllowed = isBuiltInDowngradeAllowed({
      violationType,
      builtInDetected,
      structuralAnchorCount,
      confidence: parsed.confidence,
    });

    const reasonText = (parsed.reasons || []).join(" ").toLowerCase();
    const boundaryAdjacentFurnitureCue = [
      "window frame",
      "sliding door",
      "visible seam",
      "door frame seam",
      "wall seam",
      "boundary",
      "occluded",
      "partially occluded",
      "frame edge",
      "glass panel edge",
    ].some((token) => reasonText.includes(token));
    const alwaysHardFail = violationType === "opening_change" ||
      violationType === "wall_change" ||
      violationType === "camera_shift" ||
      [
        "window count",
        "door count",
        "opening count",
        "new opening",
        "added opening",
        "removed opening",
        "opening removed",
        "opening added",
        "new window",
        "removed window",
        "new door",
        "removed door",
        "camera viewpoint",
        "camera angle",
        "perspective shift",
        "viewpoint shift",
        "wall removed",
        "wall removal",
        "wall added",
        "wall addition",
        "wall deleted",
      ].some((token) => reasonText.includes(token));

    const structuredRetainFurnitureDowngrade =
      opts.stage === "1B" &&
      opts.stage1BValidationMode === "STRUCTURED_RETAIN" &&
      boundaryAdjacentFurnitureCue &&
      (category === "furniture_change" || (category === "structure" && (violationType === "layout_only" || violationType === "other"))) &&
      !alwaysHardFail;

    const isStage2Full = opts.stage === "2" && opts.validationMode === "FULL_STAGE_ONLY";
    const stage2FullPrimaryStructuralIdentityViolation = isStage2Full && hasStage2FullPrimaryStructuralIdentityViolation({
      category,
      violationType,
      reasonText,
    });
    if (stage2FullPrimaryStructuralIdentityViolation) {
      category = "structure";
      violationType = normalizeStage2FullStructuralViolationType({
        rawViolationType: violationType || "other",
        reasonText,
      });
    }

    const windowsDelta = opts.evidence
      ? (opts.evidence.openings.windowsAfter - opts.evidence.openings.windowsBefore)
      : 0;
    const doorsDelta = opts.evidence
      ? (opts.evidence.openings.doorsAfter - opts.evidence.openings.doorsBefore)
      : 0;
    const structuralDeviationDeg = Number(opts.evidence?.drift?.angleDegrees ?? 0);
    const semanticOpeningsDeltaTotal = Math.abs(windowsDelta) + Math.abs(doorsDelta);
    const semanticWallDriftPct = Number(opts.evidence?.drift?.wallPercent ?? 0);
    const topologyResultRaw = (opts.evidence as any)?.topologyResult;
    const topologyResult = typeof topologyResultRaw === "string"
      ? topologyResultRaw.toUpperCase()
      : topologyResultRaw;
    const topologyPass = topologyResult === "PASS" || topologyResult === true;

    if (opts.validationMode === "FULL_STAGE_ONLY" && opts.stage === "2") {
      debugLog("[gemini-structure-guard] topology signal", {
        topologyResult,
        topologyResultRaw,
      });
    }

    const openingIdentityViolationDetected = hasOpeningIdentityViolationSignal(
      violationType,
      reasonText
    );

    const moderateDriftGuardApplies =
      opts.validationMode === "FULL_STAGE_ONLY" &&
      structuralDeviationDeg === 0 &&
      semanticOpeningsDeltaTotal === 0 &&
      topologyPass &&
      semanticWallDriftPct < 35;

    const {
      primaryStructuralViolationDetected,
      hasOpeningChange,
      hasWallGeometryDrift,
      hasCameraShift,
      hasEnvelopeDeformation,
      hasConfirmedBuiltInRelocation,
    } = hasStage2PrimaryStructuralViolation({
      violationType,
      reasonText,
      stage2FullPrimaryStructuralIdentityViolation,
      builtInDetected,
      structuralAnchorCount,
      confidence: parsed.confidence,
    });

    const hasSecondarySignals =
      category === "structure" ||
      violationType === "fixture_change" ||
      violationType === "ceiling_fixture_change" ||
      violationType === "plumbing_change" ||
      violationType === "faucet_change" ||
      reasonText.includes("island_changed") ||
      reasonText.includes("desk") ||
      reasonText.includes("shelving") ||
      reasonText.includes("wall art") ||
      reasonText.includes("decor") ||
      reasonText.includes("bedside") ||
      reasonText.includes("bedding") ||
      reasonText.includes("ssim") ||
      reasonText.includes("masked_edge") ||
      reasonText.includes("wall_drift");
    const onlySecondarySignalsPresent = !primaryStructuralViolationDetected && hasSecondarySignals;

    let hardFail = parsed.hardFail;
    let downgradeApplied = false;
    if (category === "structure") {
      const builtInViolation = violationType === "built_in_moved" || builtInDetected;
      const builtInHardFail = builtInViolation && structuralAnchorCount >= 2 && parsed.confidence >= BUILTIN_HARDFAIL_CONFIDENCE;
      hardFail = opts.stage === "2"
        ? primaryStructuralViolationDetected
        : (alwaysHardFail || builtInHardFail);
    }
    else if (category === "opening_blocked") hardFail = parsed.hardFail;
    else if (category === "furniture_change" || category === "style_only") hardFail = false;

    if (opts.stage === "2" && category === "structure") {
      const geometricViolation =
        hasWallGeometryDrift ||
        hasCameraShift ||
        hasOpeningChange ||
        hasEnvelopeDeformation;
      const builtInStrongEvidence = hasConfirmedBuiltInRelocation;
      if (opts.validationMode === "FULL_STAGE_ONLY") {
        if (geometricViolation) {
          if (openingIdentityViolationDetected) {
            hardFail = true;
            debugLog(`[STRUCTURAL_ENFORCEMENT_APPLIED] stage=2 mode=FULL_STAGE_ONLY opening_identity_lock=true violationType=${violationType}`);
          } else if (moderateDriftGuardApplies) {
            console.log("[gemini-structure-guard] downgraded hardFail to advisory", {
              semanticWallDriftPct,
              structuralDeviationDeg,
              semanticOpeningsDeltaTotal,
              topologyResult,
            });
            hardFail = false;
            downgradeApplied = true;
          } else {
            hardFail = true;
            debugLog(`[STRUCTURAL_ENFORCEMENT_APPLIED] stage=2 mode=FULL_STAGE_ONLY primary_geometry_lock=true violationType=${violationType}`);
          }
        } else if (builtInStrongEvidence) {
          if (moderateDriftGuardApplies) {
            console.log("[gemini-structure-guard] downgraded hardFail to advisory", {
              semanticWallDriftPct,
              structuralDeviationDeg,
              semanticOpeningsDeltaTotal,
              topologyResult,
            });
            hardFail = false;
            downgradeApplied = true;
          } else {
            hardFail = true;
            debugLog(`[STRUCTURAL_ENFORCEMENT_APPLIED] stage=2 mode=FULL_STAGE_ONLY secondary_anchor_lock=true violationType=${violationType}`);
          }
        } else if (onlySecondarySignalsPresent) {
          hardFail = false;
          debugLog("[STRUCTURAL_ENFORCEMENT_APPLIED] stage=2 mode=FULL_STAGE_ONLY secondary_only_advisory=true");
        } else {
          hardFail = false;
        }
      } else {
        if (geometricViolation) {
          hardFail = true;
          debugLog("[STRUCTURAL_ENFORCEMENT_APPLIED] stage=2 cat=structure forcedHardFail=true");
        } else if (builtInStrongEvidence) {
          hardFail = true;
        } else if (onlySecondarySignalsPresent) {
          hardFail = false;
          debugLog("[STRUCTURAL_ENFORCEMENT_APPLIED] stage=2 mode=REFRESH_OR_DIRECT secondary_only_advisory=true");
        } else if (builtInDowngradeAllowed || lowConfidence || builtInLowConfidence) {
          hardFail = false;
        } else {
          hardFail = false;
        }
      }
    } else {
      // Stage 1B geometric lock — wall/camera/opening violations are never downgraded
      const geometricViolation =
        violationType === "wall_change" ||
        violationType === "camera_shift" ||
        violationType === "opening_change";
      if (geometricViolation) {
        hardFail = true;
        debugLog(`[STRUCTURAL_ENFORCEMENT_APPLIED] stage1b_geometric_lock=true violationType=${violationType}`);
      } else {
        // D1: low confidence → allow through
        if (lowConfidence) hardFail = false;
        // D2: built-in ambiguity (too few anchors) → allow through
        if (builtInDetected && structuralAnchorCount < 2) hardFail = false;
        // D3: built-in low confidence → allow through
        if (builtInLowConfidence) hardFail = false;
        // D4: boundary-adjacent furniture (Structured Retain only) → allow through
        if (structuredRetainFurnitureDowngrade) hardFail = false;
      }
    }

    if (stage2FullPrimaryStructuralIdentityViolation) {
      category = "structure";
      if (openingIdentityViolationDetected) {
        hardFail = true;
        debugLog(`[STRUCTURAL_ENFORCEMENT_APPLIED] stage=2 mode=FULL_STAGE_ONLY opening_identity_lock=true violationType=${violationType}`);
      } else if (moderateDriftGuardApplies) {
        console.log("[gemini-structure-guard] downgraded hardFail to advisory", {
          semanticWallDriftPct,
          structuralDeviationDeg,
          semanticOpeningsDeltaTotal,
          topologyResult,
        });
        hardFail = false;
        downgradeApplied = true;
      } else {
        hardFail = true;
        if (violationType === "layout_only") {
          violationType = normalizeStage2FullStructuralViolationType({
            rawViolationType: violationType || "other",
            reasonText,
          });
        }
        debugLog(`[STRUCTURAL_ENFORCEMENT_APPLIED] stage=2 mode=FULL_STAGE_ONLY retry_on_structure_drift=true violationType=${violationType}`);
      }
    }

    const verdict: GeminiSemanticVerdict = {
      hardFail,
      category,
      reasons: parsed.reasons || [],
      confidence: parsed.confidence ?? 0,
      violationType,
      builtInDetected,
      structuralAnchorCount,
      rawText: text,
    };

    if (opts.stage === "2") {
      debugLog(
        `[STRUCTURAL_GEMINI_DECISION] openingViolationDetected=${openingIdentityViolationDetected} hardFail=${verdict.hardFail} downgradeApplied=${downgradeApplied}`
      );
    }

    const ms = Date.now() - start;
    debugLog(`[gemini-semantic] completed in ${ms}ms model=${model} risk=${opts.riskLevel || "N/A"} (hardFail=${verdict.hardFail} conf=${verdict.confidence} cat=${verdict.category})`);
    return verdict;
  } catch (err: any) {
    console.warn("[gemini-semantic] error (fail-open):", err?.message || err);
    return {
      hardFail: false,
      category: "unknown",
      confidence: 0,
      reasons: ["gemini_error"],
      rawText: err?.message,
    };
  }
}

export function buildStage2ContextHeader(mode: Stage2ValidationMode): string {
  if (mode === "FULL_STAGE_ONLY") {
    return `STAGE2 VALIDATION CONTEXT
- Mode: FULL_STAGE_ONLY
- BEFORE is a stage-only baseline (typically empty input from user).
- AFTER should introduce suitable staged furniture while preserving all fixed architecture.`;
  }

  return `STAGE2 VALIDATION CONTEXT
- Mode: REFRESH_OR_DIRECT
- BEFORE is a structured-retain or light-declutter baseline.
- AFTER may augment furniture/decor while preserving fixed architecture and anchor geometry.`;
}
