import type { GoogleGenAI } from "@google/genai";
import { logGeminiError } from "../utils/logGeminiError";
import { logIfNotFocusMode } from "../logger";
import { logGeminiUsage, type GeminiCallType } from "./usageTelemetry";
import { generateContentViaRest, type GeminiRestGenerateContentBody } from "./geminiRestClient";

function ensureImageCapableModel(model: string | undefined, fallback: string, envName: string): string {
  const candidate = String(model || "").trim();
  if (!candidate) {
    return fallback;
  }

  if (candidate.toLowerCase().includes("-image")) {
    return candidate;
  }

  throw new Error(`[MODEL_CONFIG_INVALID] env=${envName} value=${candidate} reason=non_image_model`);
}

/**
 * Per-stage Gemini model configuration with safe fallback
 *
 * Stage 1A: Gemini 2.5 Flash Image (no fallback, standard quality enhancement)
 * Stage 1B: Gemini 3 Pro Image → fallback to 2.5 on failure (declutter/furniture removal)
 * Stage 2:  Gemini 2.5 Flash Image (fallback defaults to same model, virtual staging)
 */

// ✅ ENVIRONMENT-DRIVEN MODEL CONFIGURATION (no hard-coded models)
export const MODEL_CONFIG = {
  stage1A: {
    primary: process.env.REALENHANCE_MODEL_STAGE1A_PRIMARY || "gemini-2.5-flash-image",
    fallback: null, // Stage 1A has no fallback
  },
  // Exterior-only Stage 1A path (image-quality fix, 2026-09-18): Gemini 2.5
  // Flash Image has no reliable output-resolution control, producing ~1MP
  // images that then need lossy interpolation upscaling for delivery.
  // gemini-3-pro-image-preview supports an explicit generationConfig.imageConfig
  // (imageSize "1K"/"2K"/"4K") and is already the proven, live primary model
  // for Stage 1B in this codebase — reused here rather than introducing a new
  // model. Interior Stage 1A is intentionally left on the cheaper 2.5 model
  // (see the interior Sharp-pipeline retune in stage1A-post-finish.ts /
  // worker.ts instead).
  stage1AExterior: {
    primary: process.env.REALENHANCE_MODEL_STAGE1A_EXTERIOR_PRIMARY || "gemini-3-pro-image-preview",
    fallback: process.env.REALENHANCE_MODEL_STAGE1A_EXTERIOR_FALLBACK || "gemini-2.5-flash-image",
  },
  stage1B: {
    primary: process.env.REALENHANCE_MODEL_STAGE1B_PRIMARY || "gemini-3-pro-image-preview",
    fallback: process.env.REALENHANCE_MODEL_STAGE1B_FALLBACK || "gemini-2.5-flash-image",
  },
  stage2: {
    primary: ensureImageCapableModel(process.env.REALENHANCE_MODEL_STAGE2_PRIMARY, "gemini-2.5-flash-image", "REALENHANCE_MODEL_STAGE2_PRIMARY"),
    fallback: ensureImageCapableModel(process.env.REALENHANCE_MODEL_STAGE2_FALLBACK, "gemini-2.5-flash-image", "REALENHANCE_MODEL_STAGE2_FALLBACK"),
  },
};

type GenerateContentParams = Parameters<GoogleGenAI['models']['generateContent']>[0];

/**
 * Determine if a Gemini response is a valid image response
 * Failure conditions:
 * - No candidates
 * - No parts in content
 * - No inline image data in any part
 * - Empty image buffer
 */
function isValidImageResponse(resp: any): { valid: boolean; reason?: string } {
  if (!resp) {
    return { valid: false, reason: "No response object" };
  }

  const candidates = resp.candidates || [];
  if (candidates.length === 0) {
    return { valid: false, reason: "No candidates in response" };
  }

  const parts: any[] = candidates[0]?.content?.parts || [];
  if (parts.length === 0) {
    return { valid: false, reason: "No parts in response content" };
  }

  const hasImage = parts.some(p => p.inlineData?.data && p.inlineData.data.length > 0);
  if (!hasImage) {
    return { valid: false, reason: "No inline image data in response parts" };
  }

  return { valid: true };
}

