import { GoogleGenAI } from "@google/genai";
import { GEMINI_VISION_MODEL } from "./visionModelConfig";

export type LayoutPlan = {
  roomType: 'living' | 'kitchen' | 'dining' | 'bedroom' | 'office' | 'unknown';
  vignettes: Array<{
    type: 'seating' | 'dining' | 'bedroom' | 'reading' | 'kitchen-accent' | 'breakfast-bar';
    placement: 'left' | 'right' | 'center' | 'near-window' | 'opposite-window';
    items: string[];
    notes?: string;
  }>;
  omit: string[];
};

async function callGeminiText(prompt: string): Promise<string> {
  if (!process.env.REALENHANCE_API_KEY) {
    throw new Error("REALENHANCE_API_KEY not configured");
  }
  
  const ai = new GoogleGenAI({ apiKey: process.env.REALENHANCE_API_KEY });
  const resp = await ai.models.generateContent({
    model: GEMINI_VISION_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });
  return resp.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
}

export async function planLayout(userGoal: string, constraints: string): Promise<LayoutPlan> {
  const prompt = `
You are planning a photorealistic staging layout for a real-estate photo. Return JSON only.
Identify a roomType and propose 1–2 vignettes sized to the space (avoid bunching), following these targets:
• living → sofa + coffee table + rug (primary), optional accent chair + plant
• kitchen → "kitchen-accent" (fruit bowl, plant, tray, coffee machine) + optional "breakfast-bar" (2 stools tucked)
• dining → table + 4–6 chairs + centerpiece
• bedroom → bed + 2 nightstands + lamps + rug

Hard constraints:
${constraints}

JSON shape:
{
  "roomType":"living|kitchen|dining|bedroom|office|unknown",
  "vignettes":[{"type":"...","placement":"center","items":["..."],"notes":"..."}],
  "omit":[]
}
User goal: ${userGoal}
`.trim();

  try {
    const text = await callGeminiText(prompt);
    return JSON.parse(text) as LayoutPlan;
  } catch (error) {
    // Safe fallback if REALENHANCE_API_KEY is missing or JSON parsing fails
    console.warn('[PLANNER] Planning failed, using safe fallback:', error);
    return { roomType: 'unknown' as const, vignettes: [], omit: [] };
  }
}