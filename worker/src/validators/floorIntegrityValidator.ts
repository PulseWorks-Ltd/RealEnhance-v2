import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import { classifyIssueTier, ISSUE_TYPES, splitIssueTokens } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";

export type FloorIntegrityValidatorResult = ValidatorOutcome;

type FloorValidatorRawResponse = {
  ok?: boolean;
  reason?: string;
  confidence?: number;
  baseline_material?: string;
  staged_material?: string;
  baseline_material_visible?: boolean;
  staged_material_visible?: boolean;
  staged_floor_fully_covered_by_movable_items?: boolean;
  material_changed?: boolean;
};

function normalizeFloorMaterialClass(raw: string): "carpet" | "wood" | "tile" | "stone" | "concrete" | "mixed" | "unknown" {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "unknown";

  if (/(mixed|combination|hybrid|multiple)/.test(value)) return "mixed";

  if (/(carpet|rug|fabric flooring|textile flooring|soft flooring)/.test(value)) {
    return "carpet";
  }

  if (/(wood|hardwood|timber|oak|engineered wood|engineered timber|laminate|vinyl plank|lvp|floorboard|floorboards|plank)/.test(value)) {
    return "wood";
  }

  if (/(tile|tiling|porcelain|ceramic|terracotta|mosaic)/.test(value)) {
    return "tile";
  }

  if (/(stone|marble|granite|slate|travertine|terrazzo)/.test(value)) {
    return "stone";
  }

  if (/(concrete|cement|polished concrete|microcement)/.test(value)) {
    return "concrete";
  }

  return "unknown";
}

function parseFloorIntegrityResult(rawText: string): FloorIntegrityValidatorResult {
  const cleaned = String(rawText || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  let parsed: FloorValidatorRawResponse;
  try {
    parsed = JSON.parse(jsonCandidate) as FloorValidatorRawResponse;
  } catch {
    throw new Error("validator_error_invalid_json");
  }

  if (typeof parsed?.ok !== "boolean") {
    throw new Error("validator_error_invalid_schema");
  }

  const baselineMaterial = normalizeFloorMaterialClass(parsed?.baseline_material || "");
  const stagedMaterial = normalizeFloorMaterialClass(parsed?.staged_material || "");
  const baselineVisible = parsed?.baseline_material_visible === true;
  const stagedVisible = parsed?.staged_material_visible === true;
  const stagedFullyCovered = parsed?.staged_floor_fully_covered_by_movable_items === true;
  const materialChangedExplicit = parsed?.material_changed === true;

  const materialChangedByCompare =
    baselineMaterial !== "unknown" &&
    stagedMaterial !== "unknown" &&
    baselineMaterial !== "mixed" &&
    stagedMaterial !== "mixed" &&
    baselineMaterial !== stagedMaterial;

  const shouldForceFail =
    (materialChangedExplicit || materialChangedByCompare) &&
    baselineVisible &&
    (stagedVisible || !stagedFullyCovered);

  const finalOk = shouldForceFail ? false : parsed.ok;

  const reason = typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
    ? parsed.reason.trim()
    : finalOk ? "floor_integrity_preserved" : "floor_integrity_changed";
  const confidence = Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : 0.5;
  const advisorySignals = finalOk ? [] : [reason];
  const tokens = splitIssueTokens(reason, advisorySignals);
  const has = (prefix: string): boolean => tokens.some((token) => token === prefix || token.startsWith(`${prefix}_`));
  const issueType = finalOk
    ? ISSUE_TYPES.NONE
    : has("floor_changed") || has("floor_integrity") || has("floor")
      ? ISSUE_TYPES.FLOOR_CHANGED
      : ISSUE_TYPES.FLOOR_ANOMALY;

  return {
    status: finalOk ? "pass" : "fail",
    reason,
    confidence,
    hardFail: false,
    issueType,
    issueTier: classifyIssueTier(issueType),
    advisorySignals,
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

COMPARISON PROCEDURE (MANDATORY)
1) Identify the structural floor material in the baseline image.
2) Identify the structural floor material in the staged image.
3) Compare the two material classes.

Set ok=false if ANY underlying floor-plane invariant is violated:
* floor material class changes (carpet <-> wood <-> tile/stone/concrete)
* tile/grid/plank layout that defines fixed flooring changes
* plank orientation changes materially
* floor perspective geometry/vanishing alignment implies changed floor plane
* floor boundary intersections with walls shift in a way that indicates footprint/geometry change

Do not treat rugs or movable coverings as structural floor changes.
If the baseline material is visible, the staged image must preserve the same structural floor material unless the floor is fully and clearly covered by movable items.

Ignore non-structural differences:
* rugs and movable mats
* furniture and decor
* shadows and illumination differences
* color grading/rendering differences
* minor crop/perspective differences that do not alter floor geometry

Return JSON only:
{"baseline_material":"carpet|wood|tile|stone|concrete|mixed|unknown","staged_material":"carpet|wood|tile|stone|concrete|mixed|unknown","baseline_material_visible":true|false,"staged_material_visible":true|false,"staged_floor_fully_covered_by_movable_items":true|false,"material_changed":true|false,"ok":true|false,"reason":"short explanation","confidence":0.0-1.0}`;

  const model = process.env.FLOOR_VALIDATOR_MODEL || "gemini-2.5-pro";

  try {
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
        responseMimeType: "application/json",
      },
    });

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseFloorIntegrityResult(text);
  } catch (error: any) {
    throw new Error(`validator_error_floor_integrity:${error?.message || String(error)}`);
  }
}
