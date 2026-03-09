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

  const prompt = `You are validating whether two images represent the same physical room.

Compare the BASELINE image and the STAGED image.

Your task is to verify that the architectural envelope of the room is identical.

Set ok=false ONLY if any of these are visible:

* walls were added, removed, reshaped, extended, shortened, or shifted
* room segmentation changes (new/removed partitions, dividers, enclosed areas)
* ceiling plane geometry is altered
* room footprint changes shape or size
* major wall intersections appear or disappear
* a new structural wall plane appears that intersects floor and ceiling and alters room segmentation
* the number of visible major room corner intersections increases or decreases, indicating room geometry changed

Focus on the shape and boundaries of the room itself, not the objects inside it.

Ignore:
furniture changes, decor changes, staging items, lighting differences, rugs, reflections, minor rendering differences, small camera shifts, minor perspective corrections, or cropping differences.

The staged image must represent the exact same room boundaries and wall layout as the baseline image.

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
