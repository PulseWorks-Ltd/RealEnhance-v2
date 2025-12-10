// server/ai/spatialAnalyzer.ts

import { GoogleGenAI } from '@google/genai';

export type WallPosition = 'left' | 'right' | 'front' | 'back' | 'ceiling' | 'floor';
export type OpeningType = 'window' | 'door' | 'doorway' | 'passthrough' | 'archway' | 'opening';

export interface SpatialFeature {
  type: OpeningType;
  wall: WallPosition;
  spanStart: number; // percentage (0-100) from left edge of wall
  spanEnd: number;   // percentage (0-100) from left edge of wall
  heightLevel: 'floor' | 'mid' | 'ceiling' | 'full-height';
  size: 'small' | 'medium' | 'large';
  description: string; // e.g., "large window centered on left wall", "doorway in back right corner"
  confidence: 'high' | 'medium' | 'low';
}

export interface FurnitureMeasurement {
  type: 'bed' | 'sofa' | 'dining_table' | 'coffee_table' | 'desk' | 'other';
  floorCoveragePercent: number; // % of visible floor area occupied
  imageCoveragePercent: number; // % of total image area occupied
  dimensions: {
    widthPercent: number; // % of room width
    depthPercent: number; // % of room depth (visual estimation)
  };
  position: string; // descriptive position
}

export interface WallSegment {
  wall: WallPosition;
  segmentStart: number; // percentage (0-100)
  segmentEnd: number;   // percentage (0-100)
  isEmpty: boolean;     // true if this wall segment has NO openings
  description: string;  // e.g., "empty wall segment suitable for furniture placement"
}

export interface SpatialBlueprint {
  roomType: 'living_room' | 'bedroom' | 'dining_room' | 'office' | 'kitchen' | 'bathroom' | 'other';
  spatialFeatures: SpatialFeature[];
  wallSegments: WallSegment[]; // Maps ALL wall segments including empty areas
  dominantFurniture: FurnitureMeasurement | null; // Main furniture piece with proportional measurements
  layoutNotes: string; // brief description of room layout and key architectural elements
  totalOpenings: number;
  floorVisibilityPercent: number; // % of floor that's visible/unoccupied
}

/**
 * Analyzes an image to create a spatial blueprint of all openings (windows, doors, pass-throughs)
 * This blueprint is passed to Stage 2 to enforce architectural preservation
 */
