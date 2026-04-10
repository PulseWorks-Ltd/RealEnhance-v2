import { getGeminiClient } from "../ai/gemini";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { toBase64 } from "../utils/images";
import { classifyIssueTier, ISSUE_TYPES, splitIssueTokens } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";
import { computeVerticalEdgeDelta, type VerticalEdgeDeltaResult } from "./verticalEdgeDelta";

export type EnvelopeValidatorResult = ValidatorOutcome & {
  verticalEdgeDelta?: VerticalEdgeDeltaResult;
};

const ENVELOPE_MODEL_PRIMARY = process.env.GEMINI_VALIDATOR_MODEL_PRIMARY || "gemini-2.5-flash";
const ENVELOPE_MODEL_ESCALATION = process.env.GEMINI_VALIDATOR_MODEL_ESCALATION || "gemini-2.5-pro";
const ENVELOPE_ESCALATION_CONFIDENCE = Number(process.env.GEMINI_VALIDATOR_PRO_MIN_CONFIDENCE || 0.7);

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

function parseEnvelopeResult(rawText: string): EnvelopeValidatorResult {
  const cleaned = String(rawText || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  let parsed: any;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    throw new Error("validator_error_invalid_json");
  }

  if (typeof parsed?.ok !== "boolean") {
    throw new Error("validator_error_invalid_schema");
  }

  const envelopeDetectedChange = parsed.ok === false;
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

  const baseReason = typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
    ? parsed.reason.trim()
    : parsed.ok ? "envelope_preserved" : "envelope_changed";
  const reason = reasonCode ? `${reasonCode}: ${baseReason}` : baseReason;
  const confidence = Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : 0.5;
  const advisorySignals = parsed.ok ? [] : [reason, ...(reasonCode ? [reasonCode] : [])];
  const tokens = splitIssueTokens(reason, advisorySignals);
  const has = (prefix: string): boolean => tokens.some((token) => token === prefix || token.startsWith(`${prefix}_`));
  const issueType = parsed.ok
    ? ISSUE_TYPES.NONE
    : has("room_envelope_changed")
      ? ISSUE_TYPES.ROOM_ENVELOPE_CHANGED
      : has("wall_changed") || has("wall_plane") || has("wall")
        ? ISSUE_TYPES.WALL_CHANGED
        : ISSUE_TYPES.ENVELOPE_ANOMALY;

  console.log("[ENVELOPE_GEOMETRIC_CERTAINTY]", {
    envelopeDetectedChange,
    geometricCertainty,
    reason: reasonCode || "envelope_preserved",
  });

  return {
    status: parsed.ok ? "pass" : "fail",
    reason,
    confidence,
    hardFail: parsed.ok ? false : (geometricCertainty && confidence >= 0.85),
    issueType,
    issueTier: classifyIssueTier(issueType),
    advisorySignals,
  };
}

