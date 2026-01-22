import type { GoogleGenAI } from "@google/genai";
import { GEMINI_VISION_MODEL } from "./visionModelConfig";

interface PerspectiveCheck {
  ok: boolean;
  reason?: string;
  details?: string;
}

export async function validatePerspectivePreservation(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string
): Promise<PerspectiveCheck> {
  try {
    const prompt = `Analyze these two images (original and enhanced) to verify that the CAMERA VIEWPOINT and PERSPECTIVE remain EXACTLY the same. The enhanced image must be photographed from the SAME camera position and angle as the original.

CRITICAL PERSPECTIVE REQUIREMENTS (must remain IDENTICAL):
- Camera position: The camera must be in the exact same physical location
- Camera angle: The viewing angle (up/down/left/right tilt) must be identical
- Vanishing points: Perspective lines must converge to the same vanishing points
- Viewing direction: The camera must be pointed in the same direction
- Height level: The camera height above floor must be the same
- Horizon line: The horizon/eye level must be at the same position in the frame

VIOLATIONS TO DETECT:
❌ Camera moved to a different position in the room (e.g., from doorway to center)
❌ Camera angle changed (e.g., looking more downward or upward)
❌ Viewing direction changed (e.g., was facing north wall, now facing east wall)
❌ Camera height changed (e.g., was eye-level, now from higher up)
❌ Perspective lines/vanishing points in different locations
❌ Same room but photographed from completely different viewpoint
❌ Architectural features appear from different angles (e.g., corner visible from new angle)
❌ Walls or features that were on left/right sides swapped positions

ALLOWED CHANGES (not violations):
✅ Image quality improvements (exposure, color, sharpness)
✅ Furniture or decor changes within the same viewpoint
✅ Minor lens distortion correction WITHOUT changing viewpoint
✅ Cropping that maintains the same perspective
✅ Same architectural view with enhanced staging

ANALYSIS INSTRUCTIONS:
1. Identify key architectural reference points (corners, door frames, window positions)
2. Check if these reference points maintain the same spatial relationships
3. Verify perspective lines (floor/ceiling lines, wall edges) converge to same vanishing points
4. Look for evidence of camera position or angle change:
   - Different walls become visible
   - Corners appear/disappear
   - Relative positions of architectural features change
   - Horizon line shifts vertically
5. Compare the viewing angle and ensure it's identical

MANDATORY RESPONSE FORMAT:
- If camera viewpoint or perspective has changed: ok=false
- The "reason" field MUST start with "Perspective violation: " followed by the specific issue
- Examples: "Perspective violation: Camera moved from doorway to room center - different viewpoint"
           "Perspective violation: Viewing angle changed - was level, now looking downward"
           "Perspective violation: Same room but photographed from opposite wall"

Compare the images and return JSON with this EXACT structure:
{
  "original_viewpoint": "brief description of camera position/angle",
  "enhanced_viewpoint": "brief description of camera position/angle",
  "viewpoint_changed": "YES or NO",
  "perspective_analysis": "description of perspective comparison",
  "ok": true/false,
  "reason": "MUST start with 'Perspective violation: ' if ok=false, empty if ok=true",
  "details": "Specific violation detected, empty if ok=true"
}

CRITICAL VALIDATION:
- If viewpoint_changed is "YES": ok MUST be false
- If camera position, angle, or viewing direction differs: ok MUST be false
- If response shows perspective change in any form: ok MUST be false with reason "Perspective violation: ..."

CRITICAL: The camera viewpoint is locked. ANY change in camera position, angle, or viewing direction MUST be reported as "Perspective violation: ..." to ensure critical handling.`;

    const result = await ai.models.generateContent({
      model: GEMINI_VISION_MODEL,
      contents: [
        { inlineData: { mimeType: "image/png", data: originalB64 } },
        { inlineData: { mimeType: "image/png", data: editedB64 } },
        { text: prompt }
      ]
    });

    const text = result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
    console.log("[PERSPECTIVE DETECTOR] Raw AI response:", text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[PERSPECTIVE DETECTOR] No JSON found in response - FAILING SAFE");
      return {
        ok: false,
        reason: "Perspective violation: Unable to verify perspective preservation - response format error"
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
      console.log("[PERSPECTIVE DETECTOR] Parsed result:", parsed);
    } catch (parseError) {
      console.error("[PERSPECTIVE DETECTOR] JSON parse error - FAILING SAFE:", parseError);
      return {
        ok: false,
        reason: "Perspective violation: Unable to verify perspective preservation - JSON parse error"
      };
    }

    if (parsed.ok === undefined) {
      console.error("[PERSPECTIVE DETECTOR] Missing 'ok' field - FAILING SAFE");
      return {
        ok: false,
        reason: "Perspective violation: Unable to verify perspective preservation - invalid response"
      };
    }

    // Check viewpoint_changed flag
    const viewpointChanged = String(parsed.viewpoint_changed || "").trim().toUpperCase();
    if (viewpointChanged === "YES") {
      console.error("[PERSPECTIVE DETECTOR] Viewpoint changed - PERSPECTIVE VIOLATION DETECTED");
      parsed.ok = false;
      if (!parsed.reason || !String(parsed.reason).toLowerCase().includes("perspective violation")) {
        parsed.reason = `Perspective violation: Camera viewpoint changed between original and enhanced images`;
      }
    }

    // Enforce "Perspective violation:" prefix
    if (parsed.ok === false && parsed.reason) {
      const reason = String(parsed.reason).trim();
      if (!reason.toLowerCase().startsWith("perspective violation")) {
        parsed.reason = `Perspective violation: ${reason}`;
      }
    }

    return {
      ok: parsed.ok,
      reason: parsed.reason || undefined,
      details: parsed.details || undefined
    };
  } catch (error) {
    console.error("[PERSPECTIVE DETECTOR] Unexpected error - FAILING SAFE:", error);
    return {
      ok: false,
      reason: "Perspective violation: Unable to verify perspective preservation - unexpected error"
    };
  }
}
