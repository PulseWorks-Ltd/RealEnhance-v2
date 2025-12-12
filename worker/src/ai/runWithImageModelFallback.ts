import type { GoogleGenAI } from "@google/genai";
import { logGeminiError } from "../utils/logGeminiError";

// ✅ HARD LOCK: Only supported Gemini image model
// All stages (1A, 1B, 2) use gemini-3-pro-image-preview (Gemini 3 Pro Image)
// No fallbacks - fail loudly if unavailable
const IMAGE_MODELS = [
  "gemini-3-pro-image-preview",
];

// ✅ No legacy fallbacks allowed — all deprecated
const fallbackModels: string[] = [];

type GenerateContentParams = Parameters<GoogleGenAI['models']['generateContent']>[0];

export async function runWithImageModelFallback(
  ai: GoogleGenAI,
  baseRequest: Omit<GenerateContentParams, "model">,
  context: string
) {
  // ✅ All stages use Gemini 3 Pro Image - no stage-specific logic needed
  let lastErr: any;
  
  for (const model of IMAGE_MODELS) {
    try {
      const resp = await ai.models.generateContent({
        ...baseRequest,
        model,
      });
      const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
      const hasImage = parts.some(p => p.inlineData?.data);
      console.info(`[GEMINI][${context}] Attempt with ${model} parts=${parts.length} hasImage=${hasImage}`);
      if (hasImage) {
        console.info(`[GEMINI][${context}] Success with ${model}`);
        return { resp, modelUsed: model };
      }
      throw new Error(`Model ${model} returned no inline image data`);
    } catch (err) {
      logGeminiError(`${context}:${model}`, err);
      lastErr = err;
    }
  }
  
  console.error(`❌ FATAL: Gemini 3 Pro Image unavailable — cannot continue AI pipeline.`);
  throw new Error(`[GEMINI][${context}] Gemini 3 Pro Image model unavailable – aborting job. Last error: ${lastErr?.message || lastErr}`);
}
