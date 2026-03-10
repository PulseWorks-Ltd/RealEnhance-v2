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
export type WallCoverageBand = "5-10" | "10-20" | "20-40" | "40-60" | "60+";
export type OpeningOrientation = "portrait" | "landscape" | "square";
export type PaneStructure = "single_fixed" | "double_fixed" | "fixed_plus_opening" | "sliding_panel" | "multi_pane_grid" | "unknown";
export type HeightClass = "standard" | "floor_to_ceiling" | "transom";

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
  wallCoverageBand: WallCoverageBand;
  orientation: OpeningOrientation;
  paneStructure: PaneStructure;
  heightClass: HeightClass;
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
      "wallCoverageBand": "5-10" | "10-20" | "20-40" | "40-60" | "60+",
      "orientation": "portrait" | "landscape" | "square",
      "paneStructure": "single_fixed" | "double_fixed" | "fixed_plus_opening" | "sliding_panel" | "multi_pane_grid" | "unknown",
      "heightClass": "standard" | "floor_to_ceiling" | "transom",
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
- wallCoverageBand is approximate percent of the wall occupied by the opening (not image area).
- orientation should be derived from opening shape (portrait, landscape, square).
- paneStructure should describe visible pane layout; if uncertain return "unknown".
- heightClass should describe vertical extent as standard, floor_to_ceiling, or transom.
- Estimate wall coverage in rough bands: 5-10, 10-20, 20-40, 40-60, 60+.
- confidence is 0..1.

