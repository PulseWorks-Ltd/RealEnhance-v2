import type { GoogleGenAI } from "@google/genai";
import { logGeminiError } from "../utils/logGeminiError";

export type GeminiLogContext = {
  jobId?: string;
  imageId?: string;
  stage?: string;
};

const GEMINI_CONCURRENCY_LIMIT = Math.max(1, Number(process.env.GEMINI_CONCURRENCY_LIMIT || 2));
const GEMINI_MAX_RETRIES = Math.max(0, Number(process.env.GEMINI_MAX_RETRIES || 4));
const GEMINI_RETRY_BASE_MS = Math.max(1, Number(process.env.GEMINI_RETRY_BASE_MS || 1500));
const GEMINI_RETRY_MAX_MS = Math.max(GEMINI_RETRY_BASE_MS, Number(process.env.GEMINI_RETRY_MAX_MS || 20000));

let inflight = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (inflight < GEMINI_CONCURRENCY_LIMIT) {
    inflight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inflight += 1;
}

function release(): void {
  inflight = Math.max(0, inflight - 1);
  const next = waiters.shift();
  if (next) next();
}

function isTransientGeminiError(err: any): boolean {
  const status = (err as any)?.status || (err as any)?.code || (err as any)?.response?.status;
  const msg = ((err as any)?.message || "").toLowerCase();
  if ([429, 502, 503, 504].includes(Number(status))) return true;
  if (msg.includes("unavailable") || msg.includes("overloaded") || msg.includes("try again later")) return true;
  const code = (err as any)?.code;
  if (code && typeof code === "string") {
    const lc = code.toLowerCase();
    if (["econnreset", "etimedout", "econnaborted"].includes(lc)) return true;
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiWithRetry({
  ai,
  request,
  model,
  context,
  logCtx,
}: {
  ai: GoogleGenAI;
  request: Omit<GenerateContentParams, "model">;
  model: string;
  context: string;
  logCtx?: GeminiLogContext;
}): Promise<any> {
  let lastErr: any;
  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    const attemptNum = attempt + 1;
    await acquire();
    const start = Date.now();
    const currentInflight = inflight;
    console.log(`[GEMINI] start model=${model} stage=${logCtx?.stage || 'n/a'} jobId=${logCtx?.jobId || 'n/a'} imageId=${logCtx?.imageId || 'n/a'} attempt=${attemptNum} inflight=${currentInflight}`);
    try {
      const resp = await ai.models.generateContent({
        ...request,
        model,
      });
      const dur = Date.now() - start;
      console.log(`[GEMINI] end model=${model} stage=${logCtx?.stage || 'n/a'} jobId=${logCtx?.jobId || 'n/a'} imageId=${logCtx?.imageId || 'n/a'} attempt=${attemptNum} durationMs=${dur}`);
      return resp;
    } catch (err) {
      lastErr = err;
      const dur = Date.now() - start;
      const transient = isTransientGeminiError(err);
      console.warn(`[GEMINI] error model=${model} stage=${logCtx?.stage || 'n/a'} jobId=${logCtx?.jobId || 'n/a'} attempt=${attemptNum} transient=${transient} durationMs=${dur} msg=${(err as any)?.message || err}`);
      if (!transient || attempt === GEMINI_MAX_RETRIES) {
        throw err;
      }
      const backoff = Math.min(GEMINI_RETRY_MAX_MS, GEMINI_RETRY_BASE_MS * Math.pow(2, attempt));
      const jitter = 0.6 + Math.random() * 0.8;
      const sleep = Math.floor(backoff * jitter);
      await delay(sleep);
    } finally {
      release();
    }
  }
  throw lastErr;
}

/**
 * Per-stage Gemini model configuration with safe fallback
 *
 * Stage 1A: Gemini 2.5 Flash Image (no fallback, standard quality enhancement)
 * Stage 1B: Gemini 3 Pro Image → fallback to 2.5 on failure (declutter/furniture removal)
 * Stage 2:  Gemini 2.5 Flash Image (no fallback, virtual staging)
 */

// ✅ ENVIRONMENT-DRIVEN MODEL CONFIGURATION (no hard-coded models)
export const MODEL_CONFIG = {
  stage1A: {
    primary: process.env.REALENHANCE_MODEL_STAGE1A_PRIMARY || "gemini-2.5-flash-image",
    fallback: null, // Stage 1A has no fallback
  },
  stage1B: {
    primary: process.env.REALENHANCE_MODEL_STAGE1B_PRIMARY || "gemini-3-pro-image-preview",
    fallback: process.env.REALENHANCE_MODEL_STAGE1B_FALLBACK || "gemini-2.5-flash-image",
  },
  stage2: {
    primary: process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image",
    fallback: process.env.REALENHANCE_MODEL_STAGE2_FALLBACK || "gemini-2.5-flash-image",
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
  logCtx?: GeminiLogContext
): Promise<{ resp: any; modelUsed: string }> {
  const fallbackOverride = process.env.GEMINI_IMAGE_MODEL_FALLBACK?.trim() || null;
  const failoverPolicy = process.env.IMAGE_FAILOVER_POLICY || "gemini_only";
  const model = MODEL_CONFIG.stage1A.primary;
  const fallbackModel = failoverPolicy === "gemini_only" ? (fallbackOverride || MODEL_CONFIG.stage1A.fallback) : null;

  console.log(`[stage1A] Model: ${model}`);

  try {
    const resp = await callGeminiWithRetry({
      ai,
      request: baseRequest,
      model,
      context,
      logCtx: { ...logCtx, stage: logCtx?.stage || "1A" },
    });

    const validation = isValidImageResponse(resp);
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.info(`[GEMINI][${context}] Attempt with ${model} parts=${parts.length} hasImage=${validation.valid}`);

    if (!validation.valid) {
      console.error(`[GEMINI][${context}] ${model} failed: ${validation.reason}`);
      throw new Error(`Model ${model} ${validation.reason}`);
    }

    console.info(`[GEMINI][${context}] Success with ${model}`);
    return { resp, modelUsed: model };
  } catch (err) {
    logGeminiError(`${context}:${model}`, err);
    if (!fallbackModel) {
      console.error(`❌ FATAL: ${model} unavailable — cannot continue AI pipeline.`);
      throw new Error(`[GEMINI][${context}] ${model} model unavailable – aborting job. Error: ${(err as any)?.message || err}`);
    }
    console.warn(`[stage1A] Primary model failed; attempting fallback ${fallbackModel}`);
  }

  if (fallbackModel) {
    const resp = await callGeminiWithRetry({
      ai,
      request: baseRequest,
      model: fallbackModel,
      context,
      logCtx: { ...logCtx, stage: logCtx?.stage || "1A" },
    });
    const validation = isValidImageResponse(resp);
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.info(`[GEMINI][${context}] Fallback attempt with ${fallbackModel} parts=${parts.length} hasImage=${validation.valid}`);

    if (!validation.valid) {
      const reason = validation.reason || "invalid fallback response";
      throw new Error(`Model ${fallbackModel} ${reason}`);
    }

    console.info(`[GEMINI][${context}] Success with fallback model ${fallbackModel}`);
    return { resp, modelUsed: fallbackModel };
  }
}

/**
 * Safe image generation with primary/fallback strategy for Stage 1B and Stage 2
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
  logCtx,
}: {
  stageLabel: "1B" | "2";
  ai: GoogleGenAI;
  baseRequest: Omit<GenerateContentParams, "model">;
  context: string;
  logCtx?: GeminiLogContext;
}): Promise<{ resp: any; modelUsed: string }> {
  const config = stageLabel === "1B" ? MODEL_CONFIG.stage1B : MODEL_CONFIG.stage2;
  const fallbackOverride = process.env.GEMINI_IMAGE_MODEL_FALLBACK?.trim() || null;
  const failoverPolicy = process.env.IMAGE_FAILOVER_POLICY || "gemini_only";
  const primaryModel = config.primary;
  const fallbackModel = failoverPolicy === "gemini_only" ? (fallbackOverride || config.fallback) : null;

  console.log(`[stage${stageLabel}] Primary model: ${primaryModel}, fallback: ${fallbackModel}`);

  // ✅ ATTEMPT PRIMARY MODEL FIRST
  let primaryError: any = null;
  try {
    const resp = await callGeminiWithRetry({
      ai,
      request: baseRequest,
      model: primaryModel,
      context,
      logCtx: { ...logCtx, stage: logCtx?.stage || `stage${stageLabel}` },
    });

    const validation = isValidImageResponse(resp);
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.info(`[GEMINI][${context}] Primary attempt with ${primaryModel} parts=${parts.length} hasImage=${validation.valid}`);

    if (!validation.valid) {
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
    console.warn(`[stage${stageLabel}] Gemini primary failed: ${(err as any)?.message || err} → falling back to ${fallbackModel}`);
  }

  // ✅ ATTEMPT FALLBACK MODEL (if allowed)
  let fallbackError: any = null;
  if (fallbackModel) {
    try {
      console.log(`[stage${stageLabel}] Attempting fallback model: ${fallbackModel}`);
      const resp = await callGeminiWithRetry({
        ai,
        request: baseRequest,
        model: fallbackModel,
        context,
        logCtx: { ...logCtx, stage: logCtx?.stage || `stage${stageLabel}` },
      });

      const validation = isValidImageResponse(resp);
      const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
      console.info(`[GEMINI][${context}] Fallback attempt with ${fallbackModel} parts=${parts.length} hasImage=${validation.valid}`);

      if (!validation.valid) {
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
