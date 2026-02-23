/**
 * Validation Evidence Packet
 *
 * Structured output from all local validators.
 * This is the single source of truth passed to the model adjudicator.
 * Local validators are EVIDENCE GENERATORS, not decision makers.
 */

export interface ValidationEvidence {
  jobId: string;
  stage: "1B" | "2";
  roomType?: string;

  /** Perceptual diff (SSIM) */
  ssim: number;
  ssimThreshold: number;
  ssimPassed: boolean;

  /** Opening counts from semantic structure validator */
  openings: {
    windowsBefore: number;
    windowsAfter: number;
    doorsBefore: number;
    doorsAfter: number;
  };

  /** Drift metrics from local validators */
  drift: {
    wallPercent: number;
    maskedEdgePercent: number;
    /** Angle deviation from line/edge validator (degrees) */
    angleDegrees: number;
  };

  /** Anchor-region binary flags */
  anchorChecks: {
    islandChanged: boolean;
    hvacChanged: boolean;
    cabinetryChanged: boolean;
    lightingChanged: boolean;
  };

  /** Geometry profile detected */
  geometryProfile: "SOFT" | "STRONG";

  /** All flags/reasons from local validators */
  localFlags: string[];

  /** Unified validator aggregate score (0-1) */
  unifiedScore: number;

  /** Whether unified validator passed overall */
  unifiedPassed: boolean;
}

/**
 * Risk level for deterministic routing
 */
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

/**
 * Risk classification result
 */
export interface RiskClassification {
  level: RiskLevel;
  triggers: string[];
}

function isKitchenContext(roomType?: string): boolean {
  return roomType?.toLowerCase().includes("kitchen") ?? false;
}

/**
 * Deterministic Risk Classifier — NO AI, pure code.
 *
 * HIGH RISK triggers:
 * - openings_delta != 0 (windows or doors changed)
 * - any anchor flag true
 * - semantic validator flagged structure
 *
 * MEDIUM RISK triggers:
 * - wall_drift > 35%
 * - masked_edge_drift > 55%
 * - angle_deviation > 25°
 *
 * LOW RISK:
 * - Everything else
 */
export function classifyRisk(evidence: ValidationEvidence): RiskClassification {
  const triggers: string[] = [];
  const kitchenContext = isKitchenContext(evidence.roomType);
  const islandAnchorStructural = evidence.anchorChecks.islandChanged && kitchenContext;
  const islandAnchorAdvisory = evidence.anchorChecks.islandChanged && !kitchenContext;

  // ─── HIGH RISK checks ───
  const windowsDelta = evidence.openings.windowsAfter - evidence.openings.windowsBefore;
  const doorsDelta = evidence.openings.doorsAfter - evidence.openings.doorsBefore;

  const onlyHvacAnchor =
    evidence.anchorChecks.hvacChanged &&
    !islandAnchorStructural &&
    !evidence.anchorChecks.cabinetryChanged &&
    !evidence.anchorChecks.lightingChanged;

  const hasNonHvacStructureFlag = evidence.localFlags.some((flag) => {
    const value = flag.toLowerCase();
    const structural = value.includes("structure") || value.includes("opening") || value.includes("anchor");
    const hvacOnly = value.includes("hvac");
    return structural && !hvacOnly;
  });

  const isolatedHvacSignal =
    onlyHvacAnchor &&
    windowsDelta === 0 &&
    doorsDelta === 0 &&
    !hasNonHvacStructureFlag;

  if (windowsDelta !== 0) {
    triggers.push(`HIGH: windows changed ${evidence.openings.windowsBefore}→${evidence.openings.windowsAfter}`);
  }
  if (doorsDelta !== 0) {
    triggers.push(`HIGH: doors changed ${evidence.openings.doorsBefore}→${evidence.openings.doorsAfter}`);
  }
  const anchorEvidencePresent = islandAnchorStructural ||
    evidence.anchorChecks.hvacChanged ||
    evidence.anchorChecks.cabinetryChanged ||
    evidence.anchorChecks.lightingChanged;
  if (islandAnchorStructural) {
    triggers.push("HIGH: kitchen island anchor changed");
  }
  if (islandAnchorAdvisory) {
    triggers.push("MEDIUM: island anchor signal in non-kitchen context (advisory)");
  }
  if (evidence.anchorChecks.hvacChanged) {
    if (isolatedHvacSignal) {
      triggers.push("MEDIUM: isolated HVAC/heat pump anchor signal (no openings/island/structure deltas)");
    } else {
      triggers.push("HIGH: HVAC/heat pump anchor changed");
    }
  }
  if (evidence.anchorChecks.cabinetryChanged) {
    triggers.push("HIGH: cabinetry anchor changed");
  }
  if (evidence.anchorChecks.lightingChanged) {
    triggers.push("HIGH: fixed lighting anchor changed");
  }

  // Check for structure flag from local validators
  const hasStructureFlag = evidence.localFlags.some(f =>
    f.toLowerCase().includes("structure") ||
    f.toLowerCase().includes("opening") ||
    f.toLowerCase().includes("anchor")
  );
  if (hasStructureFlag) {
    if (anchorEvidencePresent && !isolatedHvacSignal) {
      triggers.push("HIGH: local validator flagged structural issue");
    } else {
      triggers.push("MEDIUM: local validator flagged structural issue (no anchor evidence)");
    }
  }

  const highTriggers = triggers.filter(t => t.startsWith("HIGH:"));
  if (highTriggers.length > 0) {
    return { level: "HIGH", triggers };
  }

  // ─── MEDIUM RISK checks ───
  if (evidence.drift.wallPercent > 35) {
    triggers.push(`MEDIUM: wall_drift ${evidence.drift.wallPercent.toFixed(1)}% > 35%`);
  }
  if (evidence.drift.maskedEdgePercent > 55) {
    triggers.push(`MEDIUM: masked_edge_drift ${evidence.drift.maskedEdgePercent.toFixed(1)}% > 55%`);
  }
  if (evidence.drift.angleDegrees > 25) {
    triggers.push(`MEDIUM: angle_deviation ${evidence.drift.angleDegrees.toFixed(1)}° > 25°`);
  }

  const mediumTriggers = triggers.filter(t => t.startsWith("MEDIUM:"));
  if (mediumTriggers.length > 0) {
    return { level: "MEDIUM", triggers };
  }

  // ─── LOW RISK ───
  return { level: "LOW", triggers: [] };
}

