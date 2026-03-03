import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

export type StructuralOpeningType = "window" | "door" | "closet" | "archway";
export type StructuralClass = "circulation" | "storage" | "exterior" | "unknown";
export type WallPosition = "left_wall" | "right_wall" | "far_wall" | "near_wall";
export type RelativeHorizontalPosition = "left_third" | "center" | "right_third";
export type WallIndex = 0 | 1 | 2 | 3;
export type HorizontalBand = "left_third" | "center_third" | "right_third";
export type VerticalBand = "floor_zone" | "mid_zone" | "ceiling_zone" | "full_height";
export type WidthBand = "narrow" | "single" | "double" | "wide";

export type StructuralOpening = {
  id: string;
  type: StructuralOpeningType;
  structuralClass: StructuralClass;
  wallIndex: WallIndex;
  horizontalBand: HorizontalBand;
  verticalBand: VerticalBand;
  widthBand: WidthBand;
  approxAspectRatio: number;
  confidence: number;

  // Legacy compatibility fields used by existing downstream systems
  wallPosition: WallPosition;
  relativeHorizontalPosition: RelativeHorizontalPosition;
  shape: string;
  touchesFloor: boolean;
  touchesCeiling: boolean;
  approxCount: number;
};

export type StructuralBaseline = {
  cameraOrientation?: string;
  openings: StructuralOpening[];
  wallCount: number;
};

export type OpeningValidationResult = {
  results: OpeningResult[];
  summary: {
    openingRemoved: boolean;
    openingSealed: boolean;
    openingRelocated: boolean;
    openingResized: boolean;
    openingClassMismatch: boolean;
    openingBandMismatch: boolean;
    outOfFrameOpenings: string[];
    confidence: number;
  };
  detectedOpenings: StructuralOpening[];
};

export type OpeningResult = {
  id: string;
  present: boolean;
  sealed: boolean;
  relocated: boolean;
  outOfFrame: boolean;
  confidence: number;
};

const OPENING_VALIDATOR_MODEL = String(
  process.env.OPENING_PRESERVATION_MODEL || process.env.STRUCTURAL_INVARIANT_MODEL || "gemini-2.5-flash"
);

const BASELINE_SYSTEM_INSTRUCTION = `You are a structural feature extraction engine.

You must analyze a single interior room image and extract only permanent architectural openings.

Permanent openings include:
- Windows
- Doors
- Closet doors
- Archways
- Built-in fixed openings

Ignore:
- Furniture
- Decor
- Lighting
- Reflections
- Curtains
- Temporary objects
- Wall art
- Mirrors
- Open door leaf positions (door open vs closed does not matter)

You must output strict JSON only.
No explanations.
No markdown.
No comments.
No extra text.

If something is partially occluded but clearly a structural opening, include it.

If you are uncertain whether something is a structural opening, include it.

Do not omit visible openings.`;

const BASELINE_USER_PROMPT = `Analyze this room image and extract a structural baseline.

Return JSON in this exact schema:

{
  "openings": [
    {
      "id": string,
      "type": "window" | "door" | "closet" | "archway",
      "structuralClass": "circulation" | "storage" | "exterior" | "unknown",
      "wallIndex": 0 | 1 | 2 | 3,
      "horizontalBand": "left_third" | "center_third" | "right_third",
      "verticalBand": "floor_zone" | "mid_zone" | "ceiling_zone" | "full_height",
      "widthBand": "narrow" | "single" | "double" | "wide",
      "approxAspectRatio": number,
      "confidence": number
    }
  ],
  "wallCount": number
}

Rules:
- Assign deterministic IDs like W1, W2, D1, C1, A1.
- wallIndex mapping: 0=front wall (camera facing), 1=right wall, 2=back wall, 3=left wall.
- horizontalBand and verticalBand should be stable under mild reframing.
- widthBand reflects approximate opening width class.
- confidence is 0..1.

Return only valid JSON.`;

const OPENING_VALIDATION_SYSTEM_INSTRUCTION = `You are a structural preservation validator.

Your job is to compare:
1) The structural baseline (extracted from the original image).
2) The enhanced image.

You must enforce strict spatial preservation of architectural openings.

Rules:
- Opening identity must be preserved.
- Structural class must match.
- Wall index must match.
- Horizontal/vertical banding must match unless out-of-frame.
- Material width-band resizing is a violation.
- Substitution across walls is a violation.

Out-of-frame handling:
- If an opening wall region is cropped out, include the opening id in outOfFrameOpenings.
- Do not mark it removed unless sealing is visible.

Return strict JSON only.
No explanation.
No commentary.`;