// jobId, imageId, and stage are required when meta is provided.
// All model execution callers must supply these three fields so that
// assertContext() in usageTelemetry does not throw after generation.
type ModelLogMeta = {
  jobId: string;
  imageId: string;
  stage: string;
  filename?: string;
  roomType?: string;
  callType?: GeminiCallType;
  reason?: string;
  selectedModel?: string;
  fallbackModel?: string | null;
  attempt?: number;
};

function logNoImageResponse(meta: ModelLogMeta | undefined, stageLabel: "1A" | "1B" | "2", model: string, parts: any[]) {
  if (stageLabel !== "2") return;
  const partTypes = (parts || []).map((part: any) => {
    if (!part || typeof part !== "object") return "unknown";
    if (part.inlineData) return "inlineData";
    if (part.text) return "text";
    if (part.functionCall) return "functionCall";
    if (part.functionResponse) return "functionResponse";
    return Object.keys(part)[0] || "unknown";
  });
  const inlineDataPresent = (parts || []).some((part: any) => !!part?.inlineData?.data);
  console.warn(
    `[stage2_generation_no_image] model=${model} attempt=${meta?.attempt ?? "unknown"} response_parts=${partTypes.join(",") || "none"} inlineData_present=${inlineDataPresent}`
  );
}

function logModelResolution(meta: ModelLogMeta) {
  const stageLabel = meta.stage || "n/a";
  const models = meta.fallbackModel
    ? `${meta.selectedModel || 'n/a'} (fallback=${meta.fallbackModel})`
    : (meta.selectedModel || 'n/a');
  logIfNotFocusMode(
    `[MODEL][${stageLabel}] job=${meta.jobId || 'n/a'} file=${meta.filename || 'n/a'} stage=${stageLabel} room=${meta.roomType || 'n/a'} models=${models} reason=${meta.reason || 'n/a'}`
  );
}

function parseErrorStatusCode(err: any): number | null {
  const direct = Number((err as any)?.status ?? (err as any)?.statusCode);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const code = String((err as any)?.code ?? "").trim();
  if (/^\d{3}$/.test(code)) {
    return Number(code);
  }

  const msg = String((err as any)?.message ?? "");
  const httpMatch = msg.match(/\b(429|5\d\d)\b/);
  if (httpMatch) {
    return Number(httpMatch[1]);
  }

  return null;
}

function isTimeoutError(err: any): boolean {
  const code = String((err as any)?.code ?? "").toLowerCase();
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return (
    code.includes("timeout")
    || code === "etimedout"
    || code === "aborted"
    || msg.includes("timeout")
    || msg.includes("timed out")
    || msg.includes("deadline exceeded")
  );
}

function isRetryableModelError(err: any): boolean {
  const status = parseErrorStatusCode(err);
  if (status === 429) return true;
  // Payment/quota-required (e.g. a preview-tier model running out of quota)
  // should fall back rather than hard-fail the job — added for the
  // Stage 1A exterior Gemini-3-Pro path, but applies equally to Stage 1B's
  // existing primary/fallback usage.
  if (status === 402) return true;
  if (status !== null && status >= 500) return true;
  const msg = String((err as any)?.message ?? "").toLowerCase();
  if (msg.includes("payment_required") || msg.includes("lack sufficient credits") || msg.includes("quota")) return true;
  return isTimeoutError(err);
}

/**
 * Legacy function for Stage 1A (Gemini 2.5 only, no fallback)
 *
 * @param ai GoogleGenAI client
 * @param baseRequest Request parameters (without model)
 * @param context Context label for logging
 * @returns Response and model used
 */
