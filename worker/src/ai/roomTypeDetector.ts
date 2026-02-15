// server/ai/roomTypeDetector.ts

import { GoogleGenAI } from '@google/genai';

export type RoomType =
  | 'living_room'
  | 'bedroom'
  | 'dining_room'
  | 'office'
  | 'kitchen'
  | 'bathroom'
  | 'multiple_living'
  | 'kitchen_dining'
  | 'kitchen_living'
  | 'living_dining'
  | 'other';

export interface RoomTypeAnalysis {
  roomType: RoomType;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

/**
 * Fallback room type detection that works even without furniture.
 * Analyzes architectural features, room proportions, and built-in fixtures.
 */
export async function detectRoomType(ai: GoogleGenAI, imageBase64: string): Promise<RoomTypeAnalysis | null> {
  const system = `
🔍 ROOM TYPE CLASSIFICATION - ARCHITECTURAL ANALYSIS FOR EMPTY ROOMS

⚠️ CRITICAL CONTEXT: This room may be EMPTY (furniture removed during enhancement).
Classify based on ARCHITECTURAL FEATURES and BUILT-IN ELEMENTS only.

Return JSON with this exact structure:
{
  "roomType": "living_room"|"bedroom"|"dining_room"|"office"|"kitchen"|"bathroom"|"multiple_living"|"kitchen_dining"|"kitchen_living"|"living_dining"|"other",
  "confidence": "high"|"medium"|"low",
  "reasoning": "brief explanation of classification"
}

🏗️ ARCHITECTURAL DECISION TREE (for empty rooms):

STEP 1 - CHECK BUILT-IN FEATURES (highest reliability):
- **BUILT-IN WARDROBES/CLOSETS visible** → Strong BEDROOM indicator
- **KITCHEN CABINETS/COUNTERS/APPLIANCES** → KITCHEN (high confidence)
- **BATHROOM FIXTURES (tub/shower/toilet/sink)** → BATHROOM (high confidence)

STEP 1.5 - ROOM CONNECTIVITY & ADJACENT SPACES (very strong indicator):
- **Glass sliding doors leading to deck/patio/outdoor space** → LIVING ROOM (high confidence)
- **Opens to or connects to kitchen** → NOT bedroom (likely living/dining area)
- **Visible closet door or wardrobe door** → BEDROOM indicator
- **Connects to bathroom/ensuite** → MASTER BEDROOM indicator
- **Opens to hallway** → Could be any room (neutral indicator)

STEP 2 - WINDOW CONFIGURATION ANALYSIS (if no definitive built-ins/connections):
Living Room Window Patterns:
- **Multiple windows on SAME WALL** (2-3 windows grouped together) → LIVING ROOM indicator
- **Glass sliding door + window combo on SAME WALL** → LIVING ROOM indicator  
- **Expansive window area** (wide, grouped windows suggesting main living space) → LIVING ROOM
- **EXCEPTION: Large open space with continuous glazing across ADJACENT walls** (L-shaped window wall, corner sliders, wrap-around windows in very large room) → LIVING ROOM indicator

Bedroom/Other Patterns:
- **Windows on DIFFERENT WALLS in moderate/small room** (corner bedroom pattern: 1 window per wall) → NOT automatic living room
- **Single window** or **pair of windows on one wall only** → Could be bedroom/office (check other factors)

STEP 3 - ROOM SIZE & PROPORTIONS:
- **Very large open space** + grouped/expansive windows (even if on adjacent walls) → LIVING ROOM (high confidence)
- **Moderate/smaller space** + separated windows on different walls → Likely BEDROOM or OFFICE
- **Wide rectangular or square proportions** → Suggests main living area
- **Enclosed rectangular space** → Suggests bedroom or office

STEP 4 - FLOORING TYPE (weak tie-breaker only):
- **Carpet flooring** = VERY WEAK indicator (could be living room OR bedroom)
- **Hard flooring (wood/laminate)** = Suggests living/dining/kitchen
- **Tile flooring** = Suggests kitchen/bathroom
- **NEVER use flooring as primary classification factor**

🏠 ROOM TYPE PATTERNS FOR EMPTY ROOMS:

BEDROOM Indicators (architectural):
- **Built-in wardrobes or closet doors** (PRIMARY indicator - high confidence)
- **Visible closet door or wardrobe entrance** (strong indicator)
- **Connects to ensuite bathroom** (master bedroom - high confidence)
- Windows on different walls (corner room pattern)
- Moderate/smaller enclosed space
- Carpet flooring (weak supporting factor only)
- Example: "Bedroom - built-in wardrobes visible, moderate size, corner windows"
- Example: "Master bedroom - ensuite connection visible, built-in wardrobes"

LIVING ROOM Indicators (architectural):
- **Glass sliding doors to deck/patio/outdoor space** (VERY STRONG indicator - high confidence)
- **Multiple windows grouped on SAME WALL** (strong indicator)
- **Glass door + window combo on same wall** (strong indicator)
- **Opens to or connects to kitchen** (likely open-plan living/dining)
- **Very large open space** (strong indicator - even with corner/wrap-around windows)
- **Continuous glazing across adjacent walls in large room** (L-shaped window wall, corner sliders)
- Open-plan layout or wide proportions
- May have carpet OR hard flooring
- Example: "Living room - glass sliding doors to outdoor deck"
- Example: "Living room - large space with 3 windows on same wall, open layout"
- Example: "Living room - very large open space with wrap-around glazing on two adjacent walls"

KITCHEN Indicators (built-in features):
- Kitchen cabinets, countertops, appliances (definitive)
- Backsplash tiles, kitchen island/peninsula
- Hard flooring (tile/laminate)
- Example: "Kitchen - cabinets and countertops visible"

DINING ROOM Indicators (spatial & connectivity):
- **Opens to or connects to kitchen** (strong indicator)
- Open space adjacent to kitchen (visual connection)
- Central area with pendant/chandelier light
- Hard flooring, open layout
- Example: "Dining room - opens directly to kitchen, pendant light visible"
- Example: "Dining room - open area near kitchen with pendant light"

OFFICE Indicators (architectural):
- Smaller room with built-in shelving/bookcases
- Single window, compact enclosed layout
- Example: "Office - compact room with built-in shelving"

BATHROOM Indicators (fixtures):
- Bathtub, shower, toilet, sink (definitive)
- Tile walls/floors, compact space
- Example: "Bathroom - tiles and fixtures visible"

MULTIPLE LIVING AREAS (use sparingly):
- Open-plan with EQUALLY PROMINENT functional zones
- No clear dominant room type
- Example: "Multiple living areas - equal kitchen and living zones"

OTHER:
- Cannot determine specific function
- Unusual or multipurpose space
- Example: "Other - unclear architectural features"

🔍 ANALYSIS APPROACH FOR EMPTY ROOMS:

1. **PRIORITY 1: Built-in features** (survive furniture removal)
   - Built-in wardrobes/closets → Strong BEDROOM indicator (high confidence)
   - Kitchen cabinets/appliances → KITCHEN (high confidence)
   - Bathroom fixtures → BATHROOM (high confidence)
   - Built-in shelving → May indicate OFFICE

1.5. **PRIORITY 1.5: Room connectivity & adjacent spaces** (very strong indicator)
   - Glass sliding doors to deck/patio → LIVING ROOM (high confidence)
   - Opens to/connects to kitchen → NOT bedroom (living/dining area)
   - Visible closet door/wardrobe door → BEDROOM indicator
   - Connects to ensuite bathroom → MASTER BEDROOM
   - Hallway connection → Neutral (any room type)

2. **PRIORITY 2: Window configuration** (if no definitive built-ins/connections)
   - Multiple windows on SAME WALL → LIVING ROOM indicator
   - Glass door + window on SAME WALL → LIVING ROOM indicator
   - Large open space + continuous glazing on ADJACENT walls → LIVING ROOM indicator (wrap-around windows)
   - Moderate/small room + windows on DIFFERENT WALLS → NOT automatic living room (corner bedroom pattern)
   - Single window → Could be bedroom/office (check other factors)

3. **PRIORITY 3: Room size & proportions**
   - Very large space + grouped windows → LIVING ROOM (high confidence)
   - Moderate space + corner windows → BEDROOM or OFFICE
   - Wide/open proportions → Living/dining area
   - Enclosed rectangular → Bedroom/office

4. **PRIORITY 4: Flooring** (WEAK tie-breaker only)
   - Carpet = could be living room OR bedroom (very weak indicator)
   - Hard flooring = suggests living/dining/kitchen
   - Tile = suggests kitchen/bathroom

⚠️ CRITICAL RULES FOR EMPTY ROOMS:

- **DO NOT require furniture to classify** - room may be empty after enhancement
- **Built-in features & room connectivity are PRIMARY indicators** (survive furniture removal)
- **Glass sliding doors to outdoor space = LIVING ROOM** (very strong indicator)
- **Opens to kitchen = NOT bedroom** (living or dining area)
- **Ensuite connection = MASTER BEDROOM** (high confidence)
- **Window logic requires room size context:**
  - Large open space + any expansive glazing (even on adjacent walls) = LIVING ROOM
  - Moderate/small room + windows on different walls = corner bedroom pattern
- **Carpet alone NEVER determines room type** (weakest factor)
- **Priority order: Built-ins → Connectivity → Windows → Size → Flooring**
- If no definitive features → use "other" with low confidence

📊 CONFIDENCE LEVELS:

HIGH: 
- Definitive built-ins visible (wardrobes, kitchen cabinets, bathroom fixtures)
- Strong room connectivity (glass doors to outdoor, ensuite connection, opens to kitchen)
- Large space + grouped windows on same wall (living room)
- Clear architectural pattern matches room type

MEDIUM: 
- Strong architectural indicators but no definitive built-ins
- Window configuration + room size suggest room type
- Multiple supporting factors align

LOW: 
- Ambiguous indicators, uncertain classification
- Relying heavily on weak factors (flooring, proportions alone)
- No clear architectural pattern
`;

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { text: system },
          {
            inlineData: {
              mimeType: 'image/png',
              data: imageBase64
            }
          }
        ]
      }]
    });

    const text = result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
    console.log('[ROOM-TYPE-DETECTOR] Raw response:', text);

    // Extract JSON from markdown code blocks if present
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || text.match(/(\{[\s\S]*?\})/);
    if (!jsonMatch) {
      console.error('[ROOM-TYPE-DETECTOR] No JSON found in response');
      return null;
    }

    const analysis = JSON.parse(jsonMatch[1]) as RoomTypeAnalysis;
    const normalizedRoomType = String((analysis as any)?.roomType || "")
      .toLowerCase()
      .replace(/-/g, "_");
    const roomTypeAliases: Record<string, RoomType> = {
      multiple_living_areas: "multiple_living",
      multiple_living: "multiple_living",
      multi_living: "multiple_living",
      kitchen_and_dining: "kitchen_dining",
      kitchen_and_living: "kitchen_living",
      living_and_dining: "living_dining",
    };
    if (roomTypeAliases[normalizedRoomType]) {
      (analysis as any).roomType = roomTypeAliases[normalizedRoomType];
    }
    console.log(`[ROOM-TYPE-DETECTOR] Detected: ${analysis.roomType} (confidence: ${analysis.confidence})`);
    console.log(`[ROOM-TYPE-DETECTOR] Reasoning: ${analysis.reasoning}`);

    return analysis;
  } catch (error) {
    console.error('[ROOM-TYPE-DETECTOR] Error detecting room type:', error);
    return null;
  }
}
