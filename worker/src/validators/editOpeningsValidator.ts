import sharp from "sharp";
import { getGeminiClient } from "../ai/gemini";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { nLog } from "../logger";
import {
  extractStructuralBaseline,
  type StructuralOpening,
} from "./openingPreservationValidator";

export type EditOpeningsComparedAgainst = "stage1a" | "edit_input";

type NormalizedBox = [number, number, number, number];

type GeminiVerdict = {
  passed: boolean;
  reason: string;
  details?: string;
};

export type EditOpeningsValidationSummary = {
  validator: "edit_openings";
  passed: boolean;
  comparedAgainst: EditOpeningsComparedAgainst;
  reason: string;
  details?: string;
  evaluatedOpeningsCount: number;
  evaluatedOpenings: Array<{
    id: string;
    type: string;
    bbox: NormalizedBox;
  }>;
  maskRegion: {
    bbox: NormalizedBox;
    expandedBbox: NormalizedBox;
  };
  roi: {
    bbox: NormalizedBox;
    width: number;
    height: number;
  };
  gemini: {
    model: string;
    rawResponse: string;
  };
};

const EDIT_OPENINGS_GEMINI_MODEL = String(process.env.EDIT_OPENINGS_GEMINI_MODEL || "gemini-2.5-flash");
const MASK_MARGIN = Number(process.env.EDIT_OPENINGS_MASK_MARGIN || 0.06);
const ROI_PADDING = Number(process.env.EDIT_OPENINGS_ROI_PADDING || 0.04);

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function toNormBbox(b: NormalizedBox): NormalizedBox {
  return [clamp01(b[0]), clamp01(b[1]), clamp01(b[2]), clamp01(b[3])];
}

function intersects(a: NormalizedBox, b: NormalizedBox): boolean {
  return !(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3]);
}

function expand(b: NormalizedBox, margin: number): NormalizedBox {
  return toNormBbox([b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin]);
}

function union(bboxes: NormalizedBox[]): NormalizedBox {
  if (bboxes.length === 0) return [0, 0, 1, 1];
  let x1 = 1;
  let y1 = 1;
  let x2 = 0;
  let y2 = 0;
  for (const b of bboxes) {
    x1 = Math.min(x1, b[0]);
    y1 = Math.min(y1, b[1]);
    x2 = Math.max(x2, b[2]);
    y2 = Math.max(y2, b[3]);
  }
  return toNormBbox([x1, y1, x2, y2]);
}

