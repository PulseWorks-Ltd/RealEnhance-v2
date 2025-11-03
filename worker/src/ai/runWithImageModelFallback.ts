import type { GoogleGenAI } from "@google/genai";
import { logGeminiError } from "../utils/logGeminiError";

const MODEL_FALLBACKS = [
  "gemini-2.5-flash-image-preview",
  "gemini-2.5-flash-image",
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
      
      console.info(`[GEMINI][${context}] Success with ${model}`);
      return { resp, modelUsed: model };
    } catch (err) {
      logGeminiError(`${context}:${model}`, err);
      lastErr = err;
    }
  }
  
  throw new Error(`[GEMINI][${context}] All fallbacks failed. Last error: ${lastErr?.message || lastErr}`);
}
