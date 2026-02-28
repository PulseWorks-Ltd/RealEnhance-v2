import { runGeminiSemanticValidator } from "./geminiSemanticValidator";
import { getGeminiValidatorMode, isGeminiBlockingEnabled } from "./validationModes";
import type { ValidationEvidence, RiskLevel } from "./validationEvidence";
import type { Stage2ValidationMode } from "./stage2ValidationMode";
import { nLog } from "../logger";

type StageKey = "stage1b" | "stage2";

function buildNeutralStage2StructureConfirmPrompt(input: {
  sceneType?: "interior" | "exterior";
  validationMode?: Stage2ValidationMode;
  softStructuralReviewMode?: boolean;
}): string {
  const softReviewBlock = input.softStructuralReviewMode
    ? `

ARCHITECTURAL CONSISTENCY VERIFICATION:

Please carefully verify:

• All windows remain in the same positions and sizes as the input.
• All doors remain fully visible and unobstructed.
• No openings have been narrowed, sealed, or replaced with wall.
• The architectural envelope of the room is unchanged.

If any opening has been materially altered, classify as structural failure.

If geometry appears consistent, ignore minor tonal or exposure differences.

This is advisory, not accusatory.`
    : "";

  return `ROLE — Stage 2 Structural Continuity Confirmation

You are performing a structural continuity verification for Stage 2 output.

Compare BEFORE (Stage 1A baseline) vs AFTER (Stage 2 candidate).

Independently determine whether any window, door, or architectural opening
was removed, sealed, resized, relocated, or structurally altered.

Evaluate visually and semantically.

BUILT-IN STORAGE & FIXED JOINERY LOCK — STOP CONDITION

Before finalizing your decision, inspect the original image for built-in architectural storage or fixed joinery.

These include:
• Sliding mirrored wardrobe doors
• Built-in closets or recessed wardrobes
• Floor-to-ceiling storage panels
• Built-in cabinetry attached to walls
• Recessed storage niches
• Fixed shelving integrated into the wall structure

These elements are part of the architectural identity of the room.

You must verify that:
1) Built-in storage visible in the original remains present in the enhanced image.
2) The wall recess or opening containing it remains intact.
3) It has not been painted over, flattened, sealed, or converted into continuous wall.
4) Furniture has not replaced or structurally blocked it.

If built-in storage has been removed or structurally altered:
- category = "structure"
- hardFail = true

MODE CONTEXT
- Validation Mode: ${input.validationMode || "REFRESH_OR_DIRECT"}
- Scene: ${(input.sceneType || "interior").toUpperCase()}

${softReviewBlock}

DECISION POLICY
- If structural continuity is clearly violated: hardFail=true.
- If structural continuity is clearly preserved: hardFail=false.
- If uncertain/ambiguous: hardFail=true (fail-safe).

Return JSON only:
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
  softStructuralReviewMode?: boolean;
}): Promise<{ confirmedFail: boolean; reasons: string[]; confidence?: number; raw?: any; status: "pass" | "fail" | "error" }> {
  const failOpen = (process.env.GEMINI_CONFIRM_FAIL_OPEN ?? "1") === "1";
  const geminiMode = getGeminiValidatorMode();
  const geminiBlocking = isGeminiBlockingEnabled();
  const reasons: string[] = [];

  try {
    const promptOverride = params.stage === "stage2"
      ? buildNeutralStage2StructureConfirmPrompt({
          sceneType: params.sceneType,
          validationMode: params.validationMode,
          softStructuralReviewMode: params.softStructuralReviewMode,
        })
      : undefined;

    nLog("[VALIDATOR_PROMPT_MODE]", {
      mode: params.validationMode || null,
      localSignalCount: Array.isArray(params.localReasons) ? params.localReasons.length : 0,
      softStructuralReviewMode: params.softStructuralReviewMode === true,
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
      evidence: undefined,
      riskLevel: params.riskLevel,
    });

    const confidence = typeof verdict.confidence === "number" && Number.isFinite(verdict.confidence)
      ? verdict.confidence
      : NaN;
    const uncertain = params.stage === "stage2" && (
      !Number.isFinite(confidence) ||
      verdict.category === "unknown"
    );

    const structuralChanged =
      verdict.hardFail === true ||
      verdict.category === "structure" ||
      verdict.category === "opening_blocked";

    const pass = !structuralChanged && !uncertain;
    if (!pass) {
      if (uncertain) {
        reasons.push("gemini_uncertain_fail_safe");
      }
      reasons.push(...(verdict.reasons || []));
    }

    const confirmedFail = params.stage === "stage2"
      ? !pass
      : (geminiBlocking ? !pass : false);

    if (params.stage !== "stage2" && !geminiBlocking && !pass) {
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
