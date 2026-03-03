import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

export type StructuralOpeningType = "window" | "door" | "closet" | "archway";
export type StructuralClass = "circulation" | "storage" | "exterior" | "unknown";
export type WallPosition = "left_wall" | "right_wall" | "far_wall" | "near_wall";
export type RelativeHorizontalPosition = "left_third" | "center" | "right_third";

export type StructuralOpening = {
  id: string;
  type: StructuralOpeningType;
  wallPosition: WallPosition;
  relativeHorizontalPosition: RelativeHorizontalPosition;
  shape: string;
  touchesFloor: boolean;
  touchesCeiling: boolean;
  approxCount: number;
  structuralClass: StructuralClass;
};

export type StructuralBaseline = {
  cameraOrientation: string;
  openings: StructuralOpening[];
};

export type OpeningValidationResult = {
  results: OpeningResult[];
  summary: {
    openingRemoved: boolean;
    openingSealed: boolean;
    openingRelocated: boolean;
    openingClassMismatch: boolean;
  };
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
  "cameraOrientation": string,
  "openings": [
    {
      "id": string,
      "type": "window" | "door" | "closet" | "archway",
      "wallPosition": "left_wall" | "right_wall" | "far_wall" | "near_wall",
      "relativeHorizontalPosition": "left_third" | "center" | "right_third",
      "shape": string,
      "touchesFloor": boolean,
      "touchesCeiling": boolean,
      "approxCount": number,
      "structuralClass": "circulation" | "storage" | "exterior" | "unknown"
    }
  ]
}

Rules:
- Assign deterministic IDs like W1, W2, D1, C1, A1.
- wallPosition is based on viewer perspective.
- relativeHorizontalPosition is relative to that wall.
- shape is descriptive but short (e.g., rectangular, double_panel, sliding).
- approxCount should usually be 1 unless a grouped unit.

Return only valid JSON.`;

const OPENING_VALIDATION_SYSTEM_INSTRUCTION = `You are a structural preservation validator.

Your job is to determine whether permanent architectural openings from a baseline image still physically exist in a new image.

You must distinguish between:
- Removed / Sealed
- Relocated
- Still Present
- Out of Frame (cropped)

Definitions

An opening is considered removed or sealed if:
- It is replaced by flat wall
- The wall surface is continuous where the opening used to be
- The opening frame is gone
- The cavity depth is gone
- It is fully infilled

An opening is considered relocated if:
- It exists but in a materially different wall position
- It has shifted significantly along the wall

An opening is considered outOfFrame if:
- It is not visible in the new image,
- AND there is no visible flat wall infill where it previously existed,
- AND the absence is consistent with camera zoom, crop, or reframing.

Furniture blocking does NOT count as removal.
Curtains do NOT count as removal.
Doors open vs closed does NOT count as removal.

If uncertain between:
- sealed vs outOfFrame

You must prefer:
- sealed = true

Only use outOfFrame if there is no visible infill evidence.

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

  if (typeof input.cameraOrientation !== "string" || !input.cameraOrientation.trim()) {
    throw new Error("Structural baseline cameraOrientation is required");
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
    if (!isWallPosition(opening.wallPosition)) {
      throw new Error(`Opening wallPosition must be one of left_wall|right_wall|far_wall|near_wall at index ${index}`);
    }
    if (!isRelativeHorizontalPosition(opening.relativeHorizontalPosition)) {
      throw new Error(`Opening relativeHorizontalPosition must be one of left_third|center|right_third at index ${index}`);
    }
    if (typeof opening.shape !== "string" || !opening.shape.trim()) {
      throw new Error(`Opening shape is required at index ${index}`);
    }
    if (typeof opening.touchesFloor !== "boolean") {
      throw new Error(`Opening touchesFloor must be boolean at index ${index}`);
    }
    if (typeof opening.touchesCeiling !== "boolean") {
      throw new Error(`Opening touchesCeiling must be boolean at index ${index}`);
    }
    if (typeof opening.approxCount !== "number" || !Number.isFinite(opening.approxCount) || opening.approxCount < 0) {
      throw new Error(`Opening approxCount must be a non-negative number at index ${index}`);
    }

    const normalizedOpening = {
      id: opening.id,
      type: opening.type,
      wallPosition: opening.wallPosition,
      relativeHorizontalPosition: opening.relativeHorizontalPosition,
      shape: opening.shape,
      touchesFloor: opening.touchesFloor,
      touchesCeiling: opening.touchesCeiling,
      approxCount: opening.approxCount,
    };

    return {
      ...normalizedOpening,
      structuralClass: deriveStructuralClass(normalizedOpening),
    };
  });

  return {
    cameraOrientation: input.cameraOrientation,
    openings,
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
  if (typeof input.summary.openingClassMismatch !== "boolean") {
    throw new Error("openingClassMismatch must be boolean in summary");
  }

  const summary = {
    openingRemoved: results.some((item) => item.sealed === true && item.outOfFrame === false),
    openingSealed: results.some((item) => item.sealed === true),
    openingRelocated: results.some((item) => item.relocated === true),
    openingClassMismatch: input.summary?.openingClassMismatch === true,
  };

  return { results, summary };
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

For each opening in the baseline:
- Determine whether it is still physically present.
- Determine whether it has been sealed or removed.
- Determine whether it has been relocated.
- Determine whether it is out of frame due to camera crop.
- Determine whether its functional structural class matches baseline structuralClass.
- Provide confidence 0.0–1.0.

Return JSON in this schema:

{
  "results": [
    {
      "id": string,
      "present": boolean,
      "sealed": boolean,
      "relocated": boolean,
      "outOfFrame": boolean,
      "confidence": number
    }
  ],
  "summary": {
    "openingRemoved": boolean,
    "openingSealed": boolean,
    "openingRelocated": boolean,
    "openingClassMismatch": boolean
  }
}

Definitions:
- present = opening frame and cavity still exist.
- sealed = replaced with continuous wall.
- relocated = moved materially from baseline position.
- outOfFrame = not visible but no infill evidence.
- openingRemoved = true if any sealed=true AND outOfFrame=false.
- openingSealed = true if any sealed=true.
- openingRelocated = true if any relocated=true.
- openingClassMismatch = true if any opening no longer matches baseline structuralClass.

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
  return validateOpeningValidationResult(parsed, baseline);
}
