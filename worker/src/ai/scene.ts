// server/ai/scene.ts
import type { GoogleGenAI } from "@google/genai";
import { GEMINI_VISION_MODEL } from "./visionModelConfig";

export interface ScenePlane {
  type: "floor" | "wall";
  mask?: "rle" | "none";
  bbox: [number, number, number, number];
}

export interface FixedFeature {
  type: "door" | "window" | "cabinet" | "appliance";
  bbox: [number, number, number, number];
}

export interface FreeFloorArea {
  bbox: [number, number, number, number];
}

export interface SceneAnalysis {
  planes: ScenePlane[];
  fixedFeatures: FixedFeature[];
  freeFloorAreas: FreeFloorArea[];
}

export async function analyzeScene(ai: GoogleGenAI, imageBase64: string): Promise<SceneAnalysis | null> {
  const system = `
Return JSON describing the scene planes and fixed features.

Format:
{
  "planes": [{"type":"floor"|"wall","mask":"rle|none","bbox":[x,y,w,h]}],
  "fixedFeatures":[{"type":"door"|"window"|"cabinet"|"appliance","bbox":[x,y,w,h]}],
  "freeFloorAreas":[{"bbox":[x,y,w,h]}]
}

Rules:
- "freeFloorAreas" are approximate rectangles on the FLOOR plane not occluded by fixed features.
- If unsure, be conservative.
ONLY JSON. No extra text.`;

  try {
    const resp = await ai.models.generateContent({
      model: GEMINI_VISION_MODEL,
      contents: [{
        role: "user",
        parts: [
          { text: system },
          { inlineData: { data: imageBase64, mimeType: "image/jpeg" } }
        ]
      }]
    });

    const text = resp.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";
    
    // Debug: Log the raw AI response
    console.log("[SCENE ANALYSIS] Raw AI response:", JSON.stringify(text));
    
    // Extract JSON using robust method - find first complete JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[SCENE ANALYSIS] No JSON object found in response");
      return null;
    }
    
    let jsonStr = jsonMatch[0];
    console.log("[SCENE ANALYSIS] Extracted JSON:", JSON.stringify(jsonStr));
    
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
        console.log("[SCENE ANALYSIS] Trimmed JSON:", JSON.stringify(jsonStr));
        return JSON.parse(jsonStr);
      }
      throw e;
    }
  } catch (error) {
    console.warn("[SCENE ANALYSIS] Failed to parse scene analysis:", error);
    return null;
  }
}

export function buildSceneConstraints(scene: SceneAnalysis | null): string {
  if (!scene) return "";

  const constraints: string[] = [];

  if (scene.freeFloorAreas?.length) {
    const hints = scene.freeFloorAreas.map(a => `floor bbox [${a.bbox.join(", ")}]`).join("; ");
    constraints.push(`Place any added furniture within these free floor regions: ${hints}. Do not use wall/cabinet planes.`);
  }

  if (scene.fixedFeatures?.length) {
    constraints.push(`Avoid overlap with fixed features: ${scene.fixedFeatures.map(f => f.type).join(", ")}.`);
  }

  return constraints.join(" ");
}