export async function runWithImageModelFallback(
  ai: GoogleGenAI,
  baseRequest: Omit<GenerateContentParams, "model">,
  context: string,
  meta: ModelLogMeta
): Promise<{ resp: any; modelUsed: string }> {
  // This function is kept for backward compatibility with Stage 1A
  // Stage 1A always uses Gemini 2.5 (primary model only, no fallback)
  const model = MODEL_CONFIG.stage1A.primary;

  const modelStageLabel = meta.stage;
  logIfNotFocusMode(`[${modelStageLabel}] Model: ${model}`);
  logModelResolution({
    stage: meta.stage,
    jobId: meta.jobId,
    imageId: meta.imageId,
    filename: meta.filename,
    roomType: meta.roomType,
    reason: meta.reason || context,
    selectedModel: model,
    fallbackModel: MODEL_CONFIG.stage1A.fallback,
  });

  try {
    const requestStartedAt = Date.now();
    const resp = await ai.models.generateContent({
      ...baseRequest,
      model,
    });
    logGeminiUsage({
      ctx: {
        jobId: meta.jobId,
        imageId: meta.imageId,
        stage: meta.stage,
        attempt: Number.isFinite(meta.attempt) ? Number(meta.attempt) : 1,
      },
      model,
      callType: meta.callType || "image_generation",
      response: resp,
      latencyMs: Date.now() - requestStartedAt,
    });

    const validation = isValidImageResponse(resp);
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.info(`[GEMINI][${context}] Attempt with ${model} parts=${parts.length} responseHasInlineImage=${validation.valid}`);

    if (!validation.valid) {
      console.error(`[GEMINI][${context}] ${model} failed: ${validation.reason}`);
      throw new Error(`Model ${model} ${validation.reason}`);
    }

    console.info(`[GEMINI][${context}] Success with ${model}`);
    return { resp, modelUsed: model };
  } catch (err) {
    logGeminiError(`${context}:${model}`, err);
    console.error(`❌ FATAL: ${model} unavailable — cannot continue AI pipeline.`);
    throw new Error(`[GEMINI][${context}] ${model} model unavailable – aborting job. Error: ${(err as any)?.message || err}`);
  }
}

export async function runWithSelectedImageModel({
  stageLabel,
  ai,
  baseRequest,
  context,
  model,
  meta,
}: {
  stageLabel: "1B" | "2";
  ai: GoogleGenAI;
  baseRequest: Omit<GenerateContentParams, "model">;
  context: string;
  model: string;
  meta: ModelLogMeta;
}): Promise<{ resp: any; modelUsed: string }> {
  const selectedModel = ensureImageCapableModel(model, model, `stage${stageLabel}_selected_model`);
  logModelResolution({
    stage: meta.stage,
    jobId: meta.jobId,
    imageId: meta.imageId,
    filename: meta.filename,
    roomType: meta.roomType,
    reason: meta.reason || context,
    selectedModel,
    fallbackModel: null,
  });

  try {
    const requestStartedAt = Date.now();
    const resp = await ai.models.generateContent({
      ...baseRequest,
      model: selectedModel,
    });
    logGeminiUsage({
      ctx: {
        jobId: meta.jobId,
        imageId: meta.imageId,
        stage: meta.stage,
        attempt: Number.isFinite(meta.attempt) ? Number(meta.attempt) : 1,
      },
      model: selectedModel,
      callType: meta.callType || "image_generation",
      response: resp,
      latencyMs: Date.now() - requestStartedAt,
    });

    const validation = isValidImageResponse(resp);
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.info(`[GEMINI][${context}] Attempt with ${selectedModel} parts=${parts.length} responseHasInlineImage=${validation.valid}`);

    if (!validation.valid) {
      logNoImageResponse(meta, stageLabel, selectedModel, parts);
      throw new Error(`Model ${selectedModel} ${validation.reason}`);
    }

    return { resp, modelUsed: selectedModel };
  } catch (err) {
    logGeminiError(`${context}:${selectedModel}`, err);
    throw err;
  }
}

/**
 * Safe image generation with primary/fallback strategy for Stage 1B and
 * Stage 2. (Stage 1A exterior has its own dedicated
 * runStage1AExteriorPrimaryThenFallback below — its primary attempt needs a
 * raw REST call, not the SDK, so it can't share this function's SDK-only
 * call sites.)
 *
 * @param stageLabel "1B" or "2"
 * @param ai GoogleGenAI client
 * @param baseRequest Request parameters (without model)
 * @param context Context label for logging
 * @returns Response and model used
 */
