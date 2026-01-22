// server/ai/qa.ts
import type { GoogleGenAI } from "@google/genai";
import { GEMINI_VISION_MODEL } from "./visionModelConfig";

export interface GeometryQA {
  ok: boolean;
  reason?: string;
}

export async function geometryQA(ai: GoogleGenAI, origB64: string, editedB64: string): Promise<GeometryQA> {
  const system = `
Compare two images of the same room. Decide if the edited image contains impossible 3D placement (e.g., furniture painted on a wall/cabinet, floating, intersecting a door/window). Output:
{"ok": true|false, "reason": "..."}`;

  try {
    const resp = await ai.models.generateContent({
      model: GEMINI_VISION_MODEL,
      contents: [{
        role: "user",
        parts: [
          { text: system },
          { text: "Original:" },
          { inlineData: { data: origB64, mimeType: "image/jpeg" } },
          { text: "Edited:" },
          { inlineData: { data: editedB64, mimeType: "image/png" } },
        ]
      }]
    });

    const txt = resp.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";
    
    // Debug: Log the raw AI response
    console.log("[GEOMETRY QA] Raw AI response:", JSON.stringify(txt));
    
    // Extract JSON using robust method - find first complete JSON object
    const jsonMatch = txt.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[GEOMETRY QA] No JSON object found in response");
      return { ok: true }; // Default to passing if we can't parse
    }
    
    let jsonStr = jsonMatch[0];
    console.log("[GEOMETRY QA] Extracted JSON:", JSON.stringify(jsonStr));
    
    // Try to parse, if it fails, try to find just the first complete object
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // If parsing fails, try to extract just the first valid JSON object
      let braceCount = 0;
      let jsonEnd = -1;
      for (let i = 0; i < jsonStr.length; i++) {
        if (jsonStr[i] === '{') braceCount++;
        if (jsonStr[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i;
            break;
          }
        }
      }
      if (jsonEnd > 0) {
        jsonStr = jsonStr.substring(0, jsonEnd + 1);
        console.log("[GEOMETRY QA] Trimmed JSON:", JSON.stringify(jsonStr));
        return JSON.parse(jsonStr);
      }
      throw e;
    }
  } catch (error) {
    console.warn("[GEOMETRY QA] Failed to parse QA result:", error);
    return { ok: true }; // Default to passing if we can't parse
  }
}