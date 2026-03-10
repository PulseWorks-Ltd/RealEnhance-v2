import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

export type EnvelopeValidatorResult = {
  status: "pass" | "fail";
  reason: string;
  confidence: number;
};

const ENVELOPE_MODEL_PRIMARY = process.env.GEMINI_VALIDATOR_MODEL_PRIMARY || "gemini-2.5-flash";
const ENVELOPE_MODEL_ESCALATION = process.env.GEMINI_VALIDATOR_MODEL_ESCALATION || "gemini-2.5-pro";
const ENVELOPE_ESCALATION_CONFIDENCE = Number(process.env.GEMINI_VALIDATOR_PRO_MIN_CONFIDENCE || 0.7);

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

  const reason = typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
    ? parsed.reason.trim()
    : parsed.ok ? "envelope_preserved" : "envelope_changed";
  const confidence = Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : 0.5;

  return {
    status: parsed.ok ? "pass" : "fail",
    reason,
    confidence,
  };
}

export async function runEnvelopeValidator(
  beforeImageUrl: string,
  afterImageUrl: string
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

{"ok":true|false,"reason":"short explanation","confidence":0.0-1.0}`;

  const runWithModel = async (model: string): Promise<EnvelopeValidatorResult> => {
    const response = await (ai as any).models.generateContent({
      model,
      contents: [
        { role: "user", parts: [{ text: prompt }] },
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/webp", data: before } },
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

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseEnvelopeResult(text);
  };

  try {
    const flashResult = await runWithModel(ENVELOPE_MODEL_PRIMARY);
    if (Number.isFinite(flashResult.confidence) && flashResult.confidence >= ENVELOPE_ESCALATION_CONFIDENCE) {
      return flashResult;
    }

    try {
      const proResult = await runWithModel(ENVELOPE_MODEL_ESCALATION);
      if (Number.isFinite(proResult.confidence) && proResult.confidence >= ENVELOPE_ESCALATION_CONFIDENCE) {
        return proResult;
      }
      return flashResult;
    } catch {
      return flashResult;
    }
  } catch (error: any) {
    throw new Error(`validator_error_envelope:${error?.message || String(error)}`);
  }
}
