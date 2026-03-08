import { getGeminiClient } from "../ai/gemini";
import { nLog, vLog } from "../logger";

export interface FixtureValidatorResult {
  ok: boolean;
  reason: string;
  detected_changes?: string[];
}

/**
 * Lightweight Fixture Validator
 * Detects small fixture changes (ceiling fans, pendant lights, downlights,
 * smoke detectors, vents, hvac, faucets, etc.) that skip past the broader structural validator.
 * 
 * Runs a targeted Gemini call.
 */
export async function runFixtureValidator(
  baseImageUrl: string, 
  stage2CandidateUrl: string
): Promise<FixtureValidatorResult> {
  const tStart = Date.now();
  try {
    const ai = getGeminiClient();

    const prompt = `
You are a highly specialized Fixture Validator.
Compare the baseline image (Image 1) with the candidate edited image (Image 2).

Check ONLY these specific items:
- ceiling fans
- pendant lights
- downlights / recessed lights
- smoke detectors
- vents / HVAC ceiling vents

RULES:
1. These items are fixed fixtures attached to the ceiling.
2. They must NOT disappear, appear, or change position.
3. Furniture, decor, and lighting brightness changes are perfectly allowed.
4. Only the geometric presence, structure, and location of the fixtures themselves matters.

Respond ONLY with valid JSON in this exact structure:
{
  "ok": true|false,
  "reason": "short explanation",
  "detected_changes": ["fan_removed", "pendant_moved"] // empty if ok=true
}

If any fixture disappeared, appeared, or moved significantly, set ok=false. Otherwise ok=true.
`;

    const response = await (ai as any).models.generateContent({
      model: "gemini-2.5-flash", // fast lightweight model
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: baseImageUrl.replace(/^data:image\/\w+;base64,/, ""),
              }
            },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: stage2CandidateUrl.replace(/^data:image\/\w+;base64,/, ""),
              }
            }
          ]
        }
      ],
      config: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    });
    
    let resultJson = response.text || "";
    // occasionally response.text is a function, check if it's callable
    if (typeof response.text === "function") {
       resultJson = response.text();
    }

    // remove markdown block if present
    if (resultJson.startsWith("\`\`\`json")) {
      resultJson = resultJson.replace(/^\`\`\`json/, "").replace(/\`\`\`$/, "").trim();
    }
    const result: FixtureValidatorResult = JSON.parse(resultJson);

    nLog(`[FIXTURE_VALIDATOR] ms=${Date.now() - tStart} ok=${result.ok}`);
    return result;

  } catch (error: any) {
    nLog(`[FIXTURE_VALIDATOR_ERROR] ${error?.message || error}`);
    // Fail open on error so we don't break pipeline
    return {
      ok: true,
      reason: `error: ${error?.message}`,
      detected_changes: []
    };
  }
}
