import type { PipelineContext } from "../types/pipelineContext";

export type GeminiCallType = "image_generation" | "text_generation" | "validator" | "repair" | "edit";

type GeminiUsageLogArgs = {
  ctx: PipelineContext;
  model: string;
  callType: GeminiCallType;
  response: any;
  latencyMs?: number;
};

export function assertContext(ctx: PipelineContext): void {
  if (!ctx || !ctx.jobId || !ctx.imageId) {
    throw new Error("Missing jobId or imageId in logging context");
  }
  if (!ctx.stage || !Number.isFinite(ctx.attempt)) {
    throw new Error("Missing stage or attempt in logging context");
  }
}

export function logEvent(
  ctx: PipelineContext,
  event: string,
  data: Record<string, any> = {}
): void {
  assertContext(ctx);
  console.log(JSON.stringify({
    jobId: ctx.jobId,
    imageId: ctx.imageId,
    stage: ctx.stage,
    attempt: ctx.attempt,
    event,
    ...data,
    ts: new Date().toISOString(),
  }));
}

function toTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function countGeneratedImages(response: any): number | null {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  let total = 0;

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    total += parts.filter((part: any) => part?.inlineData?.data && /image\//i.test(String(part?.inlineData?.mimeType || ""))).length;
  }

  return total > 0 ? total : null;
}

type GeminiPricing = {
  inputUsdPer1MTokens: number;
  outputUsdPer1MTokens: number;
};

function normalizeModelKey(model: string): string {
  return String(model || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function readUsdPer1MEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function getGeminiPricing(model: string): GeminiPricing | null {
  const normalizedModel = normalizeModelKey(model);
  const inputUsdPer1MTokens = readUsdPer1MEnv(`GEMINI_PRICE_${normalizedModel}_INPUT_USD_PER_1M_TOKENS`);
  const outputUsdPer1MTokens = readUsdPer1MEnv(`GEMINI_PRICE_${normalizedModel}_OUTPUT_USD_PER_1M_TOKENS`);

  if (inputUsdPer1MTokens === null || outputUsdPer1MTokens === null) {
    return null;
  }

  return {
    inputUsdPer1MTokens,
    outputUsdPer1MTokens,
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function estimateGeminiCostUsd(model: string, inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens === null || outputTokens === null) {
    return null;
  }

  const pricing = getGeminiPricing(model);
  if (!pricing) {
    return null;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputUsdPer1MTokens;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputUsdPer1MTokens;
  return roundUsd(inputCost + outputCost);
}

export function logGeminiUsage(args: GeminiUsageLogArgs): void {
  assertContext(args.ctx);
  const usageMetadata = args.response?.usageMetadata;
  const inputTokens = toTokenCount(usageMetadata?.promptTokenCount);
  const outputTokens = toTokenCount(usageMetadata?.candidatesTokenCount);
  const totalTokens = toTokenCount(usageMetadata?.totalTokenCount);
  const imageCount = countGeneratedImages(args.response);
  const costEstimateUsd = estimateGeminiCostUsd(args.model, inputTokens, outputTokens);

  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    const warnPayload: Record<string, unknown> = {
      model: args.model,
      callType: args.callType,
      costEstimateUsd,
      reason: "No usageMetadata returned",
    };

    if (typeof args.latencyMs === "number" && Number.isFinite(args.latencyMs)) {
      warnPayload.latencyMs = Math.max(0, Math.round(args.latencyMs));
    }
    if (imageCount !== null) {
      warnPayload.imageCount = imageCount;
    }

    logEvent(args.ctx, "USAGE_MISSING", warnPayload as Record<string, any>);
    return;
  }

  const infoPayload: Record<string, unknown> = {
    model: args.model,
    callType: args.callType,
    inputTokens,
    outputTokens,
    totalTokens,
    costEstimateUsd,
  };

  if (typeof args.latencyMs === "number" && Number.isFinite(args.latencyMs)) {
    infoPayload.latencyMs = Math.max(0, Math.round(args.latencyMs));
  }
  if (imageCount !== null) {
    infoPayload.imageCount = imageCount;
  }

  logEvent(args.ctx, "USAGE", infoPayload as Record<string, any>);
}