import type { GoogleGenAI } from "@google/genai";
import { logGeminiError } from "../utils/logGeminiError";

// Model selection based on stage:
// - Stage 1A: gemini-2.0-flash-image (optimized for enhancement)
// - Stage 1B/2: gemini-2.5-flash-image (advanced capabilities for declutter/staging)
const MODEL_FALLBACKS_1A = [
  "gemini-2.0-flash-image",
];

const MODEL_FALLBACKS_DEFAULT = [
  "gemini-2.5-flash-image",
];

type GenerateContentParams = Parameters<GoogleGenAI['models']['generateContent']>[0];

export async function runWithImageModelFallback(
  ai: GoogleGenAI,
  baseRequest: Omit<GenerateContentParams, "model">,
  context: string
) {
  // Select model list based on context (Stage 1A uses 2.0 Flash)
  const isStage1A = context.toLowerCase().includes("1a") || context.toLowerCase().includes("enhance");
  const MODEL_FALLBACKS = isStage1A ? MODEL_FALLBACKS_1A : MODEL_FALLBACKS_DEFAULT;
  let lastErr: any;
  
  for (const model of MODEL_FALLBACKS) {
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
  
  throw new Error(`[GEMINI][${context}] All fallbacks failed. Last error: ${lastErr?.message || lastErr}`);
}
