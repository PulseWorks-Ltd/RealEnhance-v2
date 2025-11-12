import type { GoogleGenAI } from "@google/genai";
import { logGeminiError } from "../utils/logGeminiError";

// Prefer full image model first, then preview/cheaper variant
const MODEL_FALLBACKS = [
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview",
];

type GenerateContentParams = Parameters<GoogleGenAI['models']['generateContent']>[0];

export async function runWithImageModelFallback(
  ai: GoogleGenAI,
  baseRequest: Omit<GenerateContentParams, "model">,
  context: string
) {
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
