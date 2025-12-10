// server/ai/wall-plane-validator.ts

import { GoogleGenAI } from '@google/genai';

export interface WallPlaneCheck {
  ok: boolean;
  reason?: string;
  details?: string;
}

/**
 * Validates that NO new wall planes or partitions have been added
 * Detects semantic segmentation differences to catch fabricated walls
 */
export async function validateWallPlanes(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string
): Promise<WallPlaneCheck> {
  try {
    const prompt = `Analyze these two images (original and enhanced) to verify that NO NEW WALLS, WALL PLANES, OR PARTITIONS have been added.

This is a CRITICAL architectural preservation check. The enhanced image must use ONLY the wall surfaces that existed in the original.

CRITICAL WALL PLANE REQUIREMENTS:
- NO new walls created to provide surfaces for furniture placement
- NO new partitions or dividers added to separate spaces
- NO wall extensions or additions to create convenient mounting surfaces
- ALL wall surfaces in enhanced image must have existed in original
- Blank/empty wall areas must remain as-is (adding a wall to fill space is a violation)

VIOLATIONS TO DETECT:
❌ NEW wall plane added (e.g., wall created on left/right side to mount TV unit)
❌ False partition added to provide furniture backing
❌ Wall extension to create surface where none existed
❌ Solid surface fabricated in previously open/empty corner
❌ New vertical plane added that wasn't in original architecture
❌ Wall segment created to solve furniture placement challenge
❌ Partition or divider added to separate open spaces

EXAMPLE VIOLATIONS:

Example 1 - CRITICAL VIOLATION:
Original: Open corner with no wall
Enhanced: Wall added along left side for TV unit placement
Verdict: ok=false, reason="New wall plane added on left side - wall fabricated to accommodate TV unit"

Example 2 - CRITICAL VIOLATION:
Original: Empty back corner visible
Enhanced: Partition/wall added in corner to back furniture
Verdict: ok=false, reason="Partition added in back corner - false wall created for furniture backing"

Example 3 - CRITICAL VIOLATION:
Original: Open right side, no wall surface
Enhanced: Wall surface added on right to mount shelving
Verdict: ok=false, reason="Wall plane fabricated on right side for shelving mount point"

ALLOWED CHANGES (not violations):
✅ Furniture placed against EXISTING walls
✅ Wall paint/color changes
✅ Lighting changes on existing walls
✅ Texture or finish improvements to existing walls
✅ Existing walls shown from slightly different angle (minor perspective)
✅ Same architectural walls with enhanced quality

ANALYSIS INSTRUCTIONS:
1. Identify all wall planes/surfaces in ORIGINAL image
   - Count distinct wall surfaces (left wall, right wall, back wall, etc.)
   - Note which walls/surfaces exist in the architecture
2. Identify all wall planes/surfaces in ENHANCED image
   - Count distinct wall surfaces
   - Compare to original count and positions
3. Check for NEW wall planes that weren't in original:
   - New vertical surfaces added in corners
   - New partitions or dividers
   - Wall extensions or additions
   - Fabricated surfaces for furniture placement
4. CRITICAL: If enhanced has MORE wall surfaces than original → FAIL
5. CRITICAL: If new solid plane appears where there was open space → FAIL

Return JSON with this structure:
{
  "ok": true|false,
  "reason": "explanation if new wall detected",
  "details": "detailed analysis of wall planes (optional)"
}

⚠️ ZERO TOLERANCE: Any new wall plane, partition, or solid vertical surface that wasn't in the original = AUTOMATIC FAILURE
⚠️ PREFERENCE: Leaving blank space is better than fabricating false architecture`;

    const resp = await ai.models.generateContent({
      model: gemini-2.0-flash,
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
    console.log("[WALL PLANE VALIDATOR] Raw AI response:", txt);

    // Extract JSON
    const jsonMatch = txt.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[WALL PLANE VALIDATOR] No JSON found in response");
      return { 
        ok: false, 
        reason: "Unable to parse wall plane validation response" 
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`[WALL PLANE VALIDATOR] Result: ${parsed.ok ? 'PASS' : 'FAIL'}`);
    if (!parsed.ok) {
      console.log(`[WALL PLANE VALIDATOR] Violation: ${parsed.reason}`);
    }

    return {
      ok: parsed.ok,
      reason: parsed.reason,
      details: parsed.details
    };
  } catch (error) {
    console.error("[WALL PLANE VALIDATOR] Error:", error);
    // Fail safe: if we can't verify no new walls, reject the edit
    return {
      ok: false,
      reason: "Unable to verify wall plane preservation - validation error"
    };
  }
}
