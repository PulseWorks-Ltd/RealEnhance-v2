import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

export type OpeningValidatorResult = {
  status: "pass" | "fail";
  reason: string;
  confidence: number;
};

const OPENING_MODEL_PRIMARY = process.env.GEMINI_VALIDATOR_MODEL_PRIMARY || "gemini-2.5-flash";
const OPENING_MODEL_ESCALATION = process.env.GEMINI_VALIDATOR_MODEL_ESCALATION || "gemini-2.5-pro";
const OPENING_ESCALATION_CONFIDENCE = Number(process.env.GEMINI_VALIDATOR_PRO_MIN_CONFIDENCE || 0.7);

function parseOpeningResult(rawText: string): OpeningValidatorResult {
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
    : parsed.ok ? "openings_preserved" : "openings_changed";
  const confidence = Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : 0.5;

  return {
    status: parsed.ok ? "pass" : "fail",
    reason,
    confidence,
  };
}

export async function runOpeningValidator(
  beforeImageUrl: string,
  afterImageUrl: string
): Promise<OpeningValidatorResult> {
  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;

  const prompt = `You are validating whether two images represent the exact same physical room architecture.

Compare the BASELINE image and the STAGED image.

GLOBAL RULE
The staged image must represent the exact same physical room architecture as the baseline image.
Furniture, decor, and staging objects may change.
Architectural structure may NOT change.

OPENING RULE (CRITICAL)
Treat windows, doors, sliding doors, closet doors, archways, balcony openings, and hallway openings as structural voids in wall planes.
If an architectural opening exists in the baseline image, it must remain visible in the staged image in approximately the same size and position.

Opening Verification Step (Required)
First identify all architectural openings present in
the baseline image.

These may include:
* windows
* doors
* closet doors
* sliding doors
* hallway openings
* archways
* balcony openings
* passage openings

For each opening identified in the baseline image,
verify that the same opening still exists in the
staged image.

Opening inventory step (internal reasoning):
Before making a decision, identify all architectural openings visible in the baseline image.

Architectural openings include:
windows, doors, sliding doors, closet doors, archways, balcony openings, and hallway openings.

For each opening determine:
* type (window, door, closet door, etc.)
* approximate position on the wall (left/center/right or relative to wall corners)
* approximate width relative to the wall
* approximate height relative to the wall

Then verify that each of those same openings still exists in the staged image in approximately the same location and size.

Verification step:
For each opening identified in the baseline inventory, explicitly verify whether the same opening is visible in the staged image.
If any baseline opening cannot be located or is replaced by continuous wall surface, the staged image must fail.

Missing Opening Rule
If any baseline opening cannot be located in the
staged image, the image must fail.

An opening is considered missing if:
* it is replaced by continuous wall surface
* it is sealed, filled, or walled over
* it disappears behind furniture with no visible
  opening geometry remaining

Opening invariant rule:
If any architectural opening from the baseline inventory:
* disappears
* becomes continuous wall surface
* becomes sealed or infilled
* changes width or height significantly
* relocates on the wall
* is replaced by a different type of opening
then set ok=false.

Occlusion handling:
Windows, doors, sliding doors, and closet openings may be partially occluded by furniture, decor, or curtains introduced during staging.
This is acceptable if the opening frame, position, and surrounding wall geometry still indicate that the opening exists.
Do NOT fail when an opening is partially hidden by furniture.
Fail ONLY when the opening itself disappears structurally, becomes wall, is sealed, resized, or relocated.

Occlusion Rule
Furniture or decor may partially block an opening.

However the opening must still be visually detectable
in the wall geometry.

Acceptable occlusion:
* bed covering lower portion of a window
* sofa partially covering doorway edge
* decor partially blocking a closet door

Unacceptable occlusion:
* furniture completely covering the opening region
* the opening cannot be located visually
* the region appears as continuous flat wall

If the baseline opening cannot be located because it is
fully hidden by furniture or appears replaced by wall
surface, assume the opening has been removed and
return ok=false.

Closet-door strictness:
Closet doors/openings may not disappear or be replaced by wall surface.
Temporary occlusion by small decor is possible, but large furniture covering the entire closet opening should be treated as suspicious and fail unless the closet opening is still clearly evidenced.

Set ok=false if ANY opening or built-in invariant is violated:
* window opening removed, added, resized, relocated, blocked, sealed, or infilled
* window opening replaced by continuous wall surface
* door/sliding-door opening removed, added, resized, relocated, sealed, or walled over
* closet door or closet opening removed, added, resized, relocated, sealed, hidden by walling, or replaced by flat wall
* doorway/archway/hallway opening disappears or becomes wall
* any baseline opening disappears or is materially transformed into solid wall
* built-ins moved/resized/removed/added (built-in cabinetry, kitchen islands, fireplaces, wall shelving, recessed wall units)

Perspective/cropping differences are allowed ONLY when all baseline openings remain present and consistent.

Ignore:
* movable furniture/decor changes
* lighting/color/rendering differences
* temporary occlusions caused by staging objects when opening geometry is still clearly preserved

Return JSON only:
{"ok":true|false,"reason":"short explanation","confidence":0.0-1.0}`;

  const runWithModel = async (model: string): Promise<OpeningValidatorResult> => {
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
    return parseOpeningResult(text);
  };

  try {
    const flashResult = await runWithModel(OPENING_MODEL_PRIMARY);
    if (Number.isFinite(flashResult.confidence) && flashResult.confidence >= OPENING_ESCALATION_CONFIDENCE) {
      return flashResult;
    }

    try {
      const proResult = await runWithModel(OPENING_MODEL_ESCALATION);
      if (Number.isFinite(proResult.confidence) && proResult.confidence >= OPENING_ESCALATION_CONFIDENCE) {
        return proResult;
      }
      return flashResult;
    } catch {
      return flashResult;
    }
  } catch (error: any) {
    throw new Error(`validator_error_opening:${error?.message || String(error)}`);
  }
}