export async function runWithPrimaryThenFallback({
  stageLabel,
  ai,
  baseRequest,
  context,
  meta,
}: {
  stageLabel: "1B" | "2";
  ai: GoogleGenAI;
  baseRequest: Omit<GenerateContentParams, "model">;
  context: string;
  meta: ModelLogMeta;
}): Promise<{ resp: any; modelUsed: string }> {
  const config = stageLabel === "1B" ? MODEL_CONFIG.stage1B : MODEL_CONFIG.stage2;
  const primaryModel = config.primary;
  const fallbackModel = config.fallback!;

  logIfNotFocusMode(`[stage${stageLabel}] Primary model: ${primaryModel}, fallback: ${fallbackModel}`);
  logModelResolution({
    stage: meta.stage,
    jobId: meta.jobId,
    imageId: meta.imageId,
    filename: meta.filename,
    roomType: meta.roomType,
    reason: meta.reason || context,
    selectedModel: primaryModel,
    fallbackModel,
  });

  // Attempt primary model first. Fallback is only allowed for retryable transport failures
  // or when primary response is structurally valid but missing image bytes.
  let primaryError: any = null;
  let primaryMissingImage = false;
  let shouldTryFallback = false;
  try {
    const requestStartedAt = Date.now();
    const resp = await ai.models.generateContent({
      ...baseRequest,
      model: primaryModel,
    });
    logGeminiUsage({
      ctx: {
        jobId: meta.jobId,
        imageId: meta.imageId,
        stage: meta.stage,
        attempt: Number.isFinite(meta.attempt) ? Number(meta.attempt) : 1,
      },
      model: primaryModel,
      callType: meta.callType || "image_generation",
      response: resp,
      latencyMs: Date.now() - requestStartedAt,
    });

    const validation = isValidImageResponse(resp);
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.info(`[GEMINI][${context}] Primary attempt with ${primaryModel} parts=${parts.length} responseHasInlineImage=${validation.valid}`);

    if (!validation.valid) {
      logNoImageResponse(meta, stageLabel, primaryModel, parts);
      primaryMissingImage = true;
      shouldTryFallback = true;
      primaryError = new Error(`Primary model ${primaryModel} ${validation.reason}`);
      console.warn(`[stage${stageLabel}] Gemini primary failed: ${validation.reason} → falling back to ${fallbackModel}`);
    } else {
      console.info(`[GEMINI][${context}] Success with primary model ${primaryModel}`);
      console.log(`[stage${stageLabel}] Completed using model: ${primaryModel}`);
      return { resp, modelUsed: primaryModel };
    }
  } catch (err) {
    primaryError = err;
    logGeminiError(`${context}:${primaryModel}`, err);
    shouldTryFallback = isRetryableModelError(err);
    if (shouldTryFallback) {
      console.warn(`[stage${stageLabel}] Gemini primary failed with retryable error: ${(err as any)?.message || err} → falling back to ${fallbackModel}`);
    } else {
      console.error(`[stage${stageLabel}] Gemini primary failed with non-retryable error: ${(err as any)?.message || err} → not using fallback`);
    }
  }

  if (!shouldTryFallback) {
    const reason = primaryMissingImage
      ? "primary_missing_image"
      : "primary_non_retryable_failure";
    throw new Error(
      `[GEMINI][${context}] Primary model failed without fallback eligibility (${reason}). ` +
      `Primary (${primaryModel}): ${primaryError?.message || primaryError}`
    );
  }

  // Attempt fallback model only after retryable primary failure or missing image bytes.
  let fallbackError: any = null;
  try {
    console.log(`[stage${stageLabel}] Attempting fallback model: ${fallbackModel}`);
    const requestStartedAt = Date.now();
    const resp = await ai.models.generateContent({
      ...baseRequest,
      model: fallbackModel,
    });
    logGeminiUsage({
      ctx: {
        jobId: meta.jobId,
        imageId: meta.imageId,
        stage: meta.stage,
        attempt: Number.isFinite(meta.attempt) ? Number(meta.attempt) : 1,
      },
      model: fallbackModel,
      callType: meta.callType || "image_generation",
      response: resp,
      latencyMs: Date.now() - requestStartedAt,
    });

    const validation = isValidImageResponse(resp);
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.info(`[GEMINI][${context}] Fallback attempt with ${fallbackModel} parts=${parts.length} responseHasInlineImage=${validation.valid}`);

    if (!validation.valid) {
      logNoImageResponse(meta, stageLabel, fallbackModel, parts);
      fallbackError = new Error(`Fallback model ${fallbackModel} ${validation.reason}`);
      console.error(`[stage${stageLabel}] Fallback model failed: ${validation.reason}`);
    } else {
      console.info(`[GEMINI][${context}] Success with fallback model ${fallbackModel}`);
      console.log(`[stage${stageLabel}] Completed using model: ${fallbackModel} (fallback)`);
      return { resp, modelUsed: fallbackModel };
    }
  } catch (err) {
    fallbackError = err;
    logGeminiError(`${context}:${fallbackModel}`, err);
    console.error(`[stage${stageLabel}] Fallback model failed: ${(err as any)?.message || err}`);
  }

  // ✅ BOTH MODELS FAILED - CONTROLLED ERROR (DO NOT CRASH WORKER)
  console.error(`❌ FATAL: Both Gemini models failed for stage ${stageLabel}`);
  console.error(`Primary (${primaryModel}) error:`, primaryError?.message || primaryError);
  console.error(`Fallback (${fallbackModel}) error:`, fallbackError?.message || fallbackError);

  const errorMsg = [
    `[GEMINI][${context}] Both primary and fallback models failed`,
    `Primary (${primaryModel}): ${primaryError?.message || primaryError}`,
    `Fallback (${fallbackModel}): ${fallbackError?.message || fallbackError}`,
  ].join(". ");

  throw new Error(errorMsg);
}

