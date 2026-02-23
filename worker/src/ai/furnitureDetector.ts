// server/ai/furnitureDetector.ts

import { GoogleGenAI } from '@google/genai';

export interface FurnitureItem {
  type: 'sofa' | 'chair' | 'table' | 'bed' | 'dresser' | 'bookshelf' | 'tv_stand' | 'coffee_table' | 'dining_table' | 'nightstand' | 'wardrobe' | 'desk' | 'side_table' | 'console_table' | 'display_unit' | 'wall_art' | 'decorative_object' | 'plant' | 'soft_furnishing' | 'counter_clutter' | 'window_sill_item' | 'surface_clutter' | 'other';
  condition: 'good' | 'worn' | 'outdated' | 'poor' | 'clutter';
  location: {
    bbox: [number, number, number, number]; // [x, y, width, height]
    description: string; // e.g., "center of room", "against back wall", "on kitchen counter", "window sill"
  };
  style: string; // e.g., "traditional", "modern", "rustic", "vintage", "mixed", "cluttered"
  replaceable: boolean; // whether this item is a good candidate for replacement
  size: 'small' | 'medium' | 'large';
}

export interface FurnitureAnalysis {
  hasFurniture: boolean;
  detectedAnchors: string[];
  confidence: number;
  hasMovableSeating: boolean;
  hasCounterClutter: boolean;
  hasSurfaceClutter: boolean;
  hasLoosePortableItems: boolean;
  isStageReady: boolean;
  roomType: 'living_room' | 'bedroom' | 'dining_room' | 'office' | 'kitchen' | 'bathroom' | 'other';
  furnitureItems: FurnitureItem[];
  layoutDescription: string;
  replacementOpportunity: 'high' | 'medium' | 'low' | 'none';
  suggestions: string[];
}

export type FurnishedGateDecisionType = "furnished_refresh" | "empty_full_stage" | "needs_declutter_light";

export interface FurnishedGateDecision {
  decision: FurnishedGateDecisionType;
  reason: string;
  confidence: number;
  anchors: string[];
}

export const CORE_ANCHOR_CLASSES = [
  "bed",
  "sofa",
  "dining_table",
  "desk",
  "coffee_table",
  "freestanding_wardrobe",
  "large_freestanding_cabinet",
] as const;

const CORE_ANCHOR_SET = new Set<string>(CORE_ANCHOR_CLASSES);

function toBool(value: unknown): boolean {
  return value === true;
}

function toRoomType(rawRoomType: unknown): string {
  return String(rawRoomType || "")
    .toLowerCase()
    .replace(/-/g, "_")
    .trim();
}

export function resolveFurnishedGateDecision(params: {
  analysis: FurnitureAnalysis | null;
  localEmpty: boolean;
  roomType?: string;
  minConfidence?: number;
  /** Whether the user explicitly selected declutter/Stage1B before submission.
   * When false (default), clutter-only signals will NOT auto-escalate to Stage1B.
   * Only true furniture (hasFurniture === true) may auto-trigger Stage1B.
   */
  userSelectedDeclutter?: boolean;
}): FurnishedGateDecision {
  const minConfidence = typeof params.minConfidence === "number" ? params.minConfidence : 0.65;
  const normalizedRoomType = toRoomType(params.roomType);
  const isKitchenLike = normalizedRoomType === "kitchen" || normalizedRoomType.startsWith("kitchen_");

  if (params.localEmpty) {
    return {
      decision: "empty_full_stage",
      reason: "local_empty_prefilter",
      confidence: 1,
      anchors: [],
    };
  }

  if (!params.analysis) {
    return {
      decision: "needs_declutter_light",
      reason: "detector_null_fail_safe",
      confidence: 0,
      anchors: [],
    };
  }

  const anchors = Array.isArray(params.analysis.detectedAnchors)
    ? params.analysis.detectedAnchors
      .map((anchor) => String(anchor || "").toLowerCase().trim().replace(/\s+/g, "_"))
      .filter((anchor) => CORE_ANCHOR_SET.has(anchor))
    : [];

  const confidence = typeof params.analysis.confidence === "number"
    ? Math.max(0, Math.min(1, params.analysis.confidence))
    : 0;

  const hasCounterClutter = toBool(params.analysis.hasCounterClutter);
  const hasSurfaceClutter = toBool(params.analysis.hasSurfaceClutter);
  const hasLoosePortableItems = toBool(params.analysis.hasLoosePortableItems);
  const hasMovableSeating = toBool(params.analysis.hasMovableSeating);
  const hasClutterSignals = hasCounterClutter || hasSurfaceClutter || hasLoosePortableItems;
  const hasKitchenDeclutterSignals = hasMovableSeating || hasClutterSignals;

  if (confidence < minConfidence) {
    return {
      decision: "needs_declutter_light",
      reason: "low_confidence_fail_safe",
      confidence,
      anchors,
    };
  }

  if (anchors.length > 0 || params.analysis.hasFurniture) {
    return {
      decision: "furnished_refresh",
      reason: "anchor_or_furniture_detected",
      confidence,
      anchors,
    };
  }

  // Strict intent: clutter-only signals only trigger light declutter when user explicitly requested it.
  // True furniture (hasFurniture=true, anchors detected) always escalates above — clutter without furniture does not.
  if (params.userSelectedDeclutter !== false && ((isKitchenLike && hasKitchenDeclutterSignals) || hasClutterSignals)) {
    return {
      decision: "needs_declutter_light",
      reason: isKitchenLike ? "kitchen_signals_require_light_declutter" : "clutter_signals_require_light_declutter",
      confidence,
      anchors,
    };
  }

  if (params.analysis.isStageReady === true) {
    return {
      decision: "empty_full_stage",
      reason: "stage_ready_no_signals",
      confidence,
      anchors,
    };
  }

  return {
    decision: "empty_full_stage",
    reason: "default_empty_no_signals",
    confidence,
    anchors,
  };
}

