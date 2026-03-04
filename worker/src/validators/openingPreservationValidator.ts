import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

export type StructuralOpeningType = "window" | "door" | "closet_door" | "walkthrough";
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
  bbox: [number, number, number, number];
  area_pct: number;
  aspect_ratio: number;
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
    semanticOpeningAreaDeltaPct?: number;
    semanticOpeningAspectRatioDelta?: number;
    confidence: number;
  };
  detectedOpenings: StructuralOpening[];
};

export type OpeningValidationSummary = OpeningValidationResult["summary"];

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
      "type": "window" | "door" | "closet_door" | "walkthrough",
      "bbox": [x1, y1, x2, y2],
      "area_pct": number,
      "aspect_ratio": number,
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
- bbox must be normalized to image dimensions (0..1).
- area_pct must represent % of image area occupied by the opening (0..100).
- aspect_ratio must be width/height for the opening geometry.
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
  return value === "window" || value === "door" || value === "closet_door" || value === "walkthrough";
}

function normalizeOpeningType(value: unknown): StructuralOpeningType | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "window") return "window";
  if (raw === "door" || raw === "exterior_door" || raw === "interior_door") return "door";
  if (raw === "closet" || raw === "closet_door" || raw === "closet door" || raw === "wardrobe_door" || raw === "wardrobe sliding door" || raw === "sliding_closet_panel") return "closet_door";
  if (raw === "archway" || raw === "walkthrough" || raw === "walk-through" || raw === "walk_through" || raw === "pass_through" || raw === "passthrough") return "walkthrough";
  return null;
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
  if (shape.includes("narrow") || opening.type === "closet_door") return "narrow";
  return "single";
}

function deriveApproxAspectRatio(opening: Pick<StructuralOpening, "type" | "shape">): number {
  const shape = (opening.shape || "").toLowerCase();
  if (shape.includes("square")) return 1;
  if (opening.type === "window") return 1.4;
  if (opening.type === "door" || opening.type === "closet_door") return 0.5;
  if (opening.type === "walkthrough") return 0.8;
  return 1;
}

export function deriveStructuralClass(opening: Pick<StructuralOpening, "type" | "touchesFloor" | "touchesCeiling">): StructuralClass {
  if (opening.type === "window") return "exterior";
  if (opening.type === "closet_door") return "storage";
  if (opening.type === "door" || opening.type === "walkthrough") return "circulation";
  return "unknown";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeBbox(
  input: any,
  horizontalBand: HorizontalBand,
  verticalBand: VerticalBand
): [number, number, number, number] {
  const arr = Array.isArray(input?.bbox) ? input.bbox : null;
  if (arr && arr.length === 4 && arr.every((v: any) => Number.isFinite(Number(v)))) {
    let x1 = clamp01(Number(arr[0]));
    let y1 = clamp01(Number(arr[1]));
    let x2 = clamp01(Number(arr[2]));
    let y2 = clamp01(Number(arr[3]));
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];
    if (x2 - x1 < 0.01) x2 = clamp01(x1 + 0.01);
    if (y2 - y1 < 0.01) y2 = clamp01(y1 + 0.01);
    return [x1, y1, x2, y2];
  }

  const [x1, x2] = horizontalBand === "left_third"
    ? [0.05, 0.35]
    : horizontalBand === "right_third"
      ? [0.65, 0.95]
      : [0.33, 0.67];

  const [y1, y2] = verticalBand === "floor_zone"
    ? [0.45, 0.98]
    : verticalBand === "ceiling_zone"
      ? [0.02, 0.40]
      : verticalBand === "full_height"
        ? [0.02, 0.98]
        : [0.22, 0.80];

  return [x1, y1, x2, y2];
}

function normalizeAreaPct(input: any, bbox: [number, number, number, number]): number {
  const raw = input?.area_pct ?? input?.areaPct;
  if (Number.isFinite(Number(raw))) {
    const numeric = Number(raw);
    const normalized = numeric <= 1 ? numeric * 100 : numeric;
    return Math.max(0, Math.min(100, normalized));
  }
  const bboxArea = Math.max(0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) * 100;
  return Math.max(0, Math.min(100, bboxArea));
}

