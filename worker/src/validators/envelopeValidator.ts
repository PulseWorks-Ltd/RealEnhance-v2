import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

export type EnvelopeValidatorResult = {
  status: "pass" | "fail";
  reason: string;
  confidence: number;
};

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

Compare the baseline image and the staged image.

Set ok=false ONLY if any of these architectural envelope violations are visible:
* walls moved, reshaped, or added
* ceiling plane altered
* room footprint changed
* camera viewpoint significantly changed
* perspective changed so wall intersections shift

Ignore furniture, decor, styling, lighting changes, and minor rendering differences.

Return JSON only:
{"ok":true|false,"reason":"short explanation","confidence":0.0-1.0}`;

  try {
    const response = await (ai as any).models.generateContent({
      model: "gemini-1.5-pro",
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
        responseMimeType: "application/json",
      },
    });

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseEnvelopeResult(text);
  } catch (error: any) {
    throw new Error(`validator_error_envelope:${error?.message || String(error)}`);
  }
}
