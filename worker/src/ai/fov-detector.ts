import type { GoogleGenAI } from "@google/genai";
import { GEMINI_VISION_MODEL } from "./visionModelConfig";

interface FovCheck {
  ok: boolean;
  reason?: string;
  details?: string;
}

export async function validateFieldOfView(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string
): Promise<FovCheck> {
  try {
    const prompt = `Analyze these two images (original and enhanced) to verify that the enhanced image does NOT expand the field of view or invent architectural spaces beyond the original photo's boundaries.

CRITICAL FIELD-OF-VIEW REQUIREMENTS:
- Camera framing: The enhanced image must show the EXACT same spatial coverage as the original
- No zoom out: The view must not be wider or reveal more area than originally captured
- No room invention: Spaces, rooms, or architectural elements outside the original frame must NOT be added
- Same boundaries: The physical boundaries of the photographed space must be identical
- Same coverage area: The total visible floor area, wall area, and architectural footprint must match the original

VIOLATIONS TO DETECT:
❌ Enhanced image shows MORE rooms than original (e.g., original shows kitchen, enhanced shows kitchen + invented living room)
❌ Camera view "zoomed out" to reveal spaces that were outside the original frame
❌ Architectural elements added beyond original photo boundaries (walls, floors, ceilings in areas that weren't photographed)
❌ Field of view expanded to show more of the space than originally captured
❌ New spatial areas invented that didn't exist in the original photograph
❌ Background or peripheral areas fabricated beyond the original frame edges

ALLOWED CHANGES (not violations):
✅ Enhanced lighting, colors, or image quality within the same frame
✅ Furniture or decor changes within the existing photographed space
✅ Surface cleaning or texture improvements in areas that were already visible
✅ Minor perspective correction without expanding coverage area
✅ Same room shown with different styling, as long as spatial boundaries are identical

ANALYSIS INSTRUCTIONS:
1. Identify the spatial boundaries and coverage area of the original photo (what rooms/spaces are visible)
2. Identify the spatial boundaries and coverage area of the enhanced image
3. Check if the enhanced image shows MORE architectural space than the original
4. Look specifically for:
   - Invented rooms beyond original frame (e.g., living room added when only kitchen was photographed)
   - Expanded floor area or wall coverage
   - "Zoomed out" effect revealing peripheral spaces
   - Background spaces fabricated outside original boundaries
5. Verify the enhanced image contains ONLY the spaces that were captured in the original

MANDATORY RESPONSE FORMAT:
- If enhanced image shows MORE space than original: ok=false
- The "reason" field MUST start with "Field-of-view violation: " followed by the specific issue
- Examples: "Field-of-view violation: enhanced image invented living room not present in original kitchen photo"
            "Field-of-view violation: camera view zoomed out to reveal spaces beyond original frame"
            "Field-of-view violation: expanded coverage area shows more architectural space than originally captured"

Compare the images and return JSON with this EXACT structure:
{
  "original_spaces": ["list all rooms/spaces visible in original"],
  "enhanced_spaces": ["list all rooms/spaces visible in enhanced"],
  "spatial_expansion": "YES or NO - does enhanced show more architectural space?",
  "ok": true/false,
  "reason": "MUST start with 'Field-of-view violation: ' if ok=false, empty if ok=true",
  "details": "Specific violation detected, empty if ok=true"
}

CRITICAL VALIDATION:
- If spatial_expansion is "YES": ok MUST be false
- If enhanced_spaces contains more items than original_spaces: ok MUST be false
- If response shows field-of-view expansion in any form: ok MUST be false with reason "Field-of-view violation: ..."

CRITICAL: The camera view and spatial boundaries are locked. ANY expansion of field-of-view or invention of spaces beyond original photo boundaries MUST be reported as "Field-of-view violation: ..." to ensure critical handling.`;

    const result = await ai.models.generateContent({
      model: GEMINI_VISION_MODEL,
      contents: [
        { inlineData: { mimeType: "image/png", data: originalB64 } },
        { inlineData: { mimeType: "image/png", data: editedB64 } },
        { text: prompt }
      ]
    });

    const text = result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
    console.log("[FOV DETECTOR] Raw AI response:", text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[FOV DETECTOR] No JSON found in response - FAILING SAFE");
      console.log("[FOV DETECTOR] Full response text:", text);
      // Fail safe: cannot verify FOV preservation without valid response
      return {
        ok: false,
        reason: "Field-of-view violation: Unable to verify field-of-view preservation - response format error",
        details: "FOV detector failed to parse response - treating as potential FOV expansion for safety"
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
      console.log("[FOV DETECTOR] Parsed result:", parsed);
    } catch (parseError) {
      console.error("[FOV DETECTOR] JSON parse error - FAILING SAFE:", parseError);
      console.log("[FOV DETECTOR] Raw JSON:", jsonMatch[0]);
      // Fail safe: cannot verify FOV preservation with malformed JSON
      return {
        ok: false,
        reason: "Field-of-view violation: Unable to verify field-of-view preservation - JSON parse error",
        details: "FOV detector received malformed JSON - treating as potential FOV expansion for safety"
      };
    }

    // Validate response structure
    if (parsed.ok === undefined) {
      console.error("[FOV DETECTOR] Missing 'ok' field in response - FAILING SAFE");
      console.log("[FOV DETECTOR] Parsed object:", JSON.stringify(parsed));
      // Fail safe: cannot verify FOV preservation with invalid structure
      return {
        ok: false,
        reason: "Field-of-view violation: Unable to verify field-of-view preservation - invalid response structure",
        details: "FOV detector response missing required field - treating as potential FOV expansion for safety"
      };
    }

    // CRITICAL: Validate structured response for spatial expansion detection
    if (Array.isArray(parsed.original_spaces) && Array.isArray(parsed.enhanced_spaces)) {
      console.log("[FOV DETECTOR] Original spaces:", parsed.original_spaces);
      console.log("[FOV DETECTOR] Enhanced spaces:", parsed.enhanced_spaces);
      console.log("[FOV DETECTOR] Spatial expansion:", parsed.spatial_expansion);
      
      // Check if enhanced has more spaces than original
      if (parsed.enhanced_spaces.length > parsed.original_spaces.length) {
        console.error("[FOV DETECTOR] Enhanced image has MORE spaces than original - FOV EXPANSION DETECTED");
        parsed.ok = false;
        if (!parsed.reason || !String(parsed.reason).toLowerCase().includes("field-of-view violation")) {
          parsed.reason = `Field-of-view violation: enhanced image shows ${parsed.enhanced_spaces.length} spaces but original only shows ${parsed.original_spaces.length}`;
        }
      }
      
      // Check spatial_expansion flag
      const expansionFlag = String(parsed.spatial_expansion || "").trim().toUpperCase();
      if (expansionFlag === "YES") {
        console.error("[FOV DETECTOR] Spatial expansion flag is YES - FOV EXPANSION DETECTED");
        parsed.ok = false;
        if (!parsed.reason || !String(parsed.reason).toLowerCase().includes("field-of-view violation")) {
          parsed.reason = `Field-of-view violation: AI detected spatial expansion beyond original boundaries`;
        }
      }
      
      // HEURISTIC SANITY CHECK: Look for inconsistencies between reason/details and expansion flag
      const reasonText = String(parsed.reason || "").toLowerCase();
      const detailsText = String(parsed.details || "").toLowerCase();
      const combinedText = `${reasonText} ${detailsText}`;
      
      const mentionsExpansion = /expand|zoom.*out|invent|fabricat|reveal|more.*space|more.*room|beyond.*frame|beyond.*boundar/.test(combinedText);
      
      if (mentionsExpansion && expansionFlag !== "YES" && parsed.ok === true) {
        console.error("[FOV DETECTOR] INCONSISTENCY DETECTED: AI mentions expansion but says NO expansion with ok=true");
        console.error("[FOV DETECTOR] Reason:", parsed.reason);
        console.error("[FOV DETECTOR] Details:", parsed.details);
        console.error("[FOV DETECTOR] Expansion flag:", parsed.spatial_expansion);
        // Force violation - AI is contradicting itself
        parsed.ok = false;
        parsed.reason = `Field-of-view violation: Inconsistent response - mentions expansion but marked as no expansion`;
      }
    } else {
      // FAIL-SAFE: If AI didn't provide structured arrays, we cannot trust the result
      console.error("[FOV DETECTOR] FAIL-SAFE: Missing structured space arrays - cannot verify FOV preservation");
      // Only fail safe if AI said ok=true without providing validation arrays
      if (parsed.ok === true) {
        console.error("[FOV DETECTOR] AI returned ok=true without spatial validation - REJECTING");
        return {
          ok: false,
          reason: "Field-of-view violation: Unable to verify spatial boundary preservation - no structural validation provided",
          details: "AI response missing required space arrays - treating as potential FOV expansion for safety"
        };
      }
      // If AI already said ok=false, allow it through (it detected some other violation)
      console.warn("[FOV DETECTOR] AI response missing structured space arrays but already flagged a violation");
    }

    // CRITICAL: Enforce "Field-of-view violation:" prefix on all violations to ensure critical classification
    if (parsed.ok === false && parsed.reason) {
      const reason = String(parsed.reason).trim();
      // If AI returned a violation but forgot the prefix, add it
      if (!reason.toLowerCase().startsWith("field-of-view violation")) {
        console.warn("[FOV DETECTOR] AI response missing required 'Field-of-view violation:' prefix, enforcing...");
        console.log("[FOV DETECTOR] Original reason:", reason);
        parsed.reason = `Field-of-view violation: ${reason}`;
        console.log("[FOV DETECTOR] Enforced reason:", parsed.reason);
      }
    }

    return {
      ok: parsed.ok,
      reason: parsed.reason || undefined,
      details: parsed.details || undefined
    };
  } catch (error) {
    console.error("[FOV DETECTOR] Unexpected error - FAILING SAFE:", error);
    // Fail safe: treat any unexpected error as potential FOV violation
    return {
      ok: false,
      reason: "Field-of-view violation: Unable to verify field-of-view preservation - unexpected error",
      details: error instanceof Error ? error.message : "Unknown error in FOV detector"
    };
  }
}