function extractJsonCandidate(text: string): string {
  if (!text) return "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;

  let start = -1;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      if (start === -1) start = index;
      depth += 1;
    } else if (char === "}" && start !== -1) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return text.trim();
}

function parseJsonResponse(rawResponse: any): any {
  const textParts = rawResponse?.candidates?.[0]?.content?.parts || [];
  const rawText = textParts.map((p: any) => p?.text || "").join("\n").trim();
  const jsonCandidate = extractJsonCandidate(rawText);
  return JSON.parse(jsonCandidate);
}

function isOpeningType(value: string): value is StructuralOpeningType {
  return value === "window" || value === "door" || value === "closet" || value === "archway";
}

function isWallPosition(value: string): value is WallPosition {
  return value === "left_wall" || value === "right_wall" || value === "far_wall" || value === "near_wall";
}

function isRelativeHorizontalPosition(value: string): value is RelativeHorizontalPosition {
  return value === "left_third" || value === "center" || value === "right_third";
}

function isWallIndex(value: number): value is WallIndex {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function isHorizontalBand(value: string): value is HorizontalBand {
  return value === "left_third" || value === "center_third" || value === "right_third";
}

function isVerticalBand(value: string): value is VerticalBand {
  return value === "floor_zone" || value === "mid_zone" || value === "ceiling_zone" || value === "full_height";
}

function isWidthBand(value: string): value is WidthBand {
  return value === "narrow" || value === "single" || value === "double" || value === "wide";
}

function mapWallPositionToIndex(wallPosition: WallPosition): WallIndex {
  if (wallPosition === "near_wall") return 0;
  if (wallPosition === "right_wall") return 1;
  if (wallPosition === "far_wall") return 2;
  return 3;
}

function mapIndexToWallPosition(wallIndex: WallIndex): WallPosition {
  if (wallIndex === 0) return "near_wall";
  if (wallIndex === 1) return "right_wall";
  if (wallIndex === 2) return "far_wall";
  return "left_wall";
}

function mapLegacyHorizontalToBand(value: RelativeHorizontalPosition): HorizontalBand {
  if (value === "left_third") return "left_third";
  if (value === "right_third") return "right_third";
  return "center_third";
}

function mapBandToLegacyHorizontal(value: HorizontalBand): RelativeHorizontalPosition {
  if (value === "left_third") return "left_third";
  if (value === "right_third") return "right_third";
  return "center";
}

function deriveVerticalBand(opening: Pick<StructuralOpening, "touchesFloor" | "touchesCeiling">): VerticalBand {
  if (opening.touchesFloor && opening.touchesCeiling) return "full_height";
  if (opening.touchesFloor) return "floor_zone";
  if (opening.touchesCeiling) return "ceiling_zone";
  return "mid_zone";
}

function deriveWidthBand(opening: Pick<StructuralOpening, "type" | "shape" | "approxCount">): WidthBand {
  const shape = (opening.shape || "").toLowerCase();
  if (opening.approxCount >= 2 || shape.includes("double")) return "double";
  if (shape.includes("wide") || shape.includes("panorama")) return "wide";
  if (shape.includes("narrow") || opening.type === "closet") return "narrow";
  return "single";
}

function deriveApproxAspectRatio(opening: Pick<StructuralOpening, "type" | "shape">): number {
  const shape = (opening.shape || "").toLowerCase();
  if (shape.includes("square")) return 1;
  if (opening.type === "window") return 1.4;
  if (opening.type === "door" || opening.type === "closet") return 0.5;
  if (opening.type === "archway") return 0.8;
  return 1;
}

export function deriveStructuralClass(opening: Pick<StructuralOpening, "type" | "touchesFloor" | "touchesCeiling">): StructuralClass {
  if (opening.type === "window") return "exterior";
  if (opening.type === "closet") return "storage";
  if (opening.type === "door" || opening.type === "archway") return "circulation";
  return "unknown";
}

function validateStructuralBaseline(input: any): StructuralBaseline {
  if (!input || typeof input !== "object") {
    throw new Error("Structural baseline must be an object");
  }

  if (!Array.isArray(input.openings)) {
    throw new Error("Structural baseline openings must be an array");
  }

  const openings: StructuralOpening[] = input.openings.map((opening: any, index: number) => {
    if (!opening || typeof opening !== "object") {
      throw new Error(`Invalid opening at index ${index}`);
    }

    if (typeof opening.id !== "string" || !opening.id.trim()) {
      throw new Error(`Opening id is required at index ${index}`);
    }
    if (!isOpeningType(opening.type)) {
      throw new Error(`Opening type must be one of window|door|closet|archway at index ${index}`);
    }
    const wallPositionCandidate = isWallPosition(opening.wallPosition)
      ? opening.wallPosition
      : (typeof opening.wallIndex === "number" && isWallIndex(opening.wallIndex)
        ? mapIndexToWallPosition(opening.wallIndex)
        : null);
    if (!wallPositionCandidate) {
      throw new Error(`Opening wallPosition/wallIndex is required at index ${index}`);
    }

    const wallIndexCandidate = typeof opening.wallIndex === "number" && isWallIndex(opening.wallIndex)
      ? opening.wallIndex
      : mapWallPositionToIndex(wallPositionCandidate);

    const relativeHorizontalCandidate = isRelativeHorizontalPosition(opening.relativeHorizontalPosition)
      ? opening.relativeHorizontalPosition
      : (typeof opening.horizontalBand === "string" && isHorizontalBand(opening.horizontalBand)
        ? mapBandToLegacyHorizontal(opening.horizontalBand)
        : "center");

    const horizontalBandCandidate = typeof opening.horizontalBand === "string" && isHorizontalBand(opening.horizontalBand)
      ? opening.horizontalBand
      : mapLegacyHorizontalToBand(relativeHorizontalCandidate);

    const shapeCandidate = typeof opening.shape === "string" && opening.shape.trim()
      ? opening.shape.trim()
      : opening.type;

    const touchesFloorCandidate = typeof opening.touchesFloor === "boolean"
      ? opening.touchesFloor
      : opening.type === "door" || opening.type === "closet" || opening.type === "archway";

    const touchesCeilingCandidate = typeof opening.touchesCeiling === "boolean"
      ? opening.touchesCeiling
      : false;

    const approxCountCandidate =
      typeof opening.approxCount === "number" && Number.isFinite(opening.approxCount) && opening.approxCount >= 0
        ? opening.approxCount
        : 1;

    const structuralClassCandidate =
      opening.structuralClass === "circulation" ||
      opening.structuralClass === "storage" ||
      opening.structuralClass === "exterior" ||
      opening.structuralClass === "unknown"
        ? opening.structuralClass
        : deriveStructuralClass({
            type: opening.type,
            touchesFloor: touchesFloorCandidate,
            touchesCeiling: touchesCeilingCandidate,
          });

    const verticalBandCandidate =
      typeof opening.verticalBand === "string" && isVerticalBand(opening.verticalBand)
        ? opening.verticalBand
        : deriveVerticalBand({
            touchesFloor: touchesFloorCandidate,
            touchesCeiling: touchesCeilingCandidate,
          });

    const widthBandCandidate =
      typeof opening.widthBand === "string" && isWidthBand(opening.widthBand)
        ? opening.widthBand
        : deriveWidthBand({
            type: opening.type,
            shape: shapeCandidate,
            approxCount: approxCountCandidate,
          });

    const approxAspectRatioCandidate =
      typeof opening.approxAspectRatio === "number" && Number.isFinite(opening.approxAspectRatio)
        ? opening.approxAspectRatio
        : deriveApproxAspectRatio({
            type: opening.type,
            shape: shapeCandidate,
          });

    const confidenceCandidate =
      typeof opening.confidence === "number" && Number.isFinite(opening.confidence)
        ? Math.max(0, Math.min(1, opening.confidence))
        : 0.85;

    return {
      id: opening.id,
      type: opening.type,
      structuralClass: structuralClassCandidate,
      wallIndex: wallIndexCandidate,
      horizontalBand: horizontalBandCandidate,
      verticalBand: verticalBandCandidate,
      widthBand: widthBandCandidate,
      approxAspectRatio: approxAspectRatioCandidate,
      confidence: confidenceCandidate,

      wallPosition: wallPositionCandidate,
      relativeHorizontalPosition: relativeHorizontalCandidate,
      shape: shapeCandidate,
      touchesFloor: touchesFloorCandidate,
      touchesCeiling: touchesCeilingCandidate,
      approxCount: approxCountCandidate,
    };
  });

  const uniqueWalls = new Set<number>(openings.map((o) => o.wallIndex));
  const wallCountFromInput = typeof input.wallCount === "number" && Number.isFinite(input.wallCount)
    ? Math.max(1, Math.min(4, Math.round(input.wallCount)))
    : uniqueWalls.size;

  return {
    cameraOrientation: typeof input.cameraOrientation === "string" ? input.cameraOrientation : undefined,
    openings,
    wallCount: wallCountFromInput,
  };
}

function validateOpeningValidationResult(input: any, baseline: StructuralBaseline): OpeningValidationResult {
  if (!input || typeof input !== "object") {
    throw new Error("Opening validation result must be an object");
  }
  if (!Array.isArray(input.results)) {
    throw new Error("Opening validation result results must be an array");
  }

  const baselineIds = new Set(baseline.openings.map((o) => o.id));

  const results = input.results.map((item: any, index: number) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Invalid opening validation item at index ${index}`);
    }
    if (typeof item.id !== "string" || !item.id.trim()) {
      throw new Error(`Opening validation id is required at index ${index}`);
    }
    if (!baselineIds.has(item.id)) {
      throw new Error(`Opening validation id not found in baseline: ${item.id}`);
    }
    if (typeof item.present !== "boolean") {
      throw new Error(`present must be boolean at index ${index}`);
    }
    if (typeof item.sealed !== "boolean") {
      throw new Error(`sealed must be boolean at index ${index}`);
    }
    if (typeof item.relocated !== "boolean") {
      throw new Error(`relocated must be boolean at index ${index}`);
    }
    if (typeof item.outOfFrame !== "boolean") {
      throw new Error(`outOfFrame must be boolean at index ${index}`);
    }
    if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)) {
      throw new Error(`confidence must be a finite number at index ${index}`);
    }

    return {
      id: item.id,
      present: item.present,
      sealed: item.sealed,
      relocated: item.relocated,
      outOfFrame: item.outOfFrame,
      confidence: Math.max(0, Math.min(1, item.confidence)),
    };
  });

  const missingIds = baseline.openings
    .map((opening) => opening.id)
    .filter((openingId) => !results.some((item) => item.id === openingId));

  if (missingIds.length > 0) {
    throw new Error(`Opening validation missing IDs: ${missingIds.join(", ")}`);
  }

  if (!input.summary || typeof input.summary !== "object") {
    throw new Error("Opening validation summary must be an object");
  }
  if (typeof input.summary.openingRemoved !== "boolean") {
    throw new Error("openingRemoved must be boolean in summary");
  }
  if (typeof input.summary.openingRelocated !== "boolean") {
    throw new Error("openingRelocated must be boolean in summary");
  }
  if (typeof input.summary.openingResized !== "boolean") {
    throw new Error("openingResized must be boolean in summary");
  }
  if (typeof input.summary.openingClassMismatch !== "boolean") {
    throw new Error("openingClassMismatch must be boolean in summary");
  }
  if (typeof input.summary.openingBandMismatch !== "boolean") {
    throw new Error("openingBandMismatch must be boolean in summary");
  }
  if (!Array.isArray(input.summary.outOfFrameOpenings)) {
    throw new Error("outOfFrameOpenings must be an array in summary");
  }
  if (typeof input.summary.confidence !== "number" || !Number.isFinite(input.summary.confidence)) {
    throw new Error("summary confidence must be a finite number");
  }

  const summary = {
    openingRemoved: input.summary.openingRemoved === true || results.some((item) => item.sealed === true && item.outOfFrame === false),
    openingSealed: results.some((item) => item.sealed === true),
    openingRelocated: input.summary.openingRelocated === true || results.some((item) => item.relocated === true),
    openingResized: input.summary.openingResized === true,
    openingClassMismatch: input.summary?.openingClassMismatch === true,
    openingBandMismatch: input.summary.openingBandMismatch === true,
    outOfFrameOpenings: input.summary.outOfFrameOpenings.filter((openingId: any) => typeof openingId === "string"),
    confidence: Math.max(0, Math.min(1, input.summary.confidence)),
  };

  return { results, summary, detectedOpenings: [] };
}

export async function extractStructuralBaseline(imageUrl: string): Promise<StructuralBaseline> {
  const ai = getGeminiClient();
  const image = toBase64(imageUrl);

  const response = await (ai as any).models.generateContent({
    model: OPENING_VALIDATOR_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: BASELINE_SYSTEM_INSTRUCTION },
          { text: BASELINE_USER_PROMPT },
          { inlineData: { mimeType: image.mime, data: image.data } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      topK: 1,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  } as any);

  const parsed = parseJsonResponse(response);
  return validateStructuralBaseline(parsed);
}

export async function validateOpeningPreservation(
  baseline: StructuralBaseline,
  newImageUrl: string
): Promise<OpeningValidationResult> {
  const ai = getGeminiClient();
  const image = toBase64(newImageUrl);

  const userPrompt = `You are given:

1) Structural baseline JSON from the original image.
2) A new generated image.

  STRUCTURAL BASELINE OPENINGS:

  ${baseline.openings.map((o) => `
  ID: ${o.id}
  Type: ${o.type}
  Structural Class: ${o.structuralClass}
  Wall Index: ${o.wallIndex}
  Horizontal Band: ${o.horizontalBand}
  Vertical Band: ${o.verticalBand}
  Width Band: ${o.widthBand}
  `).join("\n")}

  VALIDATION RULES:

  For each baseline opening:
  1) It must still exist.
  2) It must remain on the same Wall Index.
  3) It must remain within the same Horizontal Band.
  4) It must remain within the same Vertical Band.
  5) It must retain the same Structural Class.
  6) It must not be resized materially (width band mismatch).
  7) It must not be converted to flat wall.
  8) It must not be replaced by a different opening elsewhere.

  RELOCATION RULE:
  If an opening of the same structural class appears on a different wall,
  and the original wall location no longer contains that opening,
  this is a relocation and must be marked as violation.

  OUT-OF-FRAME RULE:
  If the opening's wall region is not visible due to cropping,
  mark that opening ID in outOfFrameOpenings.
  Do NOT mark it as removed unless sealing is visible.

