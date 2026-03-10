import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

export type FloorIntegrityValidatorResult = {
  status: "pass" | "fail";
  reason: string;
  confidence: number;
};

function parseFloorIntegrityResult(rawText: string): FloorIntegrityValidatorResult {
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
    : parsed.ok ? "floor_integrity_preserved" : "floor_integrity_changed";
  const confidence = Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : 0.5;

  return {
    status: parsed.ok ? "pass" : "fail",
    reason,
    confidence,
  };
}

export async function runFloorIntegrityValidator(
  beforeImageUrl: string,
  afterImageUrl: string
): Promise<FloorIntegrityValidatorResult> {
  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;

  const prompt = `You are validating floor structural integrity between a baseline room image and a staged room image.

GLOBAL RULE
The staged image must represent the exact same physical room architecture as the baseline image.
Furniture, decor, and staging objects may change.
Architectural structure may NOT change.

Set ok=false if ANY underlying floor-plane invariant is violated:
* floor material class changes (carpet <-> wood <-> tile/stone/concrete) for exposed structural floor
* tile/grid/plank layout that defines fixed flooring changes
* plank orientation changes materially
* floor perspective geometry/vanishing alignment implies changed floor plane
* floor boundary intersections with walls shift in a way that indicates footprint/geometry change

Do not treat rugs or movable coverings as structural floor changes.

Ignore non-structural differences:
* rugs and movable mats
* furniture and decor
* shadows and illumination differences
* color grading/rendering differences
* minor crop/perspective differences that do not alter floor geometry

Return JSON only:
{"ok":true|false,"reason":"short explanation","confidence":0.0-1.0}`;

  try {
    const response = await (ai as any).models.generateContent({
      model: "gemini-2.5-flash",
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
    return parseFloorIntegrityResult(text);
  } catch (error: any) {
    throw new Error(`validator_error_floor_integrity:${error?.message || String(error)}`);
  }
}
