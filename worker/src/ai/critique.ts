import type { GoogleGenAI } from "@google/genai";
import type { LayoutPlan } from "./planner";

async function callGeminiText(ai: GoogleGenAI, prompt: string): Promise<string> {
  const resp = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });
  return resp.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
}

export async function critiqueSpacing(ai: GoogleGenAI, userGoal: string, planJSON: LayoutPlan): Promise<string> {
  const prompt = `
Assess this staging plan for cramped/bunched layout. Return "OK" or "BUNCHED: reason".
Goal: ${userGoal}
Plan: ${JSON.stringify(planJSON)}
Rules: maintain 30–60cm walkways, 10–20cm off walls, balanced distribution, realistic scale.
  `.trim();

  const out = (await callGeminiText(ai, prompt)).trim();
  return out.startsWith('BUNCHED') ? out : 'OK';
}