/**
 * Determine whether retries should be triggered based on evidence + model verdict.
 *
 * Deterministic — never rely only on model category.
 *
 * Auto retry if:
 * - Any anchor flag true
 * - openings_delta != 0
 * - Model says "structure"
 *
 * No retry if:
 * - Only style_only
 * - No anchor flags
 * - Risk LOW
 */
export function shouldRetry(
  evidence: ValidationEvidence,
  modelCategory: string,
  riskLevel: RiskLevel
): { retry: boolean; reason: string } {
  const kitchenContext = isKitchenContext(evidence.roomType);
  const islandAnchorStructural = evidence.anchorChecks.islandChanged && kitchenContext;
  // Anchor-based retries
  const anchorChanged = islandAnchorStructural ||
    evidence.anchorChecks.hvacChanged ||
    evidence.anchorChecks.cabinetryChanged ||
    evidence.anchorChecks.lightingChanged;

  if (anchorChanged) {
    return { retry: true, reason: "anchor_changed" };
  }

  // Opening delta retries
  const windowsDelta = evidence.openings.windowsAfter - evidence.openings.windowsBefore;
  const doorsDelta = evidence.openings.doorsAfter - evidence.openings.doorsBefore;

  if (windowsDelta !== 0 || doorsDelta !== 0) {
    return { retry: true, reason: "openings_delta" };
  }

  // Model-based retries
  if (modelCategory === "structure" || modelCategory === "opening_blocked") {
    return { retry: true, reason: `model_${modelCategory}` };
  }

  // No retry for low risk + benign categories
  if (riskLevel === "LOW" && (modelCategory === "style_only" || modelCategory === "furniture_change")) {
    return { retry: false, reason: "low_risk_benign" };
  }

  // Medium risk with benign model — no retry but flag
  if (riskLevel === "MEDIUM" && modelCategory !== "structure") {
    return { retry: false, reason: "medium_risk_model_pass" };
  }

  return { retry: false, reason: "no_trigger" };
}

/**
 * Create empty evidence packet for initialization
 */
export function createEmptyEvidence(jobId: string, stage: "1B" | "2", roomType?: string): ValidationEvidence {
  return {
    jobId,
    stage,
    roomType,
    ssim: 1.0,
    ssimThreshold: stage === "1B" ? 0.9 : 0.97,
    ssimPassed: true,
    openings: {
      windowsBefore: 0,
      windowsAfter: 0,
      doorsBefore: 0,
      doorsAfter: 0,
    },
    drift: {
      wallPercent: 0,
      maskedEdgePercent: 0,
      angleDegrees: 0,
    },
    anchorChecks: {
      islandChanged: false,
      hvacChanged: false,
      cabinetryChanged: false,
      lightingChanged: false,
    },
    geometryProfile: "STRONG",
    localFlags: [],
    unifiedScore: 1.0,
    unifiedPassed: true,
  };
}

export function shouldInjectEvidence(e: ValidationEvidence): boolean {
  if (!e) return false;

  const kitchenContext = isKitchenContext(e.roomType);
  const anchorChecksForInjection = {
    ...e.anchorChecks,
    islandChanged: kitchenContext ? e.anchorChecks.islandChanged : false,
  };

  if (anchorChecksForInjection && Object.values(anchorChecksForInjection).some((v) => v === true)) {
    return true;
  }

  const winDelta =
    (e.openings?.windowsAfter ?? 0) -
    (e.openings?.windowsBefore ?? 0);

  if (Math.abs(winDelta) >= 1) return true;

  if ((e.drift?.wallPercent ?? 0) > 40) return true;
  if ((e.drift?.maskedEdgePercent ?? 0) > 55) return true;

  if ((e.drift?.angleDegrees ?? 0) > 30) return true;

  if ((e.ssim ?? 1) < 0.35) return true;

  return false;
}
