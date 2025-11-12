import type { GoogleGenAI } from "@google/genai";

/**
 * Staging Area Detection for Exterior Scenes
 * 
 * Detects presence of suitable outdoor staging areas (deck, patio, balcony, terrace, verandah)
 * Returns boolean flag to determine if Stage 2 staging should run (saves credits when no area exists)
 */

export interface StagingAreaResult {
  hasStagingArea: boolean;
  areaType: "deck" | "patio" | "balcony" | "terrace" | "verandah" | "none";
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

/**
 * Detect if exterior image has a suitable staging area for furniture placement
 * Uses AI to identify deck/patio/balcony/terrace/verandah with strict criteria
 */
export async function detectStagingArea(
  ai: GoogleGenAI,
  imageB64: string
): Promise<StagingAreaResult> {
  const prompt = `You are an expert at analyzing outdoor property photos for real estate staging.

[TASK] Determine if this exterior image has a SUITABLE staging area for outdoor furniture.

A suitable staging area MUST meet ALL these criteria:
✅ Elevated deck with visible stairs/steps up from ground level OR patio with clear fence/boundary wall separating it from driveways/vehicles
✅ Hard surface already constructed (timber deck, paved patio, concrete pad, stone terrace, verandah flooring)
✅ Clearly separated from any vehicles, driveways, or parking areas
✅ NOT grass, NOT at same level as driveways, NOT near vehicles
✅ Sufficient space for at least one dining table and chairs (minimum ~2m x 2m / 6ft x 6ft)

AREA TYPES:
- deck: Elevated wooden/composite platform with railings or visible steps up
- patio: Ground-level paved area with clear boundary (fence, wall) separating from vehicles/driveways
- balcony: Elevated outdoor space attached to upper floor with railings
- terrace: Elevated stone/tile platform, often with retaining walls or steps
- verandah: Covered outdoor platform along building perimeter, typically elevated
- none: No suitable area exists (includes grass, driveways, areas too close to vehicles)

STRICT RULES:
• If area is grass or at same level as driveway/vehicles → return "none"
• If uncertain about boundaries or vehicle proximity → return "none"
• If area is too small for furniture (< 2m x 2m) → return "none"
• Default to "none" when in doubt - being cautious is correct

Return ONLY valid JSON in this exact format:
{
  "hasStagingArea": true/false,
  "areaType": "deck" | "patio" | "balcony" | "terrace" | "verandah" | "none",
  "confidence": "high" | "medium" | "low",
  "reasoning": "Brief explanation of decision and area characteristics"
}`;

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
    console.log("[STAGING AREA] Raw AI response:", text);
    
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || text.match(/(\{[\s\S]*?\})/);
    if (!jsonMatch) {
      console.error("[STAGING AREA] No JSON found in AI response:", text);
      return {
        hasStagingArea: false,
        areaType: "none",
        confidence: "low",
        reasoning: "Failed to parse AI response",
      };
    }

    const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]) as StagingAreaResult;
    
    console.log(`[STAGING AREA] Detection result:`, {
      hasStagingArea: parsed.hasStagingArea,
      areaType: parsed.areaType,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning
    });

    return parsed;
  } catch (error) {
    console.error("[STAGING AREA] Detection failed:", error);
    return {
      hasStagingArea: false,
      areaType: "none",
      confidence: "low",
      reasoning: "Detection error - defaulting to no staging",
    };
  }
}