function extractJson(text: string): GeminiVerdict {
  const cleaned = String(text || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  const parsed = JSON.parse(jsonCandidate || "{}");
  const passed = parsed?.passed === true;
  const reason = typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
    ? parsed.reason.trim().slice(0, 120)
    : passed
      ? "openings_preserved"
      : "opening_walled_over";
  const details = typeof parsed?.details === "string" && parsed.details.trim().length > 0
    ? parsed.details.trim().slice(0, 240)
    : undefined;
  return { passed, reason, details };
}

async function maskToBbox(mask: Buffer, width: number, height: number): Promise<NormalizedBox | null> {
  const maskRaw = await sharp(mask)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = maskRaw.data[y * width + x] ?? 0;
      if (v <= 127) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  return toNormBbox([
    minX / width,
    minY / height,
    (maxX + 1) / width,
    (maxY + 1) / height,
  ]);
}

function openingKind(opening: StructuralOpening): "window" | "door" | null {
  if (opening.type === "window") return "window";
  if (opening.type === "door") return "door";
  return null;
}

function toPixels(bbox: NormalizedBox, width: number, height: number): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.floor(bbox[0] * width));
  const top = Math.max(0, Math.floor(bbox[1] * height));
  const right = Math.min(width, Math.ceil(bbox[2] * width));
  const bottom = Math.min(height, Math.ceil(bbox[3] * height));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export async function runEditOpeningsValidator(
  baselineImagePath: string,
  editedImagePath: string,
  mask: Buffer,
  comparedAgainst: EditOpeningsComparedAgainst = "stage1a",
  options?: { jobId?: string; imageId?: string; attempt?: number },
): Promise<EditOpeningsValidationSummary> {
  if (!String(baselineImagePath || "").trim() || !String(editedImagePath || "").trim() || !mask || mask.length === 0) {
    throw new Error("VALIDATION_INPUT_MISSING");
  }

  const baselineMeta = await sharp(baselineImagePath).metadata();
  const width = baselineMeta.width || 0;
  const height = baselineMeta.height || 0;
  if (width <= 0 || height <= 0) {
    throw new Error("edit_openings_validator_failed: invalid_baseline_dimensions");
  }

  const maskBbox = await maskToBbox(mask, width, height);
  if (!maskBbox) {
    return {
      validator: "edit_openings",
      passed: true,
      comparedAgainst,
      reason: "mask_empty",
      evaluatedOpeningsCount: 0,
      evaluatedOpenings: [],
      maskRegion: {
        bbox: [0, 0, 0, 0],
        expandedBbox: [0, 0, 0, 0],
      },
      roi: {
        bbox: [0, 0, 1, 1],
        width,
        height,
      },
      gemini: {
        model: EDIT_OPENINGS_GEMINI_MODEL,
        rawResponse: "{\"passed\":true,\"reason\":\"mask_empty\"}",
      },
    };
  }

  const expandedMaskBbox = expand(maskBbox, MASK_MARGIN);
  const structural = await extractStructuralBaseline(baselineImagePath, {
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: options?.attempt,
  });
  const relevantOpenings = structural.openings.filter((opening) => {
    const kind = openingKind(opening);
    if (!kind) return false;
    const bbox = toNormBbox(opening.bbox as NormalizedBox);
    return intersects(bbox, expandedMaskBbox);
  });

  nLog("[edit-openings-validator] openings_near_mask", {
    count: relevantOpenings.length,
    maskBbox,
    expandedMaskBbox,
    openings: relevantOpenings.map((o) => ({ id: o.id, type: o.type, bbox: o.bbox })),
  });

  if (relevantOpenings.length === 0) {
    return {
      validator: "edit_openings",
      passed: true,
      comparedAgainst,
      reason: "no_openings_near_mask",
      evaluatedOpeningsCount: 0,
      evaluatedOpenings: [],
      maskRegion: {
        bbox: maskBbox,
        expandedBbox: expandedMaskBbox,
      },
      roi: {
        bbox: expandedMaskBbox,
        width,
        height,
      },
      gemini: {
        model: EDIT_OPENINGS_GEMINI_MODEL,
        rawResponse: "{\"passed\":true,\"reason\":\"no_openings_near_mask\"}",
      },
    };
  }

  const openingBoxes = relevantOpenings.map((o) => toNormBbox(o.bbox as NormalizedBox));
  const roiBbox = expand(union([expandedMaskBbox, ...openingBoxes]), ROI_PADDING);
  const roiPx = toPixels(roiBbox, width, height);

  const beforeCrop = await sharp(baselineImagePath)
    .extract(roiPx)
    .webp()
    .toBuffer();

  const afterCrop = await sharp(editedImagePath)
    .resize(width, height, { fit: "fill" })
    .extract(roiPx)
    .webp()
    .toBuffer();

  const ai = getGeminiClient();
  const openingsJson = JSON.stringify(
    relevantOpenings.map((o) => ({ id: o.id, type: o.type, bbox: toNormBbox(o.bbox as NormalizedBox) })),
  );
  const prompt = `You are validating architectural opening preservation for a real-estate image edit.

Compare BEFORE vs AFTER in the provided ROI crop only.

Scope rules:
- Focus ONLY on openings near the mask area.
- Openings to evaluate are listed in BASELINE_OPENINGS_JSON.
- Treat furniture/object occlusion as allowed.
- Partial visibility is allowed.
- FAIL only if an opening that existed before is now walled over or replaced by continuous wall surface.

Return strict JSON only:
{
  "passed": boolean,
  "reason": "openings_preserved" | "opening_walled_over",
  "details": string
}

BASELINE_OPENINGS_JSON:
${openingsJson}`;

  const requestStartedAt = Date.now();
  const response = await (ai as any).models.generateContent({
    model: EDIT_OPENINGS_GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { text: "BEFORE_ROI:" },
          { inlineData: { mimeType: "image/webp", data: beforeCrop.toString("base64") } },
          { text: "AFTER_ROI:" },
          { inlineData: { mimeType: "image/webp", data: afterCrop.toString("base64") } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.2,
      maxOutputTokens: 200,
      responseMimeType: "application/json",
    },
  });
  logGeminiUsage({
    ctx: {
      jobId: options?.jobId || "",
      imageId: options?.imageId || "",
      stage: "validator",
      attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : 1,
    },
    model: EDIT_OPENINGS_GEMINI_MODEL,
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
  });

  const rawResponse = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const verdict = extractJson(rawResponse);

  nLog("[edit-openings-validator] gemini_response", {
    model: EDIT_OPENINGS_GEMINI_MODEL,
    rawResponse,
    verdict,
  });

  const summary: EditOpeningsValidationSummary = {
    validator: "edit_openings",
    passed: verdict.passed,
    comparedAgainst,
    reason: verdict.reason,
    details: verdict.details,
    evaluatedOpeningsCount: relevantOpenings.length,
    evaluatedOpenings: relevantOpenings.map((o) => ({
      id: o.id,
      type: o.type,
      bbox: toNormBbox(o.bbox as NormalizedBox),
    })),
    maskRegion: {
      bbox: maskBbox,
      expandedBbox: expandedMaskBbox,
    },
    roi: {
      bbox: roiBbox,
      width: roiPx.width,
      height: roiPx.height,
    },
    gemini: {
      model: EDIT_OPENINGS_GEMINI_MODEL,
      rawResponse,
    },
  };

  nLog("[edit-openings-validator] final_decision", {
    passed: summary.passed,
    reason: summary.reason,
    evaluatedOpeningsCount: summary.evaluatedOpeningsCount,
  });

  return summary;
}
