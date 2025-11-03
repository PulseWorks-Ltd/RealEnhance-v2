// server/ai/windowDetector.ts
import type { GoogleGenAI } from "@google/genai";

export interface WindowDetection {
  windowCount: number;
  windows: Array<{
    id: string;
    bbox: [number, number, number, number]; // [x, y, width, height]
    confidence: number;
  }>;
  detectionFailed?: boolean; // Indicates if detection failed (vs legitimately 0 windows)
}

export async function detectWindows(ai: GoogleGenAI, imageB64: string): Promise<WindowDetection> {
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { inlineData: { mimeType: "image/png", data: imageB64 } },
        { 
          text: `Analyze this image and detect ALL windows. Return only a JSON response with this exact format:
{
  "windowCount": <number>,
  "windows": [
    {
      "id": "window_1",
      "bbox": [x, y, width, height],
      "confidence": <0.0-1.0>
    }
  ]
}

Requirements:
- Count ALL visible windows including partially visible ones
- Provide bounding box coordinates as [x, y, width, height] 
- Include confidence score (0.0-1.0)
- Return ONLY the JSON, no explanation text`
        }
      ]
    });

    const parts: any[] = resp.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((x: any) => x.text);
    if (!textPart) throw new Error("No text response from window detection");

    const rawText = textPart.text;
    
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/) || rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[WINDOW DETECTOR] No JSON found in response:", rawText.substring(0, 200));
      throw new Error("No JSON found in response");
    }
    
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const detection = JSON.parse(jsonStr.trim()) as WindowDetection;
    
    console.log(`[WINDOW DETECTOR] Detected ${detection.windowCount} windows`);
    return detection;
    
  } catch (error) {
    console.error("[WINDOW DETECTOR] Failed to detect windows:", error);
    // Return detectionFailed flag so validator knows this is a failure, not "0 windows"
    return { windowCount: 0, windows: [], detectionFailed: true };
  }
}

export async function validateWindowPreservation(
  ai: GoogleGenAI, 
  originalB64: string, 
  editedB64: string,
  userProvidedOriginalCount?: number
): Promise<{ ok: boolean; reason?: string }> {
  try {
    let originalCount: number;
    
    // If user provided original count, use it directly (skip AI detection on original)
    if (userProvidedOriginalCount !== undefined) {
      originalCount = userProvidedOriginalCount;
      console.log(`[WINDOW VALIDATOR] Using user-provided original count: ${originalCount} windows`);
    } else {
      // Otherwise detect windows in original image
      const originalWindows = await detectWindows(ai, originalB64);
      
      // If detection failed, assume windows are preserved (fail open)
      if (originalWindows.detectionFailed) {
        console.log("[WINDOW VALIDATOR] Original detection failed, assuming windows preserved");
        return { ok: true };
      }
      
      originalCount = originalWindows.windowCount;
      console.log(`[WINDOW VALIDATOR] AI-detected original count: ${originalCount} windows`);
    }
    
    // Always detect windows in edited image
    const editedWindows = await detectWindows(ai, editedB64);
    
    // If edited detection failed, assume windows are preserved (fail open)
    if (editedWindows.detectionFailed) {
      console.log("[WINDOW VALIDATOR] Edited detection failed, assuming windows preserved");
      return { ok: true };
    }

    // Simple validation: Window count must match exactly
    // Trusts the prompt to preserve window positioning correctly
    if (originalCount !== editedWindows.windowCount) {
      console.log(`[WINDOW VALIDATOR] Window count mismatch: ${originalCount} → ${editedWindows.windowCount}`);
      
      // Provide user-friendly error message
      const countSource = userProvidedOriginalCount !== undefined ? "you indicated" : "detected";
      return {
        ok: false,
        reason: `Retry created ${editedWindows.windowCount} window opening${editedWindows.windowCount !== 1 ? 's' : ''}, but ${countSource} ${originalCount} in the original image`
      };
    }

    console.log(`[WINDOW VALIDATOR] Window count preserved: ${originalCount} windows`);
    return { ok: true };
    
  } catch (error) {
    console.error("[WINDOW VALIDATOR] Validation failed:", error);
    // On validation failure, assume windows are preserved (fail open)
    return { ok: true };
  }
}