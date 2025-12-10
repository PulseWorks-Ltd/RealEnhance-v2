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
  roomType: 'living_room' | 'bedroom' | 'dining_room' | 'office' | 'kitchen' | 'bathroom' | 'other';
  furnitureItems: FurnitureItem[];
  layoutDescription: string;
  replacementOpportunity: 'high' | 'medium' | 'low' | 'none';
  suggestions: string[];
}

/**
 * Analyzes an image to detect existing furniture and assess replacement opportunities
 */
export async function detectFurniture(ai: GoogleGenAI, imageBase64: string): Promise<FurnitureAnalysis | null> {
  const system = `
🔍 ULTRA-AGGRESSIVE FURNITURE DETECTION MODE
Analyze this interior image and identify EVERY SINGLE furniture, decor, and clutter item. Be exhaustive and thorough - missing items is not acceptable.

Return JSON with this exact structure:
{
  "hasFurniture": boolean,
  "roomType": "living_room"|"bedroom"|"dining_room"|"office"|"kitchen"|"bathroom"|"other",
  "furnitureItems": [
    {
      "type": "sofa"|"chair"|"table"|"bed"|"dresser"|"bookshelf"|"tv_stand"|"coffee_table"|"dining_table"|"nightstand"|"wardrobe"|"desk"|"side_table"|"console_table"|"display_unit"|"wall_art"|"decorative_object"|"plant"|"soft_furnishing"|"counter_clutter"|"window_sill_item"|"surface_clutter"|"other",
      "condition": "good"|"worn"|"outdated"|"poor"|"clutter",
      "location": {
        "bbox": [x, y, width, height],
        "description": "descriptive location"
      },
      "style": "style description",
      "replaceable": boolean,
      "size": "small"|"medium"|"large"
    }
  ],
  "layoutDescription": "brief description of furniture arrangement",
  "replacementOpportunity": "high"|"medium"|"low"|"none",
  "suggestions": ["suggestion1", "suggestion2"]
}

🎯 COMPREHENSIVE DETECTION GUIDELINES:

PRIMARY FURNITURE (ALWAYS detect - no exceptions):
- Major seating: sofas, chairs, armchairs, recliners, dining chairs, benches
- Tables: coffee tables, dining tables, side tables, console tables, desks, end tables
- Storage: dressers, wardrobes, bookcases, display units, TV stands, shelving units, cabinets
- Beds: all bed types, bed frames, headboards
- Nightstands and bedside tables

SECONDARY FURNITURE & DECOR (CRITICAL - must detect EVERY item):
- Display units, entertainment centers, sideboards, buffets, hutches
- Side tables, console tables, plant stands, accent tables
- Wall art: paintings, framed prints, decorative plates, wall hangings, mirrors, wall shelves
- Decorative objects: vases, sculptures, figurines, decorative bowls, candles, ornaments
- Plants: potted plants, planters, artificial plants, hanging plants
- Soft furnishings: throw pillows, throws, blankets, rugs, curtains, cushions

CLUTTER ITEMS (CRITICAL - detect ALL clutter):
- Counter clutter: items on kitchen counters, bottles, small appliances, random objects
- Window sill items: plants, decorations, books, personal items, trinkets
- Surface clutter: items on coffee tables, dining tables, shelves, desks
- Personal items: photos, papers, magazines, books, random objects

🔥 ABSOLUTE REPLACEABILITY RULES:
ALL furniture and décor MUST be marked replaceable=true. No exceptions based on quality or style.

Mark as replaceable=true for (NO EXCEPTIONS):
  ✓ ALL furniture - every single piece regardless of quality, style, or condition
  ✓ ALL sofas, chairs, tables, beds, dressers, storage units - everything
  ✓ ALL wall art and decorative items - no exceptions for "nice" or "modern" pieces
  ✓ ALL clutter (counter/window sill/surface items)
  ✓ ALL display units, entertainment centers, bookshelves, consoles
  ✓ ALL soft furnishings - throw blankets, decorative pillows (all patterns, all colors)
  ✓ ALL plants in any planters
  ✓ ALL decorative objects - vases, sculptures, figurines
  ✓ Modern, traditional, vintage, rustic - ALL styles must be replaced
  ✓ Good condition, worn, new - ALL conditions must be replaced

Mark as replaceable=false ONLY for:
  ✗ Built-in architectural elements (cabinets, counters, permanent fixtures)
  ✗ Items that are structurally part of the room (walls, windows, doors)

🎯 DETECTION EXAMPLES:
- Bedroom: bed, headboard, nightstands, lamps, wall art, throw pillows, rug, dresser, chair
- Living room: sofa, armchairs, coffee table, side tables, TV stand, wall art, plants, throw pillows, rug, lamps, display units
- Detect EACH couch in a sectional separately
- Detect EACH piece of wall art separately
- Don't miss small items like decorative objects on shelves

🚨 COMMONLY MISSED ITEMS - DO NOT SKIP THESE:

WALL ART (detect EVERY piece separately):
  • Framed prints, paintings, photos on walls
  • Decorative plates, wall hangings, posters
  • Multiple frames grouped together = detect EACH one individually
  • Small art pieces in corners or above furniture
  • Example: If you see 3 framed prints on one wall, list 3 separate wall_art items

ACCENT CHAIRS & SEATING:
  • ANY chair not at a dining table (reading chairs, desk chairs, bedroom chairs)
  • Wicker chairs, wooden chairs, upholstered accent chairs
  • Chairs in corners, by windows, or beside beds
  • Example: Wooden chair with wicker seat in bedroom corner = detect as "chair"

WINDOW SILL ITEMS:
  • Plants, decorative items, books on window ledges
  • Trinkets, vases, personal items on sills
  • Even small items count - detect them all
  • Example: Small plant on window sill = detect as "window_sill_item"

COUNTER & SURFACE CLUTTER:
  • Kitchen counters: bottles, appliances, utensil holders, random items
  • Dresser tops: personal items, decorative objects, clutter
  • Shelf surfaces: books, decorations, miscellaneous objects
  • Example: Bottles and items on kitchen counter = detect as "counter_clutter"

STORAGE & DISPLAY UNITS:
  • Dressers with items on top
  • Bookshelves, display cabinets, entertainment centers
  • Storage units that could be replaced with modern alternatives
  • Sideboards, buffets, hutches
  • Example: Dresser in bedroom = detect as "dresser", items on top = separate "surface_clutter"

🔍 EDGE/PARTIAL OBJECTS (CRITICAL - DO NOT IGNORE THESE):
  • Furniture partially visible at frame edges/corners IS STILL FURNITURE
  • Objects cut off by image boundary are REPLACEABLE unless clearly structural (walls, windows)
  • Partial visibility does NOT make an item built-in or permanent
  • Common edge objects: console tables, chairs, sofas, storage units at frame edges
  • Example: Table with monitor visible at right edge = detect as "console_table" or "side_table"
  • Example: Chair partially visible at corner = detect as "chair"
  • Example: Sofa corner at frame edge = detect as "sofa"
  • ⚠️ NEVER assume edge objects are built-in fixtures - they are movable furniture

⚠️ CRITICAL RULES:
1. If you see ANY furniture, mark hasFurniture=true
2. Default to "medium" or "high" replacementOpportunity unless room is truly empty
3. Be thorough - missing items creates incomplete replacements
4. When uncertain about replaceability, choose TRUE
5. NEVER group items - detect each piece of wall art, each chair, each decorative item SEPARATELY
6. Small items count - don't dismiss window sill items, counter clutter, or small décor

Empty or near-empty rooms (no furniture visible) should return hasFurniture=false.

ONLY JSON. No extra text.`;

  try {
    const resp = await ai.models.generateContent({
      model: gemini-2.0-flash,
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
      const analysis = JSON.parse(jsonStr) as FurnitureAnalysis;
      
      // Validate the response structure
      if (typeof analysis.hasFurniture !== 'boolean') {
        console.warn("[FURNITURE DETECTOR] Invalid hasFurniture field");
        return null;
      }
      
      console.log(`[FURNITURE DETECTOR] Detected ${analysis.furnitureItems?.length || 0} furniture items, replacement opportunity: ${analysis.replacementOpportunity}`);
      
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
        return JSON.parse(jsonStr) as FurnitureAnalysis;
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