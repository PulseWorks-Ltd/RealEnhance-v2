import { buildFinalFixtureConfirmPrompt, runGeminiSemanticValidator } from "./geminiSemanticValidator";
import { getGeminiValidatorMode, isGeminiBlockingEnabled } from "./validationModes";
import type { ValidationEvidence, RiskLevel } from "./validationEvidence";
import type { Stage2ValidationMode } from "./stage2ValidationMode";
import { nLog } from "../logger";

type StageKey = "stage1b" | "stage2";

function normalizeLocalFindings(params: {
  localReasons: string[];
  evidence?: ValidationEvidence;
  localMetrics?: any;
}): string[] {
  const findings: string[] = [];

  if (params.evidence) {
    const e = params.evidence;
    const windowsDelta = (e.openings?.windowsAfter ?? 0) - (e.openings?.windowsBefore ?? 0);
    const doorsDelta = (e.openings?.doorsAfter ?? 0) - (e.openings?.doorsBefore ?? 0);
    const openingsDelta = windowsDelta + doorsDelta;
    findings.push(`window_count_delta: ${e.openings.windowsBefore} -> ${e.openings.windowsAfter}`);
    findings.push(`door_count_delta: ${e.openings.doorsBefore} -> ${e.openings.doorsAfter}`);
    findings.push(`openings_delta_total: ${openingsDelta >= 0 ? "+" : ""}${openingsDelta}`);
    findings.push(`wall_drift_pct: ${e.drift.wallPercent.toFixed(2)}%`);
    findings.push(`masked_drift_pct: ${e.drift.maskedEdgePercent.toFixed(2)}%`);
    findings.push(`ssim: ${e.ssim.toFixed(4)} (threshold ${e.ssimThreshold})`);

    if (e.anchorChecks.islandChanged) findings.push("anchor_flag: island_changed");
    if (e.anchorChecks.hvacChanged) findings.push("anchor_flag: hvac_changed");
    if (e.anchorChecks.cabinetryChanged) findings.push("anchor_flag: cabinetry_changed");
    if (e.anchorChecks.lightingChanged) findings.push("anchor_flag: lighting_changed");
  }

  if (params.localMetrics && typeof params.localMetrics === "object") {
    const metrics = params.localMetrics as Record<string, unknown>;
    const metricKeys = ["ssim", "wallDrift", "maskedDrift", "openingsCreated", "openingsClosed", "windowDelta", "doorDelta"];
    for (const key of metricKeys) {
      if (metrics[key] !== undefined && metrics[key] !== null) {
        findings.push(`metric_${key}: ${String(metrics[key])}`);
      }
    }
  }

  findings.push(...(params.localReasons || []).map((r) => String(r)));
  return Array.from(new Set(findings)).slice(0, 40);
}

export async function confirmWithGeminiStructure(params: {
  baselinePathOrUrl: string;
  candidatePathOrUrl: string;
  stage: StageKey;
  roomType?: string;
  sceneType?: "interior" | "exterior";
  jobId?: string;
  localReasons: string[];
  localMetrics?: any;
  sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
  validationMode?: Stage2ValidationMode;
  evidence?: ValidationEvidence;
  riskLevel?: RiskLevel;
}): Promise<{ confirmedFail: boolean; reasons: string[]; confidence?: number; raw?: any; status: "pass" | "fail" | "error" }> {
  const failOpen = (process.env.GEMINI_CONFIRM_FAIL_OPEN ?? "1") === "1";
  const geminiMode = getGeminiValidatorMode();
  const geminiBlocking = isGeminiBlockingEnabled();
  const reasons: string[] = [];

  try {
    const finalFindings = normalizeLocalFindings({
      localReasons: params.localReasons,
      evidence: params.evidence,
      localMetrics: params.localMetrics,
    });

    const promptOverride = params.stage === "stage2"
      ? buildFinalFixtureConfirmPrompt({
          sceneType: params.sceneType,
          localFindings: finalFindings,
          validationMode: params.validationMode,
        })
      : undefined;

    nLog("[VALIDATOR_PROMPT_MODE]", {
      mode: params.validationMode || null,
      localSignalCount: finalFindings.length,
      ssimValue: typeof params.evidence?.ssim === "number"
        ? Number(params.evidence.ssim.toFixed(4))
        : null,
    });

    const verdict = await runGeminiSemanticValidator({
      basePath: params.baselinePathOrUrl,
      candidatePath: params.candidatePathOrUrl,
      stage: params.stage === "stage1b" ? "1B" : "2",
      sceneType: params.sceneType || "interior",
      sourceStage: params.sourceStage,
      validationMode: params.validationMode,
      promptOverride,
      evidence: params.evidence,
      riskLevel: params.riskLevel,
    });

    const pass = !verdict.hardFail;
    if (!pass) {
      reasons.push(...(verdict.reasons || []));
    }

    const confirmedFail = geminiBlocking ? !pass : false;

    if (!geminiBlocking && !pass) {
      reasons.push("gemini_mode=log");
    }

    return {
      confirmedFail,
      reasons,
      confidence: verdict.confidence,
      raw: verdict,
      status: pass ? "pass" : "fail",
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    reasons.push(`gemini_confirm_error: ${msg}`);
    const confirmedFail = geminiBlocking ? !failOpen : false;
    return { confirmedFail, reasons, status: "error" };
  }
}