export async function runEnvelopeValidator(
  beforeImageUrl: string,
  afterImageUrl: string,
  options?: { jobId?: string; imageId?: string; attempt?: number }
): Promise<EnvelopeValidatorResult> {
  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;

  const prompt = `You are validating whether two images represent the exact same physical room architecture.

Compare the BASELINE image and the STAGED image.

GLOBAL RULE
The staged image must represent the exact same physical room architecture as the baseline image.
Furniture, decor, and staging objects may change.
Architectural structure may NOT change.

Your task is to verify that the architectural envelope is identical.

Set ok=false if ANY envelope violation is visible:
* walls moved, shifted, rotated, extended, shortened, reshaped, added, or removed
* room footprint changed in shape, width, depth, or segmentation
* wall intersections/corners changed, appeared, or disappeared
* new structural wall planes appear, or existing wall planes disappear
* alcoves/recesses/bulkheads/soffits that define room shape are altered
* ceiling geometry/height/major plane layout is altered
* structural columns or fixed architectural supports are added/removed/relocated

Wall Plane Extension Rule (Critical)
FAIL if a new flat wall surface appears in the staged image
that did not exist in the baseline image, even if the new
surface aligns with an existing wall.

This includes:
* wall extensions
* filled recesses
* flattened wall indentations
* added planar wall segments
* new vertical surfaces attached to existing walls

If a baseline indentation, recess, doorway gap, or wall
offset becomes a continuous flat wall surface in the
staged image, this indicates architectural modification
and must return ok=false.

This rule applies even when:
* color is identical
* lighting is identical
* the change is subtle

Do not interpret a newly flattened wall surface as a
perspective correction or camera shift.

Local Wall-Plane Continuity Check (Critical)
Compare the continuity of each visible wall plane.

If a baseline wall plane contains a recess,
indentation, doorway, or opening gap,
and the staged image shows that area as a
continuous flat wall surface, return ok=false.

This catches:
* doorway infill
* closet recess flattening
* wall extensions

Treat these as architectural invariants:
* wall layout and envelope geometry
* room proportions and segmentation
* fixed structural boundaries of the room

Important disambiguation:
* Perspective/cropping differences are allowed only when envelope geometry is still consistent.
* Do NOT excuse true wall or footprint changes as camera shift.
* Do not treat furniture or decor occluding part of a window or doorway as an envelope change.

Ignore:
* furniture and decor changes
* rugs and movable items
* lighting/color/rendering differences
* minor perspective normalization or crop differences that do not change architecture

Return JSON only:

{
  "ok":true|false,
  "reason":"short explanation",
  "confidence":0.0-1.0,
  "boundaryLinesMissing": true|false,
  "continuousSurfaceReplacement": true|false,
  "noPlausibleVisualExplanation": true|false,
  "visualAmbiguity": true|false,
  "reasonCode": "envelope_visual_ambiguity"|"envelope_insufficient_geometric_evidence"|"envelope_confirmed_structural_change"
}

GEOMETRIC CERTAINTY RULE (MANDATORY)
Set ok=false only when structural change is supported by clear geometric evidence.

For structural certainty, all must be true:
1) boundaryLinesMissing
2) continuousSurfaceReplacement
3) noPlausibleVisualExplanation

Non-fail certainty guard:
- If recess/offset is faint but partially visible, do not claim certainty.
- If edges are reduced but not eliminated, do not claim certainty.
- If lighting, shadow loss, or smoothing can explain flattening, do not claim certainty.
- If geometry is ambiguous, set visualAmbiguity=true and do not claim certainty.`;

  const runWithModel = async (model: string): Promise<EnvelopeValidatorResult> => {
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
    return parseEnvelopeResult(text);
  };

  try {
    // Run vertical-edge delta detection in parallel with Gemini calls.
    // It is non-blocking – if it fails we fall through to Gemini-only result.
    const verticalEdgeDeltaPromise = computeVerticalEdgeDelta(beforeImageUrl, afterImageUrl)
      .catch((err) => {
        console.warn("[ENVELOPE_VERTICAL_EDGE_DELTA] local analysis failed (non-blocking):", err?.message || err);
        return undefined;
      });

    // Gemini semantic analysis
    let geminiResult: EnvelopeValidatorResult;
    const flashResult = await runWithModel(ENVELOPE_MODEL_PRIMARY);
    if (Number.isFinite(flashResult.confidence) && flashResult.confidence >= ENVELOPE_ESCALATION_CONFIDENCE) {
      geminiResult = flashResult;
    } else {
      try {
        const proResult = await runWithModel(ENVELOPE_MODEL_ESCALATION);
        geminiResult = (Number.isFinite(proResult.confidence) && proResult.confidence >= ENVELOPE_ESCALATION_CONFIDENCE)
          ? proResult
          : flashResult;
      } catch {
        geminiResult = flashResult;
      }
    }

    // Merge vertical edge delta signals into the envelope outcome
    const vedResult = await verticalEdgeDeltaPromise;
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
      if (vedResult.verticalEdgeLossDetected) {
        geminiResult.advisorySignals.push("envelope_vertical_edge_loss");
        // Upgrade issue type if Gemini didn't already flag a critical envelope issue
        if (geminiResult.issueType === ISSUE_TYPES.NONE || geminiResult.issueType === ISSUE_TYPES.ENVELOPE_ANOMALY) {
          geminiResult.issueType = ISSUE_TYPES.ENVELOPE_VERTICAL_EDGE_LOSS;
          geminiResult.issueTier = classifyIssueTier(ISSUE_TYPES.ENVELOPE_VERTICAL_EDGE_LOSS);
        }
        if (geminiResult.status === "pass") {
          geminiResult.status = "fail";
          geminiResult.reason = `envelope_vertical_edge_loss: ${geminiResult.reason}`;
        }
      }

      // ── Feature 2: Corner Persistence → Tier 1 Geometric Fail ──────
      if (vedResult.cornerPersistenceFailure) {
        geminiResult.advisorySignals.push("envelope_corner_flattened");
        geminiResult.issueType = ISSUE_TYPES.ENVELOPE_CORNER_FLATTENED;
        geminiResult.issueTier = classifyIssueTier(ISSUE_TYPES.ENVELOPE_CORNER_FLATTENED);
        geminiResult.status = "fail";
        geminiResult.hardFail = true;
        if (!geminiResult.reason.includes("corner")) {
          geminiResult.reason = `envelope_corner_flattened: wall-plane corner collapsed – two planes merged into single surface. ${geminiResult.reason}`;
        }
      }
    }

    return geminiResult;
  } catch (error: any) {
    throw new Error(`validator_error_envelope:${error?.message || String(error)}`);
  }
}
