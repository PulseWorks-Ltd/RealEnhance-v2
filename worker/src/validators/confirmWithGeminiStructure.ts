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
- If structural continuity is clearly violated: set one or more violation booleans to true.
- If structural continuity is clearly preserved: set all violation booleans to false.

STRUCTURAL PERMANENCE – AMBIGUITY HANDLING RULE

Architectural openings (windows, doors, closet doors, sliding doors, built-in recesses, wall cutouts) are permanent structural elements.

If an opening visible in the ORIGINAL image is not clearly and geometrically traceable in the OUTPUT image at the same location, it must NOT be treated as safe by default.

Ambiguity MUST NOT be interpreted as preservation.

Occlusion is allowed ONLY if:
- The opening frame edges are partially visible, AND
- The geometric boundary of the opening can still be visually traced, AND
- The wall plane continuity clearly indicates the opening still exists behind foreground objects.

If these conditions are NOT clearly satisfied:

- Treat the opening as structurally altered.
- Set the appropriate violation boolean to TRUE (opening_removed, opening_relocated, opening_infilled).
- Set confidence LOW (0.4–0.6 if uncertain).

Never resolve architectural ambiguity by setting all violation booleans to false.

Ambiguity regarding architectural openings must be treated as potential structural modification.

Return a JSON object with the following structure:

{
  "openingRemoved": boolean,
  "openingRelocated": boolean,
  "openingInfilled": boolean,
  "confidence": number
}

Confidence rules:
- 0.0–0.3 = low certainty
- 0.4–0.6 = moderate uncertainty
- 0.7–0.89 = high but not absolute certainty
- 0.9–1.0 = near absolute certainty

Confidence must reflect architectural certainty, not stylistic opinion.
Do not default to 0 or 1 unless certainty is extreme.
Always provide a numeric value between 0 and 1.

Do not return prose. Return JSON only.`;
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
}): Promise<{ confirmedFail: boolean; uncertain?: boolean; reasons: string[]; confidence?: number; raw?: any; status: "pass" | "fail" | "uncertain" | "error" }> {
  const failOpen = (process.env.GEMINI_CONFIRM_FAIL_OPEN ?? "1") === "1";
  const geminiMode = getGeminiValidatorMode();
  const geminiBlocking = isGeminiBlockingEnabled();
  const reasons: string[] = [];

  try {
    let promptOverride = params.stage === "stage2"
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
      deterministicStructureJson: params.stage === "stage2",
      evidence: undefined,
      riskLevel: params.riskLevel,
    });

    const confidence = typeof verdict.confidence === "number" && Number.isFinite(verdict.confidence)
      ? verdict.confidence
      : NaN;
    const hasBooleanContract =
      typeof verdict.openingRemoved === "boolean" &&
      typeof verdict.openingRelocated === "boolean" &&
      typeof verdict.openingInfilled === "boolean";

    const explicitOpeningViolation =
      hasBooleanContract && (
        verdict.openingRemoved === true ||
        verdict.openingRelocated === true ||
        verdict.openingInfilled === true
      );

    const rawTextLower = String(verdict.rawText || "").toLowerCase();
    const reasonTextLower = (Array.isArray(verdict.reasons) ? verdict.reasons : []).join(" ").toLowerCase();
    const ambiguousTextSignal = [
      "uncertain",
      "ambiguous",
      "unclear",
      "cannot determine",
      "can't determine",
      "insufficient",
      "not sure",
      "unable to confirm",
      "occluded",
      "partially occluded",
    ].some((token) => rawTextLower.includes(token) || reasonTextLower.includes(token));

    const structuralChanged = params.stage === "stage2"
      ? explicitOpeningViolation
      : (
        verdict.hardFail === true ||
        verdict.category === "structure" ||
        verdict.category === "opening_blocked"
      );

    const uncertain = params.stage === "stage2"
      ? (!explicitOpeningViolation && (!Number.isFinite(confidence) || !hasBooleanContract || ambiguousTextSignal))
      : false;

    const pass = !structuralChanged;
    if (!pass || uncertain) {
      if (uncertain) {
        reasons.push("gemini_confirm_uncertain");
      }
      if (Array.isArray(verdict.reasons) && verdict.reasons.length > 0) {
        reasons.push(...verdict.reasons);
      }
    }

    const confirmedFail = params.stage === "stage2"
      ? structuralChanged
      : (geminiBlocking ? !pass : false);

    if (params.stage !== "stage2" && !geminiBlocking && !pass) {
      reasons.push("gemini_mode=log");
    }

    return {
      confirmedFail,
      uncertain,
      reasons,
      confidence: verdict.confidence,
      raw: verdict,
      status: confirmedFail ? "fail" : uncertain ? "uncertain" : "pass",
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    reasons.push(`gemini_confirm_error: ${msg}`);
    const confirmedFail = params.stage === "stage2"
      ? false
      : (geminiBlocking ? !failOpen : false);
    return {
      confirmedFail,
      uncertain: params.stage === "stage2",
      reasons,
      status: params.stage === "stage2" ? "uncertain" : "error",
    };
  }
}