Return only valid JSON.`;

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

function isWallCoverageBand(value: string): value is WallCoverageBand {
  return value === "5-10" || value === "10-20" || value === "20-40" || value === "40-60" || value === "60+";
}

function isOpeningOrientation(value: string): value is OpeningOrientation {
  return value === "portrait" || value === "landscape" || value === "square";
}

function isPaneStructure(value: string): value is PaneStructure {
  return (
    value === "single_fixed" ||
    value === "double_fixed" ||
    value === "fixed_plus_opening" ||
    value === "sliding_panel" ||
    value === "multi_pane_grid" ||
    value === "unknown"
  );
}

function isHeightClass(value: string): value is HeightClass {
  return value === "standard" || value === "floor_to_ceiling" || value === "transom";
}

function normalizePaneStructure(value: unknown): PaneStructure {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw === "single_fixed" || raw === "single pane" || raw === "single") return "single_fixed";
  if (raw === "double_fixed" || raw === "double pane" || raw === "double") return "double_fixed";
  if (raw === "fixed_plus_opening" || raw === "fixed+opening") return "fixed_plus_opening";
  if (raw === "sliding_panel" || raw === "sliding" || raw === "slider") return "sliding_panel";
  if (raw === "multi_pane_grid" || raw === "grid" || raw === "multi pane") return "multi_pane_grid";
  return "unknown";
}

function deriveOrientation(aspectRatio: number): OpeningOrientation {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return "square";
  if (aspectRatio >= 1.15) return "landscape";
  if (aspectRatio <= 0.85) return "portrait";
  return "square";
}

function deriveWallCoverageBand(areaPct: number): WallCoverageBand {
  const area = Number.isFinite(areaPct) ? Math.max(0, areaPct) : 0;
  if (area < 10) return "5-10";
  if (area < 20) return "10-20";
  if (area < 40) return "20-40";
  if (area < 60) return "40-60";
  return "60+";
}

function deriveHeightClass(verticalBand: VerticalBand): HeightClass {
  if (verticalBand === "full_height") return "floor_to_ceiling";
  if (verticalBand === "ceiling_zone") return "transom";
  return "standard";
}

function wallCoverageBandIndex(value: WallCoverageBand): number {
  if (value === "5-10") return 0;
  if (value === "10-20") return 1;
  if (value === "20-40") return 2;
  if (value === "40-60") return 3;
  return 4;
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

    const wallCoverageBandCandidate =
      typeof opening.wallCoverageBand === "string" && isWallCoverageBand(opening.wallCoverageBand)
        ? opening.wallCoverageBand
        : deriveWallCoverageBand(areaPctCandidate);

    const orientationCandidate =
      typeof opening.orientation === "string" && isOpeningOrientation(opening.orientation)
        ? opening.orientation
        : deriveOrientation(aspectRatioCandidate);

    const paneStructureCandidate =
      typeof opening.paneStructure === "string" && isPaneStructure(opening.paneStructure)
        ? opening.paneStructure
        : normalizePaneStructure(opening.paneStructure);

    const heightClassCandidate =
      typeof opening.heightClass === "string" && isHeightClass(opening.heightClass)
        ? opening.heightClass
        : deriveHeightClass(verticalBandCandidate);

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
      wallCoverageBand: wallCoverageBandCandidate,
      orientation: orientationCandidate,
      paneStructure: paneStructureCandidate,
      heightClass: heightClassCandidate,
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
  const baseline = validateStructuralBaseline(parsed);
  console.log("[OPENING_BASELINE]", JSON.stringify({
    openings: baseline.openings.map((opening) => ({
      id: opening.id,
      type: opening.type,
      wallIndex: opening.wallIndex,
      horizontalBand: opening.horizontalBand,
      verticalBand: opening.verticalBand,
      wallCoverageBand: opening.wallCoverageBand,
      orientation: opening.orientation,
      paneStructure: opening.paneStructure,
      heightClass: opening.heightClass,
      confidence: opening.confidence,
    })),
    wallCount: baseline.wallCount,
  }));
  return baseline;
}

export async function validateOpeningPreservation(
  baseline: StructuralBaseline,
  newImageUrl: string
): Promise<OpeningValidationResult> {
  const detected = await extractStructuralBaseline(newImageUrl);

  const allowedOccluders = new Set([
    "bed",
    "dresser",
    "wardrobe",
    "cabinet",
    "sofa",
    "bookshelf",
    "desk",
    "nightstand",
  ]);

  const openingResults: OpeningResult[] = [];
  const outOfFrameOpenings: string[] = [];
  let openingRemoved = false;
  let openingRelocated = false;
  let openingResized = false;
  let openingClassMismatch = false;
  let openingBandMismatch = false;
  let maxAreaDelta = 0;
  let maxAspectDelta = 0;

  for (const baseOpening of baseline.openings) {
    const directMatch = detected.openings.find((candidate) => candidate.id === baseOpening.id);
    const fallbackMatch = detected.openings.find(
      (candidate) =>
        candidate.type === baseOpening.type &&
        candidate.wallIndex === baseOpening.wallIndex &&
        candidate.horizontalBand === baseOpening.horizontalBand
    );

    const match = directMatch || fallbackMatch;

    if (!match) {
      openingRemoved = true;
      const likelyFloorStandingOcclusion =
        (baseOpening.verticalBand === "floor_zone" || baseOpening.verticalBand === "full_height") &&
        allowedOccluders.size > 0;

      const status = likelyFloorStandingOcclusion ? "OCCLUDED" : "MISSING";
      const reason = likelyFloorStandingOcclusion
        ? "missing_opening_no_floor_occluder_confirmation"
        : "missing_opening";

      console.log(`[OPENING_VALIDATION] baseline_id=${baseOpening.id} status=${status} reason=${reason}`);

      openingResults.push({
        id: baseOpening.id,
        present: false,
        sealed: true,
        relocated: false,
        outOfFrame: false,
        confidence: 0.99,
      });
      continue;
    }

    const invariantReasons: string[] = [];

    if (match.wallIndex !== baseOpening.wallIndex) {
      openingRelocated = true;
      invariantReasons.push("wall_index_changed");
    }

    if (match.horizontalBand !== baseOpening.horizontalBand) {
      openingBandMismatch = true;
      invariantReasons.push("horizontal_band_changed");
    }

    if (match.verticalBand !== baseOpening.verticalBand) {
      openingBandMismatch = true;
      invariantReasons.push("vertical_band_changed");
    }

    const baseCoverageIdx = wallCoverageBandIndex(baseOpening.wallCoverageBand);
    const matchCoverageIdx = wallCoverageBandIndex(match.wallCoverageBand);
    if (Math.abs(matchCoverageIdx - baseCoverageIdx) > 1) {
      openingResized = true;
      invariantReasons.push("wall_coverage_band_changed_gt_one");
    }

    if (
      baseOpening.paneStructure !== "unknown" &&
      match.paneStructure !== "unknown" &&
      baseOpening.paneStructure !== match.paneStructure
    ) {
      openingClassMismatch = true;
      openingResized = true;
      invariantReasons.push("pane_structure_changed");
    }

    if (baseOpening.orientation !== match.orientation) {
      openingResized = true;
      invariantReasons.push("orientation_changed");
    }

    const baseArea = Math.max(0.01, Number(baseOpening.area_pct || 0));
    const detectedArea = Math.max(0.01, Number(match.area_pct || 0));
    const areaDelta = Math.abs((detectedArea - baseArea) / baseArea);
    maxAreaDelta = Math.max(maxAreaDelta, areaDelta);

    const baseAspect = Math.max(0.01, Number(baseOpening.aspect_ratio || baseOpening.approxAspectRatio || 0));
    const detectedAspect = Math.max(0.01, Number(match.aspect_ratio || match.approxAspectRatio || 0));
    const aspectDelta = Math.abs((detectedAspect - baseAspect) / baseAspect);
    maxAspectDelta = Math.max(maxAspectDelta, aspectDelta);

    const altered = invariantReasons.length > 0;
    console.log(
      `[OPENING_VALIDATION] baseline_id=${baseOpening.id} status=${altered ? "ALTERED" : "PRESERVED"} reason=${
        altered ? invariantReasons.join("|") : "none"
      }`
    );

    openingResults.push({
      id: baseOpening.id,
      present: !altered,
      sealed: altered,
      relocated: match.wallIndex !== baseOpening.wallIndex,
      outOfFrame: false,
      confidence: Math.min(baseOpening.confidence, match.confidence),
    });
  }

  const summary = {
    openingRemoved,
    openingSealed: openingRemoved || openingResized || openingBandMismatch || openingClassMismatch,
    openingRelocated,
    openingResized,
    openingClassMismatch,
    openingBandMismatch,
    outOfFrameOpenings,
    semanticOpeningAreaDeltaPct: maxAreaDelta,
    semanticOpeningAspectRatioDelta: maxAspectDelta,
    confidence: openingResults.length
      ? Number((openingResults.reduce((sum, row) => sum + row.confidence, 0) / openingResults.length).toFixed(3))
      : 1,
  };

  return {
    results: openingResults,
    summary,
    detectedOpenings: detected.openings,
  };
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
