import { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";

/**
 * Helper function to call Gemini with an image and get JSON response
 * Uses Gemini 1.5 Flash for detection tasks (cost-effective, fast)
 * Configuration: temperature=0 (deterministic), JSON-only output mode
 * Reuses existing Gemini pattern from other detectors
 */
export async function callGeminiJsonOnImage(
  imagePath: string,
  prompt: string
): Promise<{ json: any; raw: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const ai = new GoogleGenAI({ apiKey });

  // Read image as base64
  const imageBuffer = await fs.readFile(imagePath);
  const imageB64 = imageBuffer.toString("base64");

  try {
    // Use Gemini 1.5 Flash for detection tasks with temperature 0 (deterministic)
    const resp = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: [
        { inlineData: { mimeType: "image/png", data: imageB64 } },
        { text: prompt },
      ],
      generationConfig: {
        temperature: 0,  // Deterministic, consistent responses
        responseMimeType: "application/json",  // Force JSON-only output
      },
    } as any);

    const raw = resp.text || "";

    // Try to extract JSON from response
    let json: any = null;
    try {
      // Try direct parse first
      json = JSON.parse(raw);
    } catch {
      // Try to extract JSON from markdown code blocks
      const match = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (match) {
        json = JSON.parse(match[1]);
      } else {
        // Try to find raw JSON object
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          json = JSON.parse(jsonMatch[0]);
        }
      }
    }

    return { json, raw };
  } catch (error: any) {
    console.error("[GEMINI-JSON] Error calling Gemini", {
      error: error?.message || String(error),
    });
    throw error;
  }
}