/**
 * Stage 1A exterior only (image-quality fix, 2026-09-18): identical
 * primary/fallback shape to runWithPrimaryThenFallback above, but the
 * PRIMARY attempt goes over a raw REST call (geminiRestClient.ts) instead of
 * the @google/genai SDK, because the installed SDK version (0.7.0) silently
 * drops generationConfig.imageConfig — see geminiRestClient.ts's header
 * comment for the full explanation. The FALLBACK attempt uses the normal
 * SDK client, since gemini-2.5-flash-image doesn't need imageConfig anyway.
 */
export async function runStage1AExteriorPrimaryThenFallback({
  ai,
  apiKey,
  baseRequestBody,
  context,
  meta,
}: {
  ai: GoogleGenAI;
  apiKey: string;
  baseRequestBody: GeminiRestGenerateContentBody;
  context: string;
  meta: ModelLogMeta;
}): Promise<{ resp: any; modelUsed: string }> {
  const primaryModel = MODEL_CONFIG.stage1AExterior.primary;
  const fallbackModel = MODEL_CONFIG.stage1AExterior.fallback!;
  const stageLabel = "1A" as const;

  logIfNotFocusMode(`[stage${stageLabel}] Primary model (REST): ${primaryModel}, fallback (SDK): ${fallbackModel}`);
  logModelResolution({
    stage: meta.stage,
    jobId: meta.jobId,
    imageId: meta.imageId,
    filename: meta.filename,
    roomType: meta.roomType,
    reason: meta.reason || context,
    selectedModel: primaryModel,
    fallbackModel,
  });

  let primaryError: any = null;
  let primaryMissingImage = false;
  let shouldTryFallback = false;
  try {
    const requestStartedAt = Date.now();
    const resp = await generateContentViaRest({ apiKey, model: primaryModel, body: baseRequestBody });
    logGeminiUsage({
      ctx: {
        jobId: meta.jobId,
        imageId: meta.imageId,
        stage: meta.stage,
        attempt: Number.isFinite(meta.attempt) ? Number(meta.attempt) : 1,
      },
      model: primaryModel,
      callType: meta.callType || "image_generation",
      response: resp,
      latencyMs: Date.now() - requestStartedAt,
    });

    const validation = isValidImageResponse(resp);
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.info(`[GEMINI][${context}] Primary attempt (REST) with ${primaryModel} parts=${parts.length} responseHasInlineImage=${validation.valid}`);

    if (!validation.valid) {
      logNoImageResponse(meta, stageLabel, primaryModel, parts);
      primaryMissingImage = true;
      shouldTryFallback = true;
      primaryError = new Error(`Primary model ${primaryModel} ${validation.reason}`);
      console.warn(`[stage${stageLabel}] Gemini primary (REST) failed: ${validation.reason} → falling back to ${fallbackModel}`);
    } else {
      console.info(`[GEMINI][${context}] Success with primary model ${primaryModel} (REST)`);
      console.log(`[stage${stageLabel}] Completed using model: ${primaryModel} (REST)`);
      return { resp, modelUsed: primaryModel };
    }
  } catch (err) {
    primaryError = err;
    logGeminiError(`${context}:${primaryModel}`, err);
    shouldTryFallback = isRetryableModelError(err);
    if (shouldTryFallback) {
      console.warn(`[stage${stageLabel}] Gemini primary (REST) failed with retryable error: ${(err as any)?.message || err} → falling back to ${fallbackModel}`);
    } else {
      console.error(`[stage${stageLabel}] Gemini primary (REST) failed with non-retryable error: ${(err as any)?.message || err} → not using fallback`);
    }
  }

  if (!shouldTryFallback) {
    const reason = primaryMissingImage ? "primary_missing_image" : "primary_non_retryable_failure";
    throw new Error(
      `[GEMINI][${context}] Primary model failed without fallback eligibility (${reason}). ` +
      `Primary (${primaryModel}): ${primaryError?.message || primaryError}`
    );
  }

  // Fallback: normal SDK call, no imageConfig needed for gemini-2.5-flash-image.
  const { imageConfig: _dropForFallback, ...fallbackGenerationConfig } = baseRequestBody.generationConfig || {};
  let fallbackError: any = null;
  try {
    console.log(`[stage${stageLabel}] Attempting fallback model: ${fallbackModel} (SDK)`);
    const requestStartedAt = Date.now();
    const resp = await ai.models.generateContent({
      contents: baseRequestBody.contents,
      generationConfig: fallbackGenerationConfig,
      model: fallbackModel,
    } as any);
    logGeminiUsage({
      ctx: {
        jobId: meta.jobId,
        imageId: meta.imageId,
        stage: meta.stage,
        attempt: Number.isFinite(meta.attempt) ? Number(meta.attempt) : 1,
      },
      model: fallbackModel,
      callType: meta.callType || "image_generation",
      response: resp,
      latencyMs: Date.now() - requestStartedAt,
    });

    const validation = isValidImageResponse(resp);
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.info(`[GEMINI][${context}] Fallback attempt with ${fallbackModel} parts=${parts.length} responseHasInlineImage=${validation.valid}`);

    if (!validation.valid) {
      logNoImageResponse(meta, stageLabel, fallbackModel, parts);
      fallbackError = new Error(`Fallback model ${fallbackModel} ${validation.reason}`);
      console.error(`[stage${stageLabel}] Fallback model failed: ${validation.reason}`);
    } else {
      console.info(`[GEMINI][${context}] Success with fallback model ${fallbackModel}`);
      console.log(`[stage${stageLabel}] Completed using model: ${fallbackModel} (fallback)`);
      return { resp, modelUsed: fallbackModel };
    }
  } catch (err) {
    fallbackError = err;
    logGeminiError(`${context}:${fallbackModel}`, err);
    console.error(`[stage${stageLabel}] Fallback model failed: ${(err as any)?.message || err}`);
  }

  console.error(`❌ FATAL: Both Gemini models failed for stage ${stageLabel} (exterior)`);
  console.error(`Primary (${primaryModel}) error:`, primaryError?.message || primaryError);
  console.error(`Fallback (${fallbackModel}) error:`, fallbackError?.message || fallbackError);

  const errorMsg = [
    `[GEMINI][${context}] Both primary and fallback models failed`,
    `Primary (${primaryModel}): ${primaryError?.message || primaryError}`,
    `Fallback (${fallbackModel}): ${fallbackError?.message || fallbackError}`,
  ].join(". ");

  throw new Error(errorMsg);
}