Return JSON in this schema:

{
    "openingRemoved": boolean,
    "openingRelocated": boolean,
    "openingResized": boolean,
    "openingClassMismatch": boolean,
    "openingBandMismatch": boolean,
    "outOfFrameOpenings": string[],
    "confidence": number,
    "results": [
      {
        "id": string,
        "present": boolean,
        "sealed": boolean,
        "relocated": boolean,
        "outOfFrame": boolean,
        "confidence": number
      }
    ]
}

Baseline JSON:
${JSON.stringify(baseline)}`;

  const response = await (ai as any).models.generateContent({
    model: OPENING_VALIDATOR_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: OPENING_VALIDATION_SYSTEM_INSTRUCTION },
          { text: userPrompt },
          { inlineData: { mimeType: image.mime, data: image.data } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      topK: 1,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  } as any);

  const parsed = parseJsonResponse(response);
  const normalized = {
    ...parsed,
    summary: {
      openingRemoved: parsed?.openingRemoved === true,
      openingSealed: parsed?.openingRemoved === true,
      openingRelocated: parsed?.openingRelocated === true,
      openingResized: parsed?.openingResized === true,
      openingClassMismatch: parsed?.openingClassMismatch === true,
      openingBandMismatch: parsed?.openingBandMismatch === true,
      outOfFrameOpenings: Array.isArray(parsed?.outOfFrameOpenings) ? parsed.outOfFrameOpenings : [],
      confidence: typeof parsed?.confidence === "number" ? parsed.confidence : 0,
    },
    results: Array.isArray(parsed?.results) ? parsed.results : [],
  };

  const validated = validateOpeningValidationResult(normalized, baseline);

  try {
    const detected = await extractStructuralBaseline(newImageUrl);
    validated.detectedOpenings = detected.openings;
  } catch {
    validated.detectedOpenings = [];
  }

  return validated;
}

export function detectRelocation(
  baseline: StructuralBaseline,
  enhancedDetected: StructuralOpening[]
): boolean {
  for (const base of baseline.openings) {
    const sameClassMatches = enhancedDetected.filter(
      (opening) => opening.structuralClass === base.structuralClass
    );

    if (!sameClassMatches.length) continue;

    const exactWallMatch = sameClassMatches.find(
      (opening) => opening.wallIndex === base.wallIndex
    );

    if (!exactWallMatch) {
      return true;
    }
  }

  return false;
}