export function getAnchorClassSet(analysis: FurnitureAnalysis | null | undefined): Set<string> {
  if (!analysis) return new Set<string>();
  const rawAnchors = Array.isArray((analysis as any).detectedAnchors)
    ? (analysis as any).detectedAnchors
    : [];
  return new Set(
    rawAnchors
      .map((anchor: unknown) => String(anchor || "").toLowerCase().trim().replace(/\s+/g, "_"))
      .filter((anchor: string) => CORE_ANCHOR_SET.has(anchor))
  );
}

/**
 * Analyzes an image to detect existing furniture and assess replacement opportunities
 */
export async function detectFurniture(ai: GoogleGenAI, imageBase64: string): Promise<FurnitureAnalysis | null> {
  const system = `
You are determining whether this room contains LARGE MOVABLE FURNITURE ANCHORS.

A room is considered FURNISHED only if at least one clearly visible anchor exists from this list:
- bed
- sofa
- dining_table
- coffee_table
- desk
- freestanding_wardrobe
- large_freestanding_cabinet

Ignore all of the following when deciding furnished status:
- curtains
- blinds
- wall art
- ceiling fixtures
- HVAC units
- built-in cabinetry/counters/islands/vanities
- soft decor
- rugs alone

If only curtains, blinds, rugs, or built-in cabinetry are visible, return hasFurniture=false.
Curtains or wall decor alone do NOT count.

Return JSON only with this exact structure:
{
  "hasFurniture": boolean,
  "detectedAnchors": string[],
  "confidence": number,
  "hasMovableSeating": boolean,
  "hasCounterClutter": boolean,
  "hasSurfaceClutter": boolean,
  "hasLoosePortableItems": boolean,
  "isStageReady": boolean
}

Rules:
- detectedAnchors must only contain canonical values from the allowed anchor list above.
- confidence must be between 0 and 1.
- hasMovableSeating=true if movable stools/chairs/seating are clearly visible.
- hasCounterClutter=true if clutter is clearly visible on kitchen counters/island.
- hasSurfaceClutter=true if clutter is visible on tables/benches/other surfaces.
- hasLoosePortableItems=true for visible loose bags/boxes/portable objects.
- isStageReady=true only when room appears clean and ready for direct staging.
- If no valid anchor is clearly visible, set detectedAnchors to [] and hasFurniture=false.
`;

  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{
        role: "user",
        parts: [
          { text: system },
          { inlineData: { data: imageBase64, mimeType: "image/png" } }
        ]
      }]
    });

    const text = resp.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";
    
    console.log("[FURNITURE DETECTOR] Raw AI response:", JSON.stringify(text));
    
    // Extract JSON using robust method
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[FURNITURE DETECTOR] No JSON object found in response");
      return null;
    }
    
    let jsonStr = jsonMatch[0];
    console.log("[FURNITURE DETECTOR] Extracted JSON:", JSON.stringify(jsonStr));
    
    try {
      const parsed = JSON.parse(jsonStr) as Partial<FurnitureAnalysis> & {
        detectedAnchors?: unknown;
        confidence?: unknown;
      };

      const normalizedAnchors = Array.isArray(parsed.detectedAnchors)
        ? parsed.detectedAnchors
          .map((anchor) => String(anchor || "").toLowerCase().trim().replace(/\s+/g, "_"))
          .filter((anchor) => CORE_ANCHOR_SET.has(anchor))
        : [];

      const normalizedConfidence = typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;

      const analysis: FurnitureAnalysis = {
        hasFurniture: Boolean(parsed.hasFurniture),
        detectedAnchors: normalizedAnchors,
        confidence: normalizedConfidence,
        hasMovableSeating: toBool((parsed as any).hasMovableSeating),
        hasCounterClutter: toBool((parsed as any).hasCounterClutter),
        hasSurfaceClutter: toBool((parsed as any).hasSurfaceClutter),
        hasLoosePortableItems: toBool((parsed as any).hasLoosePortableItems),
        isStageReady: toBool((parsed as any).isStageReady),
        roomType: (parsed.roomType as FurnitureAnalysis["roomType"]) || "other",
        furnitureItems: Array.isArray(parsed.furnitureItems) ? parsed.furnitureItems as FurnitureItem[] : [],
        layoutDescription: typeof parsed.layoutDescription === "string" ? parsed.layoutDescription : "",
        replacementOpportunity: (parsed.replacementOpportunity as FurnitureAnalysis["replacementOpportunity"]) || "none",
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map((s) => String(s)) : [],
      };
      
      // Validate the response structure
      if (typeof analysis.hasFurniture !== 'boolean') {
        console.warn("[FURNITURE DETECTOR] Invalid hasFurniture field");
        return null;
      }
      
      console.log(`[FURNITURE DETECTOR] hasFurniture=${analysis.hasFurniture} anchors=${JSON.stringify(analysis.detectedAnchors)} confidence=${analysis.confidence}`);
      
      return analysis;
    } catch (e) {
      // Try to find just the first complete JSON object if parsing fails
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
        console.log("[FURNITURE DETECTOR] Trimmed JSON:", JSON.stringify(jsonStr));
        const trimmedParsed = JSON.parse(jsonStr) as Partial<FurnitureAnalysis> & {
          detectedAnchors?: unknown;
          confidence?: unknown;
        };
        const normalizedAnchors = Array.isArray(trimmedParsed.detectedAnchors)
          ? trimmedParsed.detectedAnchors
            .map((anchor) => String(anchor || "").toLowerCase().trim().replace(/\s+/g, "_"))
            .filter((anchor) => CORE_ANCHOR_SET.has(anchor))
          : [];
        const normalizedConfidence = typeof trimmedParsed.confidence === "number"
          ? Math.max(0, Math.min(1, trimmedParsed.confidence))
          : 0;
        return {
          hasFurniture: Boolean(trimmedParsed.hasFurniture),
          detectedAnchors: normalizedAnchors,
          confidence: normalizedConfidence,
          hasMovableSeating: toBool((trimmedParsed as any).hasMovableSeating),
          hasCounterClutter: toBool((trimmedParsed as any).hasCounterClutter),
          hasSurfaceClutter: toBool((trimmedParsed as any).hasSurfaceClutter),
          hasLoosePortableItems: toBool((trimmedParsed as any).hasLoosePortableItems),
          isStageReady: toBool((trimmedParsed as any).isStageReady),
          roomType: (trimmedParsed.roomType as FurnitureAnalysis["roomType"]) || "other",
          furnitureItems: Array.isArray(trimmedParsed.furnitureItems) ? trimmedParsed.furnitureItems as FurnitureItem[] : [],
          layoutDescription: typeof trimmedParsed.layoutDescription === "string" ? trimmedParsed.layoutDescription : "",
          replacementOpportunity: (trimmedParsed.replacementOpportunity as FurnitureAnalysis["replacementOpportunity"]) || "none",
          suggestions: Array.isArray(trimmedParsed.suggestions) ? trimmedParsed.suggestions.map((s) => String(s)) : [],
        };
      }
      throw e;
    }
  } catch (error) {
    console.error("[FURNITURE DETECTOR] ❌ Failed to detect furniture");
    console.error("[FURNITURE DETECTOR] Error message:", error instanceof Error ? error.message : String(error));
    console.error("[FURNITURE DETECTOR] Stack trace:", error instanceof Error ? error.stack : 'No stack trace available');
    console.error("[FURNITURE DETECTOR] Error details:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    return null;
  }
}

