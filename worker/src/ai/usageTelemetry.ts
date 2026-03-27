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

export function logGeminiUsage(args: GeminiUsageLogArgs): void {
  const logger = args.logger || console;
  const usageMetadata = args.response?.usageMetadata;
  const inputTokens = toTokenCount(usageMetadata?.promptTokenCount);
  const outputTokens = toTokenCount(usageMetadata?.candidatesTokenCount);
  const totalTokens = toTokenCount(usageMetadata?.totalTokenCount);
  const imageCount = countGeneratedImages(args.response);
  const jobId = args.jobId || "unknown";

  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    const warnPayload: Record<string, unknown> = {
      jobId,
      stage: args.stage,
      model: args.model,
      callType: args.callType,
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
  };

  if (typeof args.latencyMs === "number" && Number.isFinite(args.latencyMs)) {
    infoPayload.latencyMs = Math.max(0, Math.round(args.latencyMs));
  }
  if (imageCount !== null) {
    infoPayload.imageCount = imageCount;
  }

  logger.info("[USAGE]", infoPayload);
}