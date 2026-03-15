import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import type { ValidatorOutcome } from "./validatorOutcome";

export type FixtureValidatorResult = ValidatorOutcome;

function parseFixtureResult(rawText: string): FixtureValidatorResult {
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
    : parsed.ok ? "fixtures_preserved" : "fixtures_changed";
  const confidence = Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : 0.5;

  return {
    status: parsed.ok ? "pass" : "fail",
    reason,
    confidence,
    hardFail: false,
    advisorySignals: parsed.ok ? [] : [reason],
  };
}

export async function runFixtureValidator(
  beforeImageUrl: string,
  afterImageUrl: string
): Promise<FixtureValidatorResult> {
  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;

  const prompt = `You are validating whether two images represent the exact same physical room architecture and fixed installed fixtures.

Compare the BASELINE image and the STAGED image.

GLOBAL RULE
The staged image must represent the exact same physical room architecture as the baseline image.
Furniture, decor, and staging objects may change.
Architectural structure and fixed installed fixtures may NOT change.

Set ok=false if ANY major fixed fixture is clearly added, removed, resized, replaced with a different class, or relocated:
* HVAC systems (wall-mounted split units, fixed AC units)
* ceiling fans
* pendant lights
* recessed/downlights
* ceiling vents
* smoke detectors

Also fail if a fixed ceiling/wall fixture present in baseline is replaced by a materially different fixed fixture type in staged image.

Do NOT fail for uncertain visibility alone. Only pass when evidence supports that fixed fixtures are preserved.

Examples that should NOT fail when architecture/fixtures are otherwise preserved:
* light switches or outlets hidden by furniture
* small fixtures partially occluded by decor
* minor camera/perspective/cropping differences
* color temperature/brightness/rendering differences

Return JSON only:
{"ok":true|false,"reason":"short explanation","confidence":0.0-1.0}`;

  try {
    const response = await (ai as any).models.generateContent({
      model: "gemini-2.5-flash",
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
        responseMimeType: "application/json",
      },
    });

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseFixtureResult(text);
  } catch (error: any) {
    throw new Error(`validator_error_fixture:${error?.message || String(error)}`);
  }
}
