export type GeminiCallType = "image_generation" | "text_generation" | "validator" | "repair" | "edit";

type GeminiUsageLogger = Pick<Console, "info" | "warn">;

type GeminiUsageLogArgs = {
  jobId?: string | null;
  stage: string;
  model: string;
  callType: GeminiCallType;
  response: any;
  latencyMs?: number;
  logger?: GeminiUsageLogger;
};

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
  const logger = args.logger || console;
  const usageMetadata = args.response?.usageMetadata;
  const inputTokens = toTokenCount(usageMetadata?.promptTokenCount);
  const outputTokens = toTokenCount(usageMetadata?.candidatesTokenCount);
  const totalTokens = toTokenCount(usageMetadata?.totalTokenCount);
  const imageCount = countGeneratedImages(args.response);
  const jobId = args.jobId || "unknown";
  const costEstimateUsd = estimateGeminiCostUsd(args.model, inputTokens, outputTokens);

  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    const warnPayload: Record<string, unknown> = {
      jobId,
      stage: args.stage,
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

    logger.warn("[USAGE_MISSING]", warnPayload);
    return;
  }

  const infoPayload: Record<string, unknown> = {
    jobId,
    stage: args.stage,
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

  logger.info("[USAGE]", infoPayload);
}