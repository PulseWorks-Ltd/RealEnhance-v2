/**
 * Region Detector for Outdoor Staging
 *
 * Detects and returns the coordinates of suitable outdoor staging areas (deck, patio, verandah, etc.)
 * Can be reused for edit functions and other modules.
 */

export interface StagingRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  areaType: string;
  confidence: string;
  reasoning: string;
}

import type { GoogleGenAI } from "@google/genai";

/**
 * Detects the region for outdoor staging in an exterior image.
 * Returns region coordinates and metadata.
 */
export async function detectStagingRegion(
  ai: GoogleGenAI,
  imageB64: string
): Promise<StagingRegion | null> {
  const prompt = `You are an expert at analyzing outdoor property photos for real estate staging.\n\n[TASK] Identify the exact region (bounding box) of the SUITABLE outdoor staging area for furniture placement.\n\nA suitable staging area MUST meet ALL these criteria:\n- Elevated deck, patio, verandah, balcony, or terrace (not grass, not driveway, not near vehicles)\n- Hard surface, clear boundaries, sufficient space for furniture (min ~2m x 2m)\n- Clearly separated from vehicles/driveways\n\nReturn ONLY valid JSON in this format:\n{\n  \"x\": <left>,\n  \"y\": <top>,\n  \"width\": <width>,\n  \"height\": <height>,\n  \"areaType\": \"deck|patio|verandah|balcony|terrace|none\",\n  \"confidence\": \"high|medium|low\",\n  \"reasoning\": \"Brief explanation\"\n}`;

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/png", data: imageB64 } },
        ],
      }],
    });
    const text = result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
    console.log("[REGION DETECTOR] Raw AI response:", text);
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || text.match(/(\{[\s\S]*?\})/);
    if (!jsonMatch) {
      console.error("[REGION DETECTOR] No JSON found in AI response:", text);
      return null;
    }
    const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]) as StagingRegion;
    console.log("[REGION DETECTOR] Detection result:", parsed);
    if (parsed.areaType === "none") return null;
    return parsed;
  } catch (error) {
    console.error("[REGION DETECTOR] Detection failed:", error);
    return null;
  }
}
