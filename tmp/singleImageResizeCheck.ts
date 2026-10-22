// STANDALONE MECHANISM TEST — NOT wired into any production validator.
// Two single-image observation calls + deterministic code-side comparison,
// per this task's design: replace the single comparative "did this
// resize/move" judgment (already tried in 4 wording variants, all failed —
// see the prior task's report) with two independent, narrow, single-image
// observations, and do the actual yes/no determination in code.
import { toBase64 } from "../worker/src/utils/images";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { grokAnalyzeImages, grokVisionModel } from "../worker/src/ai/grok";
import { logGeminiUsage } from "../worker/src/ai/usageTelemetry";
import { resolveValidatorModel } from "../worker/src/validators/occlusionVsRemovalCheck";

const MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

export type SingleImageObservation = {
  referencePoints: string;
  boundaryDescription: string;
  bboxEstimate: [number, number, number, number] | null;
  touchesFrameEdge: string;
};

function formatBbox(bbox: [number, number, number, number]): string {
  const [x1, y1, x2, y2] = bbox;
  return `x: ${x1.toFixed(2)}–${x2.toFixed(2)}, y: ${y1.toFixed(2)}–${y2.toFixed(2)}`;
}

function buildSingleImagePrompt(approxBbox: [number, number, number, number]): string {
  return `Below is one approximate region from a room photo, given as a bounding box (normalized fractions of image width/height, 0,0 = top-left, 1,1 = bottom-right): ${formatBbox(approxBbox)}. This is only a rough starting pointer to where to look — it may not exactly match the item's actual current position or size in THIS photo.

Look at THIS photo (only this one photo — no other photo is given to you) at and around that location. Answer, for this photo only:

1. referencePoints — What fixed architectural reference points are visible nearby that could be used to precisely judge position — a ceiling light fixture, a doorway, a room corner, a switch plate, a curtain rod bracket, etc.? Name them and roughly where they are in this photo (e.g. "a ceiling light near image-center, an interior doorway on the right wall").

2. boundaryDescription — Using those reference points as anchors, describe precisely where this item's OWN edges actually are in THIS photo — e.g. "the left edge is about one door-width to the left of the room's interior doorway", "the top edge is level with the ceiling light fixture", "the item spans from the room's left corner to about the halfway point of the visible wall". Describe what you actually see, not the bbox pointer above.

3. bboxEstimate — Your own best concrete estimate of this item's own bounding box AS YOU SEE IT IN THIS PHOTO, as normalized fractions of the image width/height (0,0 = top-left, 1,1 = bottom-right): [x1, y1, x2, y2]. This should reflect what you actually observe in this photo, not the pointer above if they differ.

4. touchesFrameEdge — Does the item's own visible extent touch the edge of the photo frame? Answer "none" or a comma-separated list of "top","bottom","left","right".

Respond with ONLY a single valid JSON object:
{
  "referencePoints": "string",
  "boundaryDescription": "string",
  "bboxEstimate": [x1, y1, x2, y2],
  "touchesFrameEdge": "string"
}`;
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export async function observeSingleImage(params: {
  imagePath: string;
  approxBbox: [number, number, number, number];
  ctx: { jobId: string; imageId: string; callLabel: string };
}): Promise<SingleImageObservation> {
  const loaded = toBase64(params.imagePath);
  const validatorModel = resolveValidatorModel();
  const requestStartedAt = Date.now();
  const systemInstruction = "You are a careful visual inspector describing precisely where one item is located in a single room photo, using nearby fixed reference points.";
  const userPrompt = buildSingleImagePrompt(params.approxBbox);

  let raw: any;
  if (validatorModel === "grok") {
    const text = await grokAnalyzeImages({
      images: [{ buffer: Buffer.from(loaded.data, "base64"), mimeType: loaded.mime, label: "Photo:" }],
      prompt: `${systemInstruction}\n\n${userPrompt}`,
      jobId: params.ctx.jobId,
      imageId: params.ctx.imageId,
      reason: `single_image_resize_${params.ctx.callLabel}`,
      expectJson: true,
    });
    console.log(
      JSON.stringify({
        event: "GROK_VALIDATOR_USAGE",
        jobId: params.ctx.jobId,
        imageId: params.ctx.imageId,
        stage: "validator",
        callLabel: `single_image_resize_${params.ctx.callLabel}`,
        model: grokVisionModel(),
        latencyMs: Date.now() - requestStartedAt,
      })
    );
    raw = extractJson(text);
  } else {
    const ai = getGeminiClient();
    const response: any = await (ai as any).models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [{ text: systemInstruction }, { text: userPrompt }, { text: "Photo:" }, { inlineData: { mimeType: loaded.mime, data: loaded.data } }],
        },
      ],
      generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 1024, responseMimeType: "application/json" },
    });
    logGeminiUsage({
      ctx: { jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", attempt: 1 },
      model: MODEL,
      callType: "validator",
      response,
      latencyMs: Date.now() - requestStartedAt,
    });
    const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p: any) => typeof p?.text === "string");
    if (!textPart) throw new Error(`SINGLE_IMAGE_RESIZE[${params.ctx.callLabel}]: no text returned`);
    raw = extractJson(textPart.text);
  }

  return {
    referencePoints: typeof raw?.referencePoints === "string" ? raw.referencePoints : "",
    boundaryDescription: typeof raw?.boundaryDescription === "string" ? raw.boundaryDescription : "",
    bboxEstimate: Array.isArray(raw?.bboxEstimate) && raw.bboxEstimate.length === 4 ? (raw.bboxEstimate as [number, number, number, number]) : null,
    touchesFrameEdge: typeof raw?.touchesFrameEdge === "string" ? raw.touchesFrameEdge : "unknown",
  };
}

