import { getGeminiClient } from "../ai/gemini";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { toBase64 } from "../utils/images";

export type Stage1BDeclutterMetrics = {
  beforeClutterItems: number;
  afterClutterItems: number;
  remainingPercent: number;
  surfaceClutterItems: number;
  confidence: number;
  reasons: string[];
};

export type Stage1BDeclutterThresholds = {
  minConfidence: number;
  percentBaselineMin: number;
  percentAfterMin: number;
  maxRemainingPercent: number;
  absoluteAfterBlock: number;
  surfaceAfterBlock: number;
};

export type Stage1BDeclutterEvaluation = {
  blocked: boolean;
  confidenceEligible: boolean;
  blockReasons: string[];
  thresholds: Stage1BDeclutterThresholds;
};

export type Stage1BDeclutterEffectivenessResult = Stage1BDeclutterEvaluation & {
  metrics: Stage1BDeclutterMetrics;
  rawText?: string;
};

function numEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

export function getStage1BDeclutterThresholdsFromEnv(): Stage1BDeclutterThresholds {
  return {
    minConfidence: numEnv("STAGE1B_DECLUTTER_CONFIDENCE_MIN", 0.8),
    percentBaselineMin: Math.max(0, Math.floor(numEnv("STAGE1B_DECLUTTER_PERCENT_BASELINE_MIN", 5))),
    percentAfterMin: Math.max(0, Math.floor(numEnv("STAGE1B_DECLUTTER_PERCENT_AFTER_MIN", 3))),
    maxRemainingPercent: Math.max(0, numEnv("STAGE1B_DECLUTTER_MAX_REMAINING_PERCENT", 35)),
    absoluteAfterBlock: Math.max(0, Math.floor(numEnv("STAGE1B_DECLUTTER_ABSOLUTE_AFTER_BLOCK", 10))),
    surfaceAfterBlock: Math.max(0, Math.floor(numEnv("STAGE1B_DECLUTTER_SURFACE_AFTER_BLOCK", 5))),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeInteger(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function normalizePercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return clamp(n, 0, 100);
}

function normalizeConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return clamp(n, 0, 1);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

export function evaluateStage1BDeclutterEffectiveness(
  metrics: Stage1BDeclutterMetrics,
  thresholds: Stage1BDeclutterThresholds = getStage1BDeclutterThresholdsFromEnv()
): Stage1BDeclutterEvaluation {
  const confidenceEligible = metrics.confidence >= thresholds.minConfidence;
  if (!confidenceEligible) {
    return {
      blocked: false,
      confidenceEligible,
      blockReasons: [],
      thresholds,
    };
  }

  const percentGateTriggered =
    metrics.beforeClutterItems >= thresholds.percentBaselineMin &&
    metrics.afterClutterItems >= thresholds.percentAfterMin &&
    metrics.remainingPercent > thresholds.maxRemainingPercent;

  const absoluteGateTriggered = metrics.afterClutterItems >= thresholds.absoluteAfterBlock;
  const surfaceGateTriggered = metrics.surfaceClutterItems >= thresholds.surfaceAfterBlock;

  const blockReasons: string[] = [];
  if (percentGateTriggered) {
    blockReasons.push(
      `remaining_percent_exceeded:${metrics.remainingPercent.toFixed(1)}>${thresholds.maxRemainingPercent}`
    );
  }
  if (absoluteGateTriggered) {
    blockReasons.push(`absolute_after_exceeded:${metrics.afterClutterItems}>=${thresholds.absoluteAfterBlock}`);
  }
  if (surfaceGateTriggered) {
    blockReasons.push(`surface_clutter_exceeded:${metrics.surfaceClutterItems}>=${thresholds.surfaceAfterBlock}`);
  }

  return {
    blocked: blockReasons.length > 0,
    confidenceEligible,
    blockReasons,
    thresholds,
  };
}

export async function runStage1BDeclutterEffectivenessValidator(opts: {
  basePath: string;
  candidatePath: string;
  roomType?: string;
  sceneType?: string;
  jobId?: string;
  imageId?: string;
  attempt?: number;
}): Promise<Stage1BDeclutterEffectivenessResult> {
  const fallbackMetrics: Stage1BDeclutterMetrics = {
    beforeClutterItems: 0,
    afterClutterItems: 0,
    remainingPercent: 0,
    surfaceClutterItems: 0,
    confidence: 0,
    reasons: [],
  };
  const thresholds = getStage1BDeclutterThresholdsFromEnv();

  try {
    const ai = getGeminiClient();
    const before = toBase64(opts.basePath).data;
    const after = toBase64(opts.candidatePath).data;

    const prompt = `You are validating Stage 1B declutter effectiveness for the same room before/after images.

TASK:
- Count visible clutter items before and after.
- Estimate percent of clutter still remaining after declutter.
- Count how many remaining clutter items are on core surfaces (kitchen counters, bathroom vanity tops, dining tables, coffee tables, bedside tables, desks).

COUNTING RULES:
- Clutter means removable loose items: bags, boxes, clothes piles, loose papers, scattered toys, toiletries, small appliances left out, cords, bottles, miscellaneous small objects.
- Do NOT count built-in architecture or fixed furniture.
- Do NOT count intentionally staged decor if it appears purposeful and minimal.

Return strict JSON only (no markdown, no extra text) with this exact schema:
{
  "beforeClutterItems": number,
  "afterClutterItems": number,
  "remainingPercent": number,
  "surfaceClutterItems": number,
  "confidence": number,
  "reasons": [string]
}

Confidence must be between 0 and 1.`;

    const model = process.env.STAGE1B_DECLUTTER_EFFECTIVENESS_MODEL || "gemini-2.5-flash";
    const requestStartedAt = Date.now();
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
        temperature: 0.1,
        topP: 0.35,
        maxOutputTokens: 320,
      },
    } as any);
    logGeminiUsage({
      ctx: {
        jobId: opts.jobId || "",
        imageId: opts.imageId || "",
        stage: "validator",
        attempt: Number.isFinite(opts.attempt) ? Number(opts.attempt) : 1,
      },
      model,
      callType: "validator",
      response,
      latencyMs: Date.now() - requestStartedAt,
    });

    const textParts = (response as any)?.candidates?.[0]?.content?.parts || [];
    const text = textParts.map((p: any) => p?.text || "").join(" ").trim();
    const parsed = parseJsonObject(text);

    if (!parsed) {
      const evaluation = evaluateStage1BDeclutterEffectiveness(fallbackMetrics, thresholds);
      return {
        ...evaluation,
        metrics: { ...fallbackMetrics, reasons: ["declutter_effectiveness_parse_failed"] },
        rawText: text,
      };
    }

    const metrics: Stage1BDeclutterMetrics = {
      beforeClutterItems: normalizeInteger(parsed.beforeClutterItems),
      afterClutterItems: normalizeInteger(parsed.afterClutterItems),
      remainingPercent: normalizePercent(parsed.remainingPercent),
      surfaceClutterItems: normalizeInteger(parsed.surfaceClutterItems),
      confidence: normalizeConfidence(parsed.confidence),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map((v) => String(v)) : [],
    };

    const evaluation = evaluateStage1BDeclutterEffectiveness(metrics, thresholds);
    return {
      ...evaluation,
      metrics,
      rawText: text,
    };
  } catch (err: any) {
    console.warn("[stage1b-declutter-effectiveness] fail-open:", err?.message || err);
    const evaluation = evaluateStage1BDeclutterEffectiveness(fallbackMetrics, thresholds);
    return {
      ...evaluation,
      metrics: { ...fallbackMetrics, reasons: ["declutter_effectiveness_error"] },
      rawText: err?.message || String(err),
    };
  }
}
