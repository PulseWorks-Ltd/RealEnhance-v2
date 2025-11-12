import type { GoogleGenAI } from "@google/genai";

interface WallCheck {
  ok: boolean;
  reason?: string;
  details?: string;
}

export async function validateWallPreservation(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string
): Promise<WallCheck> {
  try {
    const prompt = `Analyze these two images (original and edited) to verify that ALL WALLS and OPENINGS remain EXACTLY the same - no extensions, shortenings, repositioning, reshaping, closing of open spaces, OR CREATION OF NEW OPENINGS.

CRITICAL WALL REQUIREMENTS (must remain IDENTICAL):
- Wall length: Walls must be the exact same length, not extended or shortened
- Wall position: Walls must be in the exact same location, not moved or repositioned
- Wall angles: Wall corners and angles must be identical
- Wall configuration: The overall room shape and wall layout must be unchanged
- Wall geometry: The spatial relationship between walls must be preserved exactly

CRITICAL OPENING/PASSAGE REQUIREMENTS:
- NO NEW OPENINGS: Do NOT create windows, doors, or architectural openings that don't exist in the original. Enhanced image must have the SAME NUMBER of openings as original, not more.
- EXISTING MUST STAY OPEN: Any open passage between rooms (e.g., living→dining) must remain completely open and unobstructed
- Walkways: Wide passages and openings between spaces must NOT be closed off with furniture or built-in units
- Room connectivity: If original shows multiple connected spaces, edited must maintain the same connectivity
- Visual flow: Open sightlines between rooms must not be blocked by large furniture units acting as partitions

VIOLATIONS TO DETECT:
❌ Wall extended to create more space for furniture
❌ Wall shortened or removed to open up space
❌ Wall moved or repositioned to accommodate layout changes
❌ New wall sections added or existing sections removed
❌ Wall corners or angles changed
❌ Room dimensions altered (walls pushed out or pulled in)
❌ Wall geometry modified to fit furniture that wouldn't naturally fit
❌ CRITICAL: NEW windows/doors/openings CREATED on blank walls (false architecture)
❌ CRITICAL: Open passages/openings CLOSED with furniture or built-in units (e.g., entertainment center blocking open living→dining passage)
❌ CRITICAL: Open-plan space converted to closed/partitioned space using furniture as room divider
❌ CRITICAL: Large built-in units added that act like walls to separate previously connected spaces

ALLOWED CHANGES (not violations):
✅ Furniture placed against or near walls (not blocking openings)
✅ Wall paint/color enhanced or cleaned
✅ Lighting/exposure improvements
✅ Image quality enhancements
✅ Furniture added within the existing room geometry WITHOUT blocking passages
✅ Minor perspective correction or lens distortion fixes
✅ Loose furniture (sofas, chairs, tables) that don't block openings or act as room dividers

ANALYSIS INSTRUCTIONS:
1. Count all OPENINGS (windows, doors, passages) in the ORIGINAL image - this is your baseline
2. Count all OPENINGS in the ENHANCED image
3. If enhanced has MORE openings than original: FLAG AS VIOLATION (false architecture created)
4. Identify all major walls in both images
5. For EACH opening in original, verify it exists and remains OPEN in enhanced
6. Verify each wall in the edited image is EXACTLY the same length and position
7. Check that room dimensions and wall geometry are IDENTICAL
8. Look specifically for NEW windows/doors added to blank walls
9. Look specifically for existing openings that have been CLOSED with furniture

MANDATORY RESPONSE FORMAT:
- If ANY wall is modified OR ANY opening is closed OR NEW openings created: ok=false
- The "reason" field MUST start with "Wall violation: " followed by the specific issue
- For new openings: "Wall violation: New window/door created on [location]"
- For closures: "Wall violation: [opening description] blocked with [furniture/unit type]"
- Examples: "Wall violation: New window created on bedroom east wall"
            "Wall violation: open living-dining passage blocked with entertainment unit"
            "Wall violation: back wall extended 1.5 meters"

Compare the images and return JSON with this EXACT structure:
{
  "original_opening_count": number,
  "enhanced_opening_count": number,
  "openings_identified": ["list all openings/passages found in original"],
  "openings_status": ["for each opening: OPEN or BLOCKED"],
  "ok": true/false,
  "reason": "MUST start with 'Wall violation: ' if ok=false, empty if ok=true",
  "details": "Specific violation detected, empty if ok=true"
}

CRITICAL VALIDATION:
- If enhanced_opening_count > original_opening_count: ok MUST be false with reason "Wall violation: New opening(s) created - false architecture"
- If ANY opening_status is "BLOCKED": ok MUST be false
- If openings_identified is empty but image shows open-plan space: ok MUST be false with reason "Wall violation: failed to identify openings for validation"

CRITICAL: Walls AND openings are permanent architectural elements. ANY wall modification, opening closure, OR new opening creation MUST be reported as "Wall violation: ..." to ensure critical handling.`;

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { inlineData: { mimeType: "image/png", data: originalB64 } },
        { inlineData: { mimeType: "image/png", data: editedB64 } },
        { text: prompt }
      ]
    });

    const text = result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
    console.log("[WALL DETECTOR] Raw AI response:", text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[WALL DETECTOR] No JSON found in response - FAILING SAFE");
      console.log("[WALL DETECTOR] Full response text:", text);
      // Fail safe: cannot verify wall preservation without valid response
      return {
        ok: false,
        reason: "Wall violation: Unable to verify wall preservation - response format error",
        details: "Wall detector failed to parse response - treating as potential wall modification for safety"
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
      console.log("[WALL DETECTOR] Parsed result:", parsed);
    } catch (parseError) {
      console.error("[WALL DETECTOR] JSON parse error - FAILING SAFE:", parseError);
      console.log("[WALL DETECTOR] Raw JSON:", jsonMatch[0]);
      // Fail safe: cannot verify wall preservation with malformed JSON
      return {
        ok: false,
        reason: "Wall violation: Unable to verify wall preservation - JSON parse error",
        details: "Wall detector received malformed JSON - treating as potential wall modification for safety"
      };
    }

    // Validate response structure
    if (parsed.ok === undefined) {
      console.error("[WALL DETECTOR] Missing 'ok' field in response - FAILING SAFE");
      console.log("[WALL DETECTOR] Parsed object:", JSON.stringify(parsed));
      // Fail safe: cannot verify wall preservation with invalid structure
      return {
        ok: false,
        reason: "Wall violation: Unable to verify wall preservation - invalid response structure",
        details: "Wall detector response missing required field - treating as potential wall modification for safety"
      };
    }

    // CRITICAL: Check for NEW opening creation (false architecture)
    if (typeof parsed.original_opening_count === 'number' && typeof parsed.enhanced_opening_count === 'number') {
      console.log("[WALL DETECTOR] Original opening count:", parsed.original_opening_count);
      console.log("[WALL DETECTOR] Enhanced opening count:", parsed.enhanced_opening_count);
      
      if (parsed.enhanced_opening_count > parsed.original_opening_count) {
        console.error("[WALL DETECTOR] NEW OPENING(S) CREATED - FALSE ARCHITECTURE DETECTED");
        const newCount = parsed.enhanced_opening_count - parsed.original_opening_count;
        parsed.ok = false;
        if (!parsed.reason || !String(parsed.reason).toLowerCase().includes("wall violation")) {
          parsed.reason = `Wall violation: ${newCount} new opening(s) created - false architecture (original: ${parsed.original_opening_count}, enhanced: ${parsed.enhanced_opening_count})`;
        }
      }
    } else {
      console.warn("[WALL DETECTOR] Missing opening count fields - cannot verify against creation");
    }
    
    // CRITICAL: Validate structured response for opening detection
    if (Array.isArray(parsed.openings_identified) && Array.isArray(parsed.openings_status)) {
      console.log("[WALL DETECTOR] Openings identified:", parsed.openings_identified);
      console.log("[WALL DETECTOR] Openings status:", parsed.openings_status);
      
      // Validate arrays match in length
      if (parsed.openings_identified.length !== parsed.openings_status.length) {
        console.error("[WALL DETECTOR] FAIL-SAFE: Openings arrays length mismatch - cannot trust validation");
        return {
          ok: false,
          reason: "Wall violation: Openings validation failed - array length mismatch",
          details: "Cannot verify opening preservation - treating as potential violation for safety"
        };
      }
      
      // HEURISTIC SANITY CHECK: Look for inconsistencies between reason/details and status
      // If AI mentions blockage/closure in reason/details but marks all as OPEN, that's suspicious
      const reasonText = String(parsed.reason || "").toLowerCase();
      const detailsText = String(parsed.details || "").toLowerCase();
      const combinedText = `${reasonText} ${detailsText}`;
      
      const mentionsBlockage = /block|close|partition|obstruct|entertainment.*unit|built.*in.*unit|divid/.test(combinedText);
      const allMarkedOpen = parsed.openings_status.every((status: string) => 
        String(status).trim().toUpperCase() === "OPEN"
      );
      
      if (mentionsBlockage && allMarkedOpen && parsed.ok === true) {
        console.error("[WALL DETECTOR] INCONSISTENCY DETECTED: AI mentions blockage but marks all OPEN with ok=true");
        console.error("[WALL DETECTOR] Reason:", parsed.reason);
        console.error("[WALL DETECTOR] Details:", parsed.details);
        console.error("[WALL DETECTOR] Status array:", parsed.openings_status);
        // Force violation - AI is contradicting itself
        parsed.ok = false;
        parsed.reason = `Wall violation: Inconsistent response - mentions blockage/closure but marked openings as OPEN`;
      }
      
      // Validate all statuses are explicitly "OPEN" - anything else is suspicious
      const allExplicitlyOpen = parsed.openings_status.every((status: string) => 
        String(status).trim().toUpperCase() === "OPEN"
      );
      
      if (!allExplicitlyOpen) {
        console.warn("[WALL DETECTOR] At least one opening not explicitly marked OPEN - enforcing violation");
        const problematicIndex = parsed.openings_status.findIndex((s: string) => 
          String(s).trim().toUpperCase() !== "OPEN"
        );
        const problematicOpening = parsed.openings_identified[problematicIndex] || "unidentified opening";
        const problematicStatus = parsed.openings_status[problematicIndex];
        
        // Override AI result
        parsed.ok = false;
        if (!parsed.reason || !String(parsed.reason).toLowerCase().includes("wall violation")) {
          parsed.reason = `Wall violation: ${problematicOpening} marked as '${problematicStatus}' (not OPEN)`;
        }
      }
    } else {
      // FAIL-SAFE: If AI didn't provide structured arrays, we cannot trust the result
      console.error("[WALL DETECTOR] FAIL-SAFE: Missing structured openings arrays - cannot verify opening preservation");
      // Only fail safe if AI said ok=true without providing validation arrays
      if (parsed.ok === true) {
        console.error("[WALL DETECTOR] AI returned ok=true without opening validation - REJECTING");
        return {
          ok: false,
          reason: "Wall violation: Unable to verify opening/passage preservation - no structural validation provided",
          details: "AI response missing required openings arrays - treating as potential violation for safety"
        };
      }
      // If AI already said ok=false, allow it through (it detected some other violation)
      console.warn("[WALL DETECTOR] AI response missing structured openings arrays but already flagged a violation");
    }

    // CRITICAL: Enforce "Wall violation:" prefix on all violations to ensure critical classification
    // The compliance helper only treats violations with this prefix as critical/hard failures
    if (parsed.ok === false && parsed.reason) {
      const reason = String(parsed.reason).trim();
      // If AI returned a violation but forgot the prefix, add it
      if (!reason.toLowerCase().startsWith("wall violation")) {
        console.warn("[WALL DETECTOR] AI response missing required 'Wall violation:' prefix, enforcing...");
        console.log("[WALL DETECTOR] Original reason:", reason);
        parsed.reason = `Wall violation: ${reason}`;
        console.log("[WALL DETECTOR] Enforced reason:", parsed.reason);
      }
    }

    return {
      ok: parsed.ok,
      reason: parsed.reason || undefined,
      details: parsed.details || undefined
    };
  } catch (error) {
    console.error("[WALL DETECTOR] Unexpected error - FAILING SAFE:", error);
    // Fail safe: treat any unexpected error as potential wall violation
    return {
      ok: false,
      reason: "Wall violation: Unable to verify wall preservation - unexpected error",
      details: error instanceof Error ? error.message : "Unknown error in wall detector"
    };
  }
}