export type ResizeRelocationVerdict = {
  resized: boolean;
  repositioned: boolean;
  sizeChangePct: number | null;
  centerShiftFraction: number | null;
  reason: string;
};

// Pure, deterministic, offline-testable — the actual yes/no decision lives
// here, not in either model call. Both bboxes are normalized 0-1 fractions
// of their own image, so this comparison is valid directly (no rescaling
// needed) as long as both photos share the same aspect ratio, which is true
// for every real case tested here (baseline vs. Stage-2 output are always
// generated from the same canonical aspect ratio).
export function compareSingleImageObservations(
  baseline: SingleImageObservation,
  staged: SingleImageObservation,
  opts: { sizeThresholdPct?: number; shiftThresholdFraction?: number } = {}
): ResizeRelocationVerdict {
  const sizeThresholdPct = opts.sizeThresholdPct ?? 25;
  const shiftThresholdFraction = opts.shiftThresholdFraction ?? 0.10;

  if (!baseline.bboxEstimate || !staged.bboxEstimate) {
    return { resized: false, repositioned: false, sizeChangePct: null, centerShiftFraction: null, reason: "missing_bbox_estimate" };
  }

  const [bx1, by1, bx2, by2] = baseline.bboxEstimate;
  const [sx1, sy1, sx2, sy2] = staged.bboxEstimate;

  const bWidth = bx2 - bx1, bHeight = by2 - by1;
  const sWidth = sx2 - sx1, sHeight = sy2 - sy1;
  const bArea = bWidth * bHeight, sArea = sWidth * sHeight;

  const sizeChangePct = bArea > 0 ? ((sArea - bArea) / bArea) * 100 : null;

  const bCenterX = (bx1 + bx2) / 2, bCenterY = (by1 + by2) / 2;
  const sCenterX = (sx1 + sx2) / 2, sCenterY = (sy1 + sy2) / 2;
  const centerShiftFraction = Math.sqrt((sCenterX - bCenterX) ** 2 + (sCenterY - bCenterY) ** 2);

  const resized = sizeChangePct !== null && Math.abs(sizeChangePct) >= sizeThresholdPct;
  const repositioned = centerShiftFraction >= shiftThresholdFraction;

  return {
    resized,
    repositioned,
    sizeChangePct,
    centerShiftFraction,
    reason: `sizeChangePct=${sizeChangePct?.toFixed(1)}% centerShiftFraction=${centerShiftFraction.toFixed(3)} (thresholds: size=${sizeThresholdPct}% shift=${shiftThresholdFraction})`,
  };
}