export async function createSpatialBlueprint(
  ai: GoogleGenAI,
  imageBase64: string,
  detectedRoomType?: string
): Promise<SpatialBlueprint | null> {
  const system = `
🗺️ SPATIAL BLUEPRINT GENERATOR - ARCHITECTURAL FEATURE MAPPING

Your task is to create a spatial blueprint that maps ALL openings in this room with their precise wall-relative positions.
This blueprint will be used to ensure that ALL openings remain in their exact positions during room staging.

Return JSON with this exact structure:
{
  "roomType": "living_room"|"bedroom"|"dining_room"|"office"|"kitchen"|"bathroom"|"other",
  "spatialFeatures": [
    {
      "type": "window"|"door"|"doorway"|"passthrough"|"archway"|"opening",
      "wall": "left"|"right"|"front"|"back"|"ceiling"|"floor",
      "spanStart": number (0-100),
      "spanEnd": number (0-100),
      "heightLevel": "floor"|"mid"|"ceiling"|"full-height",
      "size": "small"|"medium"|"large",
      "description": "descriptive location",
      "confidence": "high"|"medium"|"low"
    }
  ],
  "wallSegments": [
    {
      "wall": "left"|"right"|"front"|"back",
      "segmentStart": number (0-100),
      "segmentEnd": number (0-100),
      "isEmpty": boolean,
      "description": "empty wall segment" | "occupied by [opening type]"
    }
  ],
  "dominantFurniture": {
    "type": "bed"|"sofa"|"dining_table"|"coffee_table"|"desk"|"other",
    "floorCoveragePercent": number (0-100),
    "imageCoveragePercent": number (0-100),
    "dimensions": {
      "widthPercent": number (0-100),
      "depthPercent": number (0-100)
    },
    "position": "descriptive position"
  } | null,
  "layoutNotes": "brief description of room layout and key architectural elements",
  "totalOpenings": number,
  "floorVisibilityPercent": number (0-100)
}

🎯 DETECTION GUIDELINES:

WALL ORIENTATION (camera perspective):
- **left**: Wall on the left side of the image
- **right**: Wall on the right side of the image
- **back**: Wall opposite the camera (far wall, background)
- **front**: Wall behind the camera (rarely visible, only if reflected/partially shown)

OPENING TYPES TO DETECT (COMPREHENSIVE LIST):
- **window**: Glass windows of any size
- **door**: Doors with frames (open or closed) - INCLUDES entry doors, closet doors, bathroom doors, bedroom doors, sliding doors, French doors
- **doorway**: Open passage with no door visible
- **passthrough**: Open connection between rooms (e.g., kitchen pass-through, breakfast bar opening, service window)
- **archway**: Arched opening between spaces
- **opening**: Any other architectural opening

🚨 CRITICAL - DETECT ALL DOORS:
- **Entry/exit doors**: Main room entry doors (even if visible only as frame)
- **Closet doors**: Built-in closet doors, wardrobe doors
- **Interior doors**: Bathroom doors, bedroom doors, hallway doors
- **Sliding doors**: Sliding glass doors, sliding closet doors
- **French doors**: Double doors, glass panel doors
- **Partial doors**: Doors only partially visible at frame edge
- If you see a door frame, door handle, or door visible → MUST map as "door"

🔍 CRITICAL - OPEN KITCHEN & DINING AREAS:
- **Open-concept kitchen visible from living/dining area** → MUST map as "passthrough" or "opening"
- **Kitchen counter/island with open view to another room** → MUST map as "passthrough"
- **Breakfast bar or service window between rooms** → MUST map as "passthrough"
- **Any visual connection between distinct spaces** → MUST be mapped (prevents walls being added during staging)

SPAN MEASUREMENT (wall-relative positioning):
- Measure horizontally along each wall from left edge to right edge
- **spanStart**: Percentage (0-100) where opening begins from left edge of that wall
- **spanEnd**: Percentage (0-100) where opening ends from left edge of that wall
- Example: Window centered on left wall might be spanStart: 40, spanEnd: 60 (middle 20% of wall)
- Example: Door in back right corner might be spanStart: 75, spanEnd: 95 (rightmost 20% of wall)

HEIGHT LEVEL:
- **floor**: Opening starts at floor level (doors, French doors)
- **mid**: Opening at mid-height (typical windows, pass-throughs)
- **ceiling**: Opening near ceiling (clerestory windows, high vents)
- **full-height**: Opening spans floor to ceiling (doorways, archways)

SIZE ASSESSMENT:
- **small**: Small window, narrow door
- **medium**: Standard window, typical door
- **large**: Large window, wide doorway, expansive opening

DOMINANT FURNITURE MEASUREMENTS:
- Identify the MAIN furniture piece (bed in bedroom, sofa in living room, dining table in dining room)
- Measure **floorCoveragePercent**: What % of the VISIBLE FLOOR AREA does this furniture occupy?
  * Small single bed in large room: ~20-25%
  * Standard double bed in medium bedroom: ~35-40%
  * King bed in medium bedroom: ~45-50%
  * Large sectional sofa in living room: ~30-40%
  * Standard sofa in living room: ~20-25%
  * Dining table for 6: ~30-35%
- Measure **imageCoveragePercent**: What % of the TOTAL IMAGE does this furniture occupy?
  * Includes vertical space (bed height, sofa back, etc.)
  * Typically 15-35% depending on camera angle
- Dimensions as % of room:
  * **widthPercent**: % of room width occupied (left-to-right in image)
  * **depthPercent**: % of room depth occupied (near-to-far, estimated from perspective)
- If no clear dominant furniture piece exists, set dominantFurniture to null

FLOOR VISIBILITY:
- **floorVisibilityPercent**: What % of the floor is VISIBLE and UNOCCUPIED?
  * Cluttered room: ~20-30%
  * Normal furnished room: ~40-60%
  * Minimally furnished: ~70-80%

WALL SEGMENT MAPPING (NEW - CRITICAL FOR PREVENTING FALSE ARCHITECTURE):
- Map ALL wall segments for EACH visible wall (left, right, back, front if visible)
- For each wall, divide it into segments based on openings:
  * **Empty segments**: Wall areas with NO openings (isEmpty: true)
  * **Occupied segments**: Wall areas with windows/doors (isEmpty: false)
- **Purpose**: Prevents AI from adding new doors/windows to empty wall areas during staging
- **Example**: Left wall with window at 40-60%:
  * Segment 1: { wall: "left", segmentStart: 0, segmentEnd: 40, isEmpty: true, description: "empty wall segment before window" }
  * Segment 2: { wall: "left", segmentStart: 40, segmentEnd: 60, isEmpty: false, description: "occupied by window" }
  * Segment 3: { wall: "left", segmentStart: 60, segmentEnd: 100, isEmpty: true, description: "empty wall segment after window" }
- Map segments for ALL visible walls, even if completely empty
- **Negative Space Protection**: Empty wall segments MUST remain empty - no new openings can be added there

🔍 CRITICAL DETECTION RULES:

1. **DETECT EVERY OPENING**: Every window, door, doorway, pass-through must be mapped
2. **PRECISE WALL ASSIGNMENT**: Carefully identify which wall each opening is on
3. **ACCURATE SPAN**: Estimate the percentage span as accurately as possible
4. **CONFIDENCE SCORING**: 
   - high: Opening clearly visible and position certain
   - medium: Opening visible but position estimate approximate
   - low: Opening partially visible or position uncertain
5. **DESCRIPTION CLARITY**: Provide clear descriptions for reference (e.g., "large window centered on left wall", "doorway in back right corner")
6. **DOMINANT FURNITURE PRIORITY**: 
   - Bedroom → Measure BED (ignore nightstands, chairs, etc.)
   - Living room → Measure SOFA/SECTIONAL (ignore side tables, etc.)
   - Dining room → Measure DINING TABLE (ignore chairs)
   - If no clear dominant piece, set dominantFurniture to null
7. **PERCENTAGE PRECISION**: Be accurate with measurements (±5% tolerance) - these will be enforced in Stage 2

⚠️ COMMON SCENARIOS:

**Corner Openings**: If opening is near wall intersection, assign to the wall it primarily belongs to
**Multiple Openings on Same Wall**: Each gets separate entry with different spans
**Partially Visible Openings**: Include them with lower confidence scores
**Open-Concept Spaces**: Map all pass-throughs and large openings between zones
**Kitchen Visible from Room**: If kitchen is visible in background/side, map the open area as "passthrough" (prevents walls being added)

🎯 COMPLETE EXAMPLES:

Example 1 - Medium Bedroom with Double Bed:
{
  "roomType": "bedroom",
  "spatialFeatures": [
    {
      "type": "window",
      "wall": "right",
      "spanStart": 60,
      "spanEnd": 90,
      "heightLevel": "mid",
      "size": "medium",
      "description": "medium window on right wall",
      "confidence": "high"
    }
  ],
  "wallSegments": [
    { "wall": "left", "segmentStart": 0, "segmentEnd": 100, "isEmpty": true, "description": "empty wall segment (suitable for furniture)" },
    { "wall": "right", "segmentStart": 0, "segmentEnd": 60, "isEmpty": true, "description": "empty wall segment before window" },
    { "wall": "right", "segmentStart": 60, "segmentEnd": 90, "isEmpty": false, "description": "occupied by window" },
    { "wall": "right", "segmentStart": 90, "segmentEnd": 100, "isEmpty": true, "description": "empty wall segment after window" },
    { "wall": "back", "segmentStart": 0, "segmentEnd": 100, "isEmpty": true, "description": "empty wall segment (bed placement area)" }
  ],
  "dominantFurniture": {
    "type": "bed",
    "floorCoveragePercent": 38,
    "imageCoveragePercent": 28,
    "dimensions": {
      "widthPercent": 55,
      "depthPercent": 42
    },
    "position": "centered against back wall"
  },
  "layoutNotes": "Medium bedroom with window on right wall, bed centered on back wall",
  "totalOpenings": 1,
  "floorVisibilityPercent": 52
}

Example 2 - Living Room with L-Shaped Sectional:
{
  "roomType": "living_room",
  "spatialFeatures": [
    {
      "type": "window",
      "wall": "left",
      "spanStart": 20,
      "spanEnd": 50,
      "heightLevel": "mid",
      "size": "large",
      "description": "large window on left wall with curtains",
      "confidence": "high"
    },
    {
      "type": "doorway",
      "wall": "back",
      "spanStart": 70,
      "spanEnd": 90,
      "heightLevel": "full-height",
      "size": "medium",
      "description": "doorway in back right corner",
      "confidence": "high"
    }
  ],
  "wallSegments": [
    { "wall": "left", "segmentStart": 0, "segmentEnd": 20, "isEmpty": true, "description": "empty wall segment before window" },
    { "wall": "left", "segmentStart": 20, "segmentEnd": 50, "isEmpty": false, "description": "occupied by large window" },
    { "wall": "left", "segmentStart": 50, "segmentEnd": 100, "isEmpty": true, "description": "empty wall segment after window" },
    { "wall": "right", "segmentStart": 0, "segmentEnd": 100, "isEmpty": true, "description": "empty wall segment (no openings)" },
    { "wall": "back", "segmentStart": 0, "segmentEnd": 70, "isEmpty": true, "description": "empty wall segment before doorway" },
    { "wall": "back", "segmentStart": 70, "segmentEnd": 90, "isEmpty": false, "description": "occupied by doorway" },
    { "wall": "back", "segmentStart": 90, "segmentEnd": 100, "isEmpty": true, "description": "empty wall segment after doorway" }
  ],
  "dominantFurniture": {
    "type": "sofa",
    "floorCoveragePercent": 32,
    "imageCoveragePercent": 24,
    "dimensions": {
      "widthPercent": 65,
      "depthPercent": 28
    },
    "position": "L-shaped sectional against left and back walls"
  },
  "layoutNotes": "Living room with large window on left, doorway in back right, L-shaped sectional sofa",
  "totalOpenings": 2,
  "floorVisibilityPercent": 48
}

Example 3 - Open-Concept Living/Dining with Kitchen Pass-Through:
{
  "roomType": "living_room",
  "spatialFeatures": [
    {
      "type": "window",
      "wall": "left",
      "spanStart": 10,
      "spanEnd": 45,
      "heightLevel": "mid",
      "size": "large",
      "description": "large window on left wall",
      "confidence": "high"
    },
    {
      "type": "passthrough",
      "wall": "right",
      "spanStart": 50,
      "spanEnd": 100,
      "heightLevel": "mid",
      "size": "large",
      "description": "open kitchen visible on right side (open-concept design)",
      "confidence": "high"
    }
  ],
  "wallSegments": [
    { "wall": "left", "segmentStart": 0, "segmentEnd": 10, "isEmpty": true, "description": "empty wall segment before window" },
    { "wall": "left", "segmentStart": 10, "segmentEnd": 45, "isEmpty": false, "description": "occupied by large window" },
    { "wall": "left", "segmentStart": 45, "segmentEnd": 100, "isEmpty": true, "description": "empty wall segment after window" },
    { "wall": "right", "segmentStart": 0, "segmentEnd": 50, "isEmpty": true, "description": "empty wall segment before passthrough" },
    { "wall": "right", "segmentStart": 50, "segmentEnd": 100, "isEmpty": false, "description": "occupied by open kitchen passthrough (MUST stay open)" },
    { "wall": "back", "segmentStart": 0, "segmentEnd": 100, "isEmpty": true, "description": "empty wall segment (no openings)" }
  ],
  "dominantFurniture": {
    "type": "sofa",
    "floorCoveragePercent": 28,
    "imageCoveragePercent": 22,
    "dimensions": {
      "widthPercent": 58,
      "depthPercent": 26
    },
    "position": "sofa facing center, kitchen visible on right"
  },
  "layoutNotes": "Open-concept living room with kitchen visible on right - passthrough mapped to prevent walls being added",
  "totalOpenings": 2,
  "floorVisibilityPercent": 55
}

✅ SUCCESS CRITERIA:
- ALL openings detected and mapped
- Wall assignments accurate
- Span percentages reasonable approximations
- Descriptions clear and helpful

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
    
    console.log("[SPATIAL ANALYZER] Raw AI response:", JSON.stringify(text).substring(0, 500));
    
    // Extract JSON using robust method
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[SPATIAL ANALYZER] No JSON object found in response");
      return null;
    }
    
    let jsonStr = jsonMatch[0];
    
    try {
      const blueprint = JSON.parse(jsonStr) as SpatialBlueprint;
      
      // Validate the response structure
      if (!blueprint.spatialFeatures || !Array.isArray(blueprint.spatialFeatures)) {
        console.warn("[SPATIAL ANALYZER] Invalid spatialFeatures field");
        return null;
      }
      
      console.log(`[SPATIAL ANALYZER] Created spatial blueprint with ${blueprint.spatialFeatures.length} openings detected`);
      console.log(`[SPATIAL ANALYZER] Room type: ${blueprint.roomType}`);
      blueprint.spatialFeatures.forEach((feature, idx) => {
        console.log(`[SPATIAL ANALYZER]   ${idx + 1}. ${feature.type} on ${feature.wall} wall (${feature.spanStart}-${feature.spanEnd}%) - ${feature.description}`);
      });
      
      if (blueprint.dominantFurniture) {
        console.log(`[SPATIAL ANALYZER] Dominant furniture: ${blueprint.dominantFurniture.type}`);
        console.log(`[SPATIAL ANALYZER]   Floor coverage: ${blueprint.dominantFurniture.floorCoveragePercent}%`);
        console.log(`[SPATIAL ANALYZER]   Image coverage: ${blueprint.dominantFurniture.imageCoveragePercent}%`);
        console.log(`[SPATIAL ANALYZER]   Dimensions: ${blueprint.dominantFurniture.dimensions.widthPercent}% width x ${blueprint.dominantFurniture.dimensions.depthPercent}% depth`);
      } else {
        console.log(`[SPATIAL ANALYZER] No dominant furniture detected`);
      }
      
      return blueprint;
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
        console.log("[SPATIAL ANALYZER] Trimmed JSON");
        return JSON.parse(jsonStr) as SpatialBlueprint;
      }
      throw e;
    }
  } catch (error) {
    console.error("[SPATIAL ANALYZER] ❌ Failed to create spatial blueprint");
    console.error("[SPATIAL ANALYZER] Error message:", error instanceof Error ? error.message : String(error));
    console.error("[SPATIAL ANALYZER] Stack trace:", error instanceof Error ? error.stack : 'No stack trace available');
    console.error("[SPATIAL ANALYZER] Error details:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    return null;
  }
}

/**
 * Builds spatial constraints text to inject into Stage 2 prompts
 * This ensures all openings remain in their exact marked positions AND furniture proportions are preserved
 */
export function buildSpatialConstraints(blueprint: SpatialBlueprint | null): string[] {
  if (!blueprint) {
    return [];
  }
  
  const constraints: string[] = [];
  
  constraints.push("");
  constraints.push("🗺️ SPATIAL BLUEPRINT - MANDATORY ARCHITECTURAL & PROPORTIONAL CONSTRAINTS");
  constraints.push("This room has been precisely measured. You MUST preserve ALL spatial relationships:");
  constraints.push("");
  
  // FURNITURE PROPORTIONAL CONSTRAINTS (if dominant furniture exists)
  if (blueprint.dominantFurniture) {
    const furn = blueprint.dominantFurniture;
    const floorMin = Math.max(0, furn.floorCoveragePercent - 3);
    const floorMax = Math.min(100, furn.floorCoveragePercent + 3);
    const widthMin = Math.max(0, furn.dimensions.widthPercent - 5);
    const widthMax = Math.min(100, furn.dimensions.widthPercent + 5);
    
    constraints.push("📐 FURNITURE PROPORTIONAL CONSTRAINTS:");
    constraints.push(`The original ${furn.type.toUpperCase()} occupied specific proportions that MUST be maintained:`);
    constraints.push("");
    constraints.push(`  ✓ Floor Coverage: ${floorMin}-${floorMax}% of visible floor area (original: ${furn.floorCoveragePercent}%)`);
    constraints.push(`    → Your ${furn.type} MUST occupy approximately ${furn.floorCoveragePercent}% of the floor (±3%)`);
    constraints.push(`    → DO NOT shrink furniture to make room look more spacious`);
    constraints.push(`    → DO NOT enlarge furniture beyond original proportions`);
    constraints.push("");
    constraints.push(`  ✓ Width: ${widthMin}-${widthMax}% of room width (original: ${furn.dimensions.widthPercent}%)`);
    constraints.push(`    → Your ${furn.type} MUST span approximately ${furn.dimensions.widthPercent}% of room width (±5%)`);
    constraints.push(`    → Maintain realistic scale relative to room size`);
    constraints.push("");
    constraints.push(`  ✓ Position: ${furn.position}`);
    constraints.push(`    → Place ${furn.type} in similar position as original`);
    constraints.push(`    → Respect original room layout and flow`);
    constraints.push("");
    constraints.push("⚠️ CRITICAL PROPORTIONAL RULES:");
    constraints.push("1. **SIZE PRESERVATION**: Furniture MUST match original floor coverage percentage");
    constraints.push("2. **NO SHRINKING**: Do NOT reduce furniture size to create spacious appearance");
    constraints.push("3. **NO EXPANDING**: Do NOT enlarge furniture beyond original proportions");
    constraints.push("4. **REALISTIC SCALE**: Furniture must be appropriately sized for room dimensions");
    constraints.push("5. **FLOOR VISIBILITY**: Target ~" + blueprint.floorVisibilityPercent + "% floor visibility (original measurement)");
    constraints.push("");
  }
  
  // OPENING POSITION CONSTRAINTS
  if (blueprint.spatialFeatures.length > 0) {
    constraints.push("🪟 OPENING POSITION CONSTRAINTS:");
    constraints.push("The following openings have been precisely mapped and MUST remain in their exact positions:");
    constraints.push("");
    
    // Group by wall for clarity
    const byWall = new Map<WallPosition, SpatialFeature[]>();
    blueprint.spatialFeatures.forEach((feature: SpatialFeature) => {
      if (!byWall.has(feature.wall)) {
        byWall.set(feature.wall, []);
      }
      byWall.get(feature.wall)!.push(feature);
    });
  
  // Output constraints by wall
  Array.from(byWall.entries()).forEach(([wall, features]) => {
    constraints.push(`📍 ${wall.toUpperCase()} WALL (${features.length} opening${features.length > 1 ? 's' : ''}):`);
    features.forEach((feature: SpatialFeature) => {
      const spanWidth = feature.spanEnd - feature.spanStart;
      constraints.push(`  ✓ ${feature.type.toUpperCase()}: Position ${feature.spanStart}-${feature.spanEnd}% (width: ${spanWidth}%)`);
      constraints.push(`    → ${feature.description}`);
      constraints.push(`    → Height: ${feature.heightLevel}, Size: ${feature.size}`);
      constraints.push(`    → MUST REMAIN in exact position on ${wall} wall`);
    });
    constraints.push("");
  });
  
  constraints.push("⚠️ CRITICAL SPATIAL ENFORCEMENT RULES:");
  constraints.push("1. **POSITION LOCK**: Every opening listed above MUST remain at its exact wall and span position");
  constraints.push("2. **NO MOVEMENT**: You CANNOT move, shift, or relocate ANY opening to a different wall or position");
  constraints.push("3. **NO NEW OPENINGS**: You CANNOT create new windows, doors, or openings not listed above");
  constraints.push("4. **NO REMOVAL**: You CANNOT remove or block ANY opening listed above");
  constraints.push("5. **SIZE PRESERVATION**: Opening sizes must remain approximately the same");
  constraints.push("6. **WALL INTEGRITY**: Walls between openings must remain solid and unchanged");
  constraints.push("");
  constraints.push("🚫 PASS-THROUGH & OPEN AREA PROTECTION:");
  constraints.push("If ANY 'passthrough' or 'opening' is listed above (e.g., open kitchen, breakfast bar):");
  constraints.push("  ❌ DO NOT add walls, partitions, or barriers in these open areas");
  constraints.push("  ❌ DO NOT close off, block, or cover these visual connections between spaces");
  constraints.push("  ❌ DO NOT place furniture that obstructs the openness of pass-throughs");
  constraints.push("  ✓ MAINTAIN the open-concept design and visual flow between spaces");
  constraints.push("  ✓ RESPECT architectural openness - if kitchen is visible, it MUST remain visible");
  constraints.push("");
  }

  // WALL SEGMENT CONSTRAINTS (Negative Space Protection)
  if (blueprint.wallSegments && blueprint.wallSegments.length > 0) {
    constraints.push("🧱 WALL SEGMENT MAPPING - NEGATIVE SPACE PROTECTION:");
    constraints.push("The following wall segments have been mapped to prevent false architecture:");
    constraints.push("");
    
    // Group empty segments by wall
    const emptySegmentsByWall = new Map<WallPosition, WallSegment[]>();
    blueprint.wallSegments.filter(seg => seg.isEmpty).forEach(segment => {
      if (!emptySegmentsByWall.has(segment.wall)) {
        emptySegmentsByWall.set(segment.wall, []);
      }
      emptySegmentsByWall.get(segment.wall)!.push(segment);
    });
    
    // Output empty wall segments (critical for preventing new openings)
    if (emptySegmentsByWall.size > 0) {
      constraints.push("🔒 EMPTY WALL SEGMENTS (MUST REMAIN EMPTY):");
      Array.from(emptySegmentsByWall.entries()).forEach(([wall, segments]) => {
        constraints.push(`  ${wall.toUpperCase()} WALL:`);
        segments.forEach(segment => {
          const spanWidth = segment.segmentEnd - segment.segmentStart;
          constraints.push(`    • ${segment.segmentStart}-${segment.segmentEnd}% (${spanWidth}% span) - ${segment.description}`);
        });
      });
      constraints.push("");
      constraints.push("⛔ NEGATIVE SPACE RULES:");
      constraints.push("  ❌ DO NOT add new doors, windows, or openings in empty wall segments");
      constraints.push("  ❌ DO NOT create architectural elements where none existed");
      constraints.push("  ❌ DO NOT add doorways, archways, or pass-throughs to empty walls");
      constraints.push("  ✓ Empty wall segments are for FURNITURE placement ONLY");
      constraints.push("  ✓ All architectural openings have been pre-mapped above");
      constraints.push("");
    }
  }
  
  constraints.push(`Total openings mapped: ${blueprint.totalOpenings}`);
  constraints.push(`Room layout: ${blueprint.layoutNotes}`);
  constraints.push("");
  constraints.push("🔍 SELF-VERIFICATION CHECKLIST (you MUST verify before completion):");
  constraints.push("□ All openings remain on their designated walls");
  constraints.push("□ All opening positions match the span percentages listed above");
  constraints.push("□ No new openings created");
  constraints.push("□ No existing openings removed or blocked");
  constraints.push("□ Wall surfaces between openings remain unchanged");
  constraints.push("");
  
  return constraints;
}