/**
 * Generates furniture replacement instructions based on detected items
 * @param analysis - Furniture analysis from detectFurniture
 * @param forceReplacementMode - When true, bypasses "none" opportunity check and forces ALL items to be replaced
 */
export function buildFurnitureReplacementRules(analysis: FurnitureAnalysis | null, forceReplacementMode: boolean = false): string[] {
  // Early exit only if truly no furniture detected
  if (!analysis || !analysis.hasFurniture) {
    console.log(`[FURNITURE RULES] No furniture detected - returning empty rules`);
    return [];
  }
  
  // Define ALWAYS_REPLACE categories - these MUST be removed regardless of condition
  // Uses only categories that exist in FurnitureItem.type schema
  const ALWAYS_REPLACE = new Set([
    'wall_art',
    'decorative_object',
    'display_unit',
    'console_table',
    'side_table',
    'coffee_table',
    'bookshelf',
    'tv_stand',
    'plant',
    'soft_furnishing',
    'counter_clutter',
    'window_sill_item',
    'surface_clutter',
    'other'  // CRITICAL: "other" type catches miscellaneous items that don't fit categories
  ]);
  
  // When force mode is active, bypass opportunity check and ensure at least 1 item is replaceable
  if (forceReplacementMode) {
    console.log(`[FURNITURE RULES] ⚡ FORCE REPLACEMENT MODE ACTIVE - User explicitly wants furniture replaced`);
    console.log(`[FURNITURE RULES] Detected ${analysis.furnitureItems.length} items, forcing ALL to be replaceable`);
    
    // Force ALL detected items to be replaceable (override AI's condition assessment)
    analysis.furnitureItems.forEach(item => {
      const wasPreviouslyReplaceable = item.replaceable;
      item.replaceable = true; // Force everything
      
      if (!wasPreviouslyReplaceable) {
        console.log(`[FURNITURE RULES] Forced ${item.type} at ${item.location.description} to be replaceable (was: false)`);
      }
    });
    
    // Override opportunity if it was 'none'
    if (analysis.replacementOpportunity === 'none') {
      console.log(`[FURNITURE RULES] Overriding 'none' opportunity to 'high' due to force mode`);
      analysis.replacementOpportunity = 'high';
    }
  } else {
    // Non-force mode: still enforce ALWAYS_REPLACE categories
    analysis.furnitureItems.forEach(item => {
      if (ALWAYS_REPLACE.has(item.type) && !item.replaceable) {
        console.log(`[FURNITURE RULES] Forcing ${item.type} to replaceable (ALWAYS_REPLACE category)`);
        item.replaceable = true;
      }
    });
    
    // Check if there are any replaceable items after ALWAYS_REPLACE enforcement
    const hasReplaceableItems = analysis.furnitureItems.some(item => item.replaceable);
    
    // Only exit early if truly no replaceable items (not even ALWAYS_REPLACE categories)
    if (analysis.replacementOpportunity === 'none' && !hasReplaceableItems) {
      console.log(`[FURNITURE RULES] Opportunity is 'none' and no replaceable items - returning empty rules`);
      return [];
    }
    
    // If ALWAYS_REPLACE items exist, log that we're proceeding despite 'none' opportunity
    if (analysis.replacementOpportunity === 'none' && hasReplaceableItems) {
      console.log(`[FURNITURE RULES] Opportunity is 'none' but ALWAYS_REPLACE items detected - proceeding with directives`);
    }
  }

  const rules: string[] = [];
  
  rules.push("[FURNITURE REPLACEMENT MODE - CLEAN SLATE TRANSFORMATION]");
  rules.push("🔥 CRITICAL: Remove or replace ALL existing furniture, wall art, and décor - no exceptions regardless of quality or style.");
  rules.push("🔥 ABSOLUTE RULE: Do NOT keep ANY existing items. Everything will be replaced with cohesive modern staging.");
  rules.push(`Room type: ${analysis.roomType}. Layout: ${analysis.layoutDescription}`);
  
  // Architectural preservation
  rules.push("");
  rules.push("🏛️ ARCHITECTURAL PRESERVATION (NEVER CHANGE):");
  rules.push("- IMMOVABLE: Walls, windows, doors, built-in cabinets, countertops, fixtures");
  rules.push("- MAINTAIN DOORWAY ACCESS: Keep furniture AT LEAST 1 meter away from doors and entryways");
  rules.push("- PRESERVE TRAFFIC FLOW: Maintain existing pathways and room circulation");
  
  // EXPLICIT PER-ITEM REMOVAL DIRECTIVES
  const replaceableItems = analysis.furnitureItems.filter(item => item.replaceable);
  
  console.log(`[FURNITURE RULES] Building explicit removal directives for ${replaceableItems.length} items`);
  
  if (replaceableItems.length > 0) {
    rules.push("");
    rules.push("📋 EXPLICIT REMOVAL/REPLACEMENT DIRECTIVES:");
    rules.push("Each item below MUST be removed or replaced - ALL furniture, ALL artwork, ALL décor. No exceptions regardless of quality.");
    rules.push("");
    
    // TWO-PASS APPROACH: ALWAYS_REPLACE categories first, then others
    const mandatoryRemoveItems = replaceableItems.filter(item => ALWAYS_REPLACE.has(item.type));
    const otherReplaceableItems = replaceableItems.filter(item => !ALWAYS_REPLACE.has(item.type));
    
    // Pass 1: Mandatory removals (décor, clutter, wall art - ALWAYS remove)
    if (mandatoryRemoveItems.length > 0) {
      rules.push("🎯 MANDATORY REMOVALS (décor, wall art, clutter - MUST remove ALL):");
      mandatoryRemoveItems.forEach(item => {
        const bbox = item.location.bbox;
        const bboxStr = `[${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}]`;
        
        if (item.type === 'counter_clutter' || item.type === 'window_sill_item' || item.type === 'surface_clutter') {
          rules.push(`  REMOVE: ${item.type} at ${item.location.description} ${bboxStr} - CLEAR COMPLETELY`);
        } else if (item.type === 'wall_art') {
          rules.push(`  REMOVE: ${item.type} at ${item.location.description} ${bboxStr} - ${item.style} ${item.condition} frame/print`);
        } else {
          rules.push(`  REMOVE/REPLACE: ${item.type} at ${item.location.description} ${bboxStr} - Replace with modern alternative`);
        }
      });
      rules.push("");
    }
    
    // Pass 2: Other replaceable furniture
    if (otherReplaceableItems.length > 0) {
      rules.push("🪑 FURNITURE REPLACEMENTS (replace ALL furniture regardless of quality):");
      otherReplaceableItems.forEach(item => {
        const bbox = item.location.bbox;
        const bboxStr = `[${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}]`;
        rules.push(`  REPLACE: ${item.type} at ${item.location.description} ${bboxStr} - MUST be replaced → modern ${item.size} alternative`);
      });
      rules.push("");
    }
  }
  
  // GLOBAL SAFETY NET - catches items detection missed
  rules.push("");
  rules.push("🚨 GLOBAL SAFETY NET - REMOVE EVERYTHING LISTED BELOW (applies regardless of what was detected above):");
  rules.push("✓ ALL wall art: framed prints, paintings, photos, decorative plates, wall hangings, mirrors with decorative frames");
  rules.push("✓ ALL personal items: family photos, personal memorabilia, photo frames");
  rules.push("✓ ALL shelving/display units: open shelving, bookcases, display cabinets, entertainment centers");
  rules.push("✓ ALL console tables, side tables, accent tables (unless specifically modern and needed)");
  rules.push("✓ ALL window sill items: plants, decorations, books, trinkets, any items on window ledges");
  rules.push("✓ ALL counter clutter: bottles, small appliances, kitchen items, containers, anything on counters");
  rules.push("✓ ALL surface clutter: items on coffee tables, dining tables, shelves, dressers, any surface");
  rules.push("✓ ALL throw blankets and decorative pillows (all patterns, all colors - no exceptions)");
  rules.push("✓ ALL decorative objects: vases, sculptures, figurines, candles, ornaments, trinkets");
  rules.push("✓ ALL plants in any planters");
  rules.push("");
  rules.push("🔍 EDGE/PARTIAL OBJECTS (commonly missed but MUST be replaced):");
  rules.push("✓ Furniture at frame edges/corners: console tables, chairs, sofas, storage units partially visible");
  rules.push("✓ Objects cut off by image boundary are REPLACEABLE unless clearly structural (walls, windows)");
  rules.push("✓ Partial visibility does NOT mean built-in or permanent");
  rules.push("✓ Example: Table with monitor at right edge = REMOVE/REPLACE");
  rules.push("✓ Example: Sofa corner at bottom edge = REMOVE/REPLACE");
  rules.push("");
  rules.push("⚠️ ABSOLUTE RULE: ALL existing furniture and décor MUST be removed - do NOT keep any items regardless of quality or style.");
  rules.push("⚠️ EDGE OBJECTS: Furniture at frame edges is NOT built-in - replace it like any other furniture.");
  rules.push("⚠️ WALL ART: Remove ALL artwork, photos, and wall hangings - no exceptions for 'nice' or 'modern' pieces.");
  rules.push("Do NOT keep ANY existing furniture, wall art, or decorative items - they will ALL be replaced with a cohesive modern design.");
  
  // Staging requirements
  rules.push("");
  rules.push("🎨 COHESIVE DESIGN REQUIREMENTS:");
  rules.push("- UNIFIED PALETTE: All new pieces must work together (grey/white/natural wood/coordinated accents)");
  rules.push("- CONSISTENT STYLE: Choose ONE modern style (contemporary, Scandinavian, minimalist) for ALL items");
  rules.push("- POSITIONAL CONSISTENCY: Place new items in similar locations to originals (don't rearrange layout)");
  rules.push("- NO MIXED STYLES: Traditional + modern = AUTOMATIC FAILURE");
  rules.push("- After removal, restage with consistent palette; ensure no legacy items remain visible");
  
  rules.push("");
  rules.push("📐 POSITIONING RULES:");
  rules.push("- Place new furniture in approximately same locations as removed items");
  rules.push("- Maintain overall room layout and traffic flow");
  rules.push("- Doorway clearance: minimum 1 meter from all doors");
  rules.push("- Keep existing pathways through the room");
  
  // Success/failure criteria
  rules.push("");
  rules.push("✅ SUCCESS CRITERIA:");
  rules.push("- ALL items in removal directives have been removed/replaced");
  rules.push("- NO wall art, photos, or decorative items from original image remain");
  rules.push("- ALL clutter removed (counters, window sills, surfaces clear)");
  rules.push("- Design is cohesive with unified modern style");
  rules.push("- Architectural elements unchanged");
  
  rules.push("");
  rules.push("❌ FAILURE CRITERIA:");
  rules.push("- ANY old furniture/décor left in place alongside new items");
  rules.push("- Mixed styles (keeping original items with new staging)");
  rules.push("- Clutter or decorative items still visible");
  rules.push("- Wall art from original image still present");
  rules.push("- If you cannot remove/replace EVERYTHING listed above, mark as compliance failure");
  
  return rules;
}

/**
 * Determines if furniture replacement should be enabled based on detection results
 * @param analysis - Furniture analysis from detectFurniture
 * @param forceReplacementMode - When true, enables replacement if ANY furniture is detected
 */
export function shouldEnableFurnitureReplacement(analysis: FurnitureAnalysis | null, forceReplacementMode: boolean = false): boolean {
  if (!analysis) return false;
  
  // Force mode: enable if ANY furniture detected (even 1 item)
  if (forceReplacementMode) {
    const hasAnyItems = analysis.hasFurniture && analysis.furnitureItems.length > 0;
    console.log(`[FURNITURE ENABLE] Force mode: ${hasAnyItems ? 'ENABLED' : 'DISABLED'} (${analysis.furnitureItems.length} items detected)`);
    return hasAnyItems;
  }
  
  // Normal mode: respect opportunity assessment
  const enabled = analysis.hasFurniture && 
         analysis.replacementOpportunity !== 'none' &&
         analysis.furnitureItems.some(item => item.replaceable);
  console.log(`[FURNITURE ENABLE] Normal mode: ${enabled ? 'ENABLED' : 'DISABLED'} (opportunity: ${analysis.replacementOpportunity})`);
  return enabled;
}