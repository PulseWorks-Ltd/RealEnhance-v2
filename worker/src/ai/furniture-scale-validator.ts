// server/ai/furniture-scale-validator.ts

import { GoogleGenAI } from '@google/genai';

export interface FurnitureScaleCheck {
  ok: boolean;
  reason?: string;
  details?: string;
}

/**
 * Validates that furniture maintains realistic proportions and hasn't been shrunk
 * Compares furniture dimensions before/after to detect scaling violations
 */
export async function validateFurnitureScale(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string,
  originalDimensions?: { widthPercent: number; depthPercent: number; type: string }
): Promise<FurnitureScaleCheck> {
  try {
    const dimensionsContext = originalDimensions 
      ? `CRITICAL REFERENCE - Original dominant furniture (${originalDimensions.type}) occupied:
- Width: ${originalDimensions.widthPercent}% of room width
- Depth: ${originalDimensions.depthPercent}% of room depth

The replacement furniture MUST maintain similar proportions (±15% tolerance). Furniture must NOT be shrunk to fit.`
      : '';

    const prompt = `Analyze these two images (original and enhanced) to verify that furniture maintains REALISTIC PROPORTIONS and has NOT been shrunk or undersized.

${dimensionsContext}

CRITICAL FURNITURE SCALE REQUIREMENTS:
- Furniture must maintain realistic proportions relative to room size
- Furniture must NOT be shrunk/downsized to fit layout constraints
- Replacement furniture should occupy similar floor area as original pieces
- Furniture must be appropriately sized for the room (not dollhouse-scale or oversized)

PROPORTIONALITY STANDARDS:
- **Beds (bedrooms)**: Should occupy 35-50% of visible floor area (double/queen), 45-60% for king beds
- **Sofas (living rooms)**: Should occupy 20-35% of floor area depending on type (loveseat vs sectional)
- **Dining tables**: Should occupy 25-40% of floor area depending on seating capacity
- **Coffee tables**: Should be proportional to sofa size (typically 50-65% of sofa length)
- **Side tables/nightstands**: Should reach arm height of adjacent seating/bed

VIOLATIONS TO DETECT:
❌ Furniture appears shrunk or miniaturized compared to room dimensions
❌ Replacement furniture is notably smaller than original pieces without justification
❌ Furniture scaled down to avoid layout conflicts (e.g., tiny sofa to fit more pieces)
❌ Dollhouse-scale furniture that looks unrealistic in the space
❌ Furniture dimensions reduced by >15% from original measurements
❌ Bed/sofa/table that's disproportionately small for the room size
❌ Furniture that appears child-sized in an adult-scale room

ALLOWED VARIATIONS (not violations):
✅ Minor size adjustments (±15%) for better proportions
✅ Different furniture style with similar footprint
✅ Replacement furniture slightly smaller IF still appropriately sized for room
✅ Furniture positioned differently but maintaining realistic scale
✅ Size variation that maintains visual balance and realism

ANALYSIS INSTRUCTIONS:
1. Assess the scale of dominant furniture in original image (bed, sofa, dining table)
2. Assess the scale of replacement furniture in enhanced image
3. Compare proportions: Is the new furniture appropriately sized for the room?
4. Check if furniture appears shrunk to fit layout constraints
5. Verify furniture maintains realistic human-scale proportions
6. If original dimensions provided, verify replacement is within ±15% tolerance

Return JSON with this structure:
{
  "ok": true|false,
  "reason": "brief explanation if violation detected",
  "details": "detailed analysis of furniture proportions (optional)"
}

EXAMPLES:

Example 1 - PASS (appropriate sizing):
Original: King bed occupies 50% of floor area
Enhanced: Queen bed occupies 42% of floor area
Verdict: ok=true (within acceptable range, still appropriately sized)

Example 2 - FAIL (furniture shrunk):
Original: Sectional sofa occupies 35% of floor area
Enhanced: Loveseat occupies 18% of floor area
Verdict: ok=false, reason="Replacement furniture significantly undersized - sofa reduced from 35% to 18% floor coverage, appears shrunk to fit layout"

Example 3 - FAIL (unrealistic proportions):
Original: Standard double bed in medium bedroom
Enhanced: Tiny single bed that looks child-sized in the same space
Verdict: ok=false, reason="Furniture appears miniaturized - bed scaled down unrealistically, looks dollhouse-scale in room"`;

    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { text: "Original image:" },
          { inlineData: { data: originalB64, mimeType: "image/jpeg" } },
          { text: "Enhanced image:" },
          { inlineData: { data: editedB64, mimeType: "image/png" } }
        ]
      }]
    } as any);

    const txt = resp.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";
    console.log("[FURNITURE SCALE VALIDATOR] Raw AI response:", txt);

    // Extract JSON using robust method - find first complete JSON object
    const jsonMatch = txt.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[FURNITURE SCALE VALIDATOR] No JSON found in response");
      return { 
        ok: false, 
        reason: "Unable to parse furniture scale validation response" 
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`[FURNITURE SCALE VALIDATOR] Result: ${parsed.ok ? 'PASS' : 'FAIL'}`);
    if (!parsed.ok) {
      console.log(`[FURNITURE SCALE VALIDATOR] Violation: ${parsed.reason}`);
    }

    return {
      ok: parsed.ok,
      reason: parsed.reason,
      details: parsed.details
    };
  } catch (error) {
    console.error("[FURNITURE SCALE VALIDATOR] Error:", error);
    // Fail safe: if we can't verify scale, reject the edit
    return {
      ok: false,
      reason: "Unable to verify furniture scale preservation - validation error"
    };
  }
}