function normalizeAspectRatio(input: any, bbox: [number, number, number, number], fallback: number): number {
  const raw = input?.aspect_ratio ?? input?.aspectRatio ?? input?.approxAspectRatio;
  if (Number.isFinite(Number(raw)) && Number(raw) > 0) {
    return Number(raw);
  }
  const width = Math.max(0.01, bbox[2] - bbox[0]);
  const height = Math.max(0.01, bbox[3] - bbox[1]);
  const derived = width / height;
  return Number.isFinite(derived) && derived > 0 ? derived : fallback;
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
    const normalizedType = normalizeOpeningType(opening.type);
    if (!normalizedType || !isOpeningType(normalizedType)) {
      throw new Error(`Opening type must be one of window|door|closet_door|walkthrough at index ${index}`);
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
      : normalizedType === "door" || normalizedType === "closet_door" || normalizedType === "walkthrough";

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
            type: normalizedType,
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
            type: normalizedType,
            shape: shapeCandidate,
            approxCount: approxCountCandidate,
          });

    const approxAspectRatioCandidate =
      typeof opening.approxAspectRatio === "number" && Number.isFinite(opening.approxAspectRatio)
        ? opening.approxAspectRatio
        : deriveApproxAspectRatio({
            type: normalizedType,
            shape: shapeCandidate,
          });

    const bboxCandidate = normalizeBbox(opening, horizontalBandCandidate, verticalBandCandidate);
    const areaPctCandidate = normalizeAreaPct(opening, bboxCandidate);
    const aspectRatioCandidate = normalizeAspectRatio(opening, bboxCandidate, approxAspectRatioCandidate);

    const confidenceCandidate =
      typeof opening.confidence === "number" && Number.isFinite(opening.confidence)
        ? Math.max(0, Math.min(1, opening.confidence))
        : 0.85;

    return {
      id: opening.id,
      type: normalizedType,
      bbox: bboxCandidate,
      area_pct: areaPctCandidate,
      aspect_ratio: aspectRatioCandidate,
      structuralClass: structuralClassCandidate,
      wallIndex: wallIndexCandidate,
      horizontalBand: horizontalBandCandidate,
      verticalBand: verticalBandCandidate,
      widthBand: widthBandCandidate,
      approxAspectRatio: aspectRatioCandidate,
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
    semanticOpeningAreaDeltaPct:
      typeof input.summary.semanticOpeningAreaDeltaPct === "number" && Number.isFinite(input.summary.semanticOpeningAreaDeltaPct)
        ? Math.abs(input.summary.semanticOpeningAreaDeltaPct)
        : undefined,
    semanticOpeningAspectRatioDelta:
      typeof input.summary.semanticOpeningAspectRatioDelta === "number" && Number.isFinite(input.summary.semanticOpeningAspectRatioDelta)
        ? Math.abs(input.summary.semanticOpeningAspectRatioDelta)
        : undefined,
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
    3) It must remain approximately within the same horizontal region.
      Minor adjacent band shifts due to perspective normalization are allowed.
    4) It must remain approximately within the same vertical region.
      Minor adjacent band shifts due to perspective normalization are allowed.
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

    let maxAreaDelta = 0;
    let maxAspectDelta = 0;

    const safeType = (type: StructuralOpeningType): StructuralOpeningType => normalizeOpeningType(type) || type;

    for (const baseOpening of baseline.openings) {
      const baseType = safeType(baseOpening.type);
      const directMatch = detected.openings.find((candidate) => candidate.id === baseOpening.id);
      const semanticMatch = detected.openings.find((candidate) => {
        const candidateType = safeType(candidate.type);
        const sameType = candidateType === baseType;
        const sameWall = candidate.wallIndex === baseOpening.wallIndex;
        const sameBand = candidate.horizontalBand === baseOpening.horizontalBand;
        return sameType && sameWall && sameBand;
      });

      const match = directMatch || semanticMatch;
      if (!match) {
        maxAreaDelta = Math.max(maxAreaDelta, 1);
        maxAspectDelta = Math.max(maxAspectDelta, 1);
        continue;
      }

      const baseArea = Math.max(0.01, Number(baseOpening.area_pct || 0));
      const detectedArea = Math.max(0.01, Number(match.area_pct || 0));
      const areaDelta = Math.abs((detectedArea - baseArea) / baseArea);

      const baseAspect = Math.max(0.01, Number(baseOpening.aspect_ratio || baseOpening.approxAspectRatio || 0));
      const detectedAspect = Math.max(0.01, Number(match.aspect_ratio || match.approxAspectRatio || 0));
      const aspectDelta = Math.abs((detectedAspect - baseAspect) / baseAspect);

      maxAreaDelta = Math.max(maxAreaDelta, areaDelta);
      maxAspectDelta = Math.max(maxAspectDelta, aspectDelta);
    }

    validated.summary.semanticOpeningAreaDeltaPct = maxAreaDelta;
    validated.summary.semanticOpeningAspectRatioDelta = maxAspectDelta;
  } catch {
    validated.detectedOpenings = [];
  }

  return validated;
}

export function shouldHardFailOpening(
  summary: OpeningValidationSummary,
  opts?: {
    relocationDetected?: boolean;
    invariantStructuralDriftDetected?: boolean;
  }
): boolean {
  if (summary.openingRemoved) return true;
  if (summary.openingSealed) return true;
  if (summary.openingRelocated) return true;
  if (summary.openingClassMismatch) return true;
  if (opts?.relocationDetected === true) return true;

  const highConfidence = summary.confidence >= 0.9;
  if (!highConfidence) return false;

  const spatialSignals = [
    summary.openingBandMismatch,
    summary.openingResized,
  ].filter(Boolean).length;

  if (spatialSignals >= 2) return true;
  if ((opts?.invariantStructuralDriftDetected === true) && spatialSignals >= 1) return true;

  return false;
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
