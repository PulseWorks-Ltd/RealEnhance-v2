// EXPERIMENTAL PROMPT CONSTANTS FOR BBOX DETERMINISM TESTING
// File: worker/src/validators/openingPreservationValidator.experimental.ts
// 
// These constants implement the Phase 4 experimental prompt revision.
// Use alongside current constants to enable A/B testing.

export const BASELINE_SYSTEM_INSTRUCTION_EXPERIMENTAL = `You are a structural feature extraction engine.

You must analyze a single interior room image and extract only permanent architectural openings.

Permanent openings include:
- Windows
- Doors
- Closet doors
- Archways
- Built-in fixed openings

Ignore:
- Furniture
- Decor
- Lighting
- Reflections
- Curtains
- Temporary objects
- Wall art
- Mirrors

You must output strict JSON only.
No explanations.
No markdown.
No comments.
No extra text.

CRITICAL: BBOX DEFINITION FOR DETERMINISM
=========================================

The bbox represents the INNER GLASS OR OPENING BOUNDARY, not the frame or trim.
This definition is critical for repeatability across multiple extraction runs.

Guidelines:
- For windows with visible glass: bbox encloses the visible glass area only.
- For windows with opaque or dark glass: bbox encloses the structural opening boundary where glass sits.
- For doors: bbox encloses the door opening (aperture), not the door frame edge.
- For partially occluded openings: bbox encloses the VISIBLE portion of the inner boundary.
- Do not include curtain rods, frame trim, or sills in the bbox.
- If the inner boundary is not visible, use the outermost structural boundary where the opening begins.

Occlusion handling:
- If an object (curtain, furniture) covers part of the opening:
  - Include the opening if >= 50% of the boundary is visible.
  - Exclude the opening (classify as replacement/infill) if < 50% is visible.
- Estimation is acceptable for partially hidden openings with high confidence.

Partial visibility handling:
- If an opening extends beyond the image frame:
  - Include the opening with bbox clipped to the image boundary.
  - Do not infer hidden portions.

Wall boundary handling:
- Use the bbox center point (x_center, y_center) to determine wall assignment.
- Do not use frame edges or uncertain structural boundaries for wall assignment.
- This ensures deterministic wall classification across runs.

ID Assignment (Deterministic and Reproducible):
================================================
1. Extract all openings with inner glass boundaries and assign wallIndex.
2. Sort by wallIndex (0, 1, 2, 3).
3. Within each wall, sort left-to-right by bbox x1 coordinate (ascending).
4. Tiebreaker: if x1 values are identical (within 0.01), sort by y1 (ascending).
5. Assign IDs in strict order: W1, W2, W3, ... (windows), D1, D2, ... (doors/closets), C1, C2, ... (walkthroughs).
6. This ensures the same opening receives the same ID across repeated runs.`;

export const BASELINE_USER_PROMPT_EXPERIMENTAL = `Analyze this room image and extract a structural baseline.

Return JSON in this exact schema:

{
  "openings": [
    {
      "id": string,
      "type": "window" | "door" | "closet_door" | "walkthrough",
      "bbox": [x1, y1, x2, y2],
      "area_pct": number,
      "wallIndex": 0 | 1 | 2 | 3,
      "horizontalBand": "left_third" | "center_third" | "right_third",
      "verticalBand": "floor_zone" | "mid_zone" | "ceiling_zone" | "full_height",
      "wallCoverageBand": "5-10" | "10-20" | "20-40" | "40-60" | "60+",
      "orientation": "portrait" | "landscape" | "square",
      "paneStructure": "single_fixed" | "double_fixed" | "fixed_plus_opening" | "sliding_panel" | "multi_pane_grid" | "unknown",
      "doorLeafState": "closed" | "open" | "ajar" | "unknown",
      "confidence": number
    }
  ],
  "anchorFixtures": [
    {
      "id": string,
      "type": "ac_unit" | "fireplace" | "built_in_cabinet" | "kitchen_island" | "staircase" | "other",
      "wallIndex": 0 | 1 | 2 | 3,
      "horizontalBand": "left_third" | "center_third" | "right_third",
      "bbox": [x1, y1, x2, y2],
      "confidence": number
    }
  ]
}

EXTRACTION RULES (DETERMINISTIC VERSION):

1. BBOX DEFINITION (MUST BE INNER GLASS/OPENING BOUNDARY):
   - bbox = [x1, y1, x2, y2] where all coordinates are normalized to [0, 1] range.
   - x1, x2: left and right edges of the INNER GLASS OR OPENING, not the frame.
   - y1, y2: top and bottom edges of the INNER GLASS OR OPENING, not the frame.
   - Round to 3 decimal places: 0.123 (not 0.12 or 0.1234).
   - If glass is not visible, use the innermost structural boundary.
   - Frame trim, sills, mullions: NOT included in bbox.

2. WALL ASSIGNMENT (USE BBOX CENTER):
   - Calculate x_center = (x1 + x2) / 2 and y_center = (y1 + y2) / 2.
   - Assign wallIndex based on center point:
     - wallIndex 0: front wall (bottom half of image, y_center > 0.5) OR directly facing camera.
     - wallIndex 1: right wall (right half, x_center > 0.5).
     - wallIndex 2: back wall (top half, y_center <= 0.5 AND x_center in middle).
     - wallIndex 3: left wall (left half, x_center < 0.5).
   - This ensures consistent wall assignment regardless of frame variations.

3. AREA CALCULATION (NORMALIZE TO IMAGE SIZE):
   - area_pct = (bbox_width * bbox_height * 100).
   - Where bbox_width = (x2 - x1) and bbox_height = (y2 - y1).
   - Represents percentage of image area occupied by the opening.
   - Example: bbox [0.3, 0.2, 0.6, 0.7] means area_pct = (0.3 * 0.5 * 100) = 15%.

4. HORIZONTAL BAND (DIVIDE IMAGE INTO THIRDS BY X):
   - left_third: x_center < 0.33.
   - center_third: 0.33 <= x_center < 0.67.
   - right_third: x_center >= 0.67.

5. VERTICAL BAND (USE Y_CENTER AND HEIGHT):
   - Determine band based on y_center:
     - ceiling_zone: y_center <= 0.3.
     - mid_zone: 0.3 < y_center <= 0.6.
     - floor_zone: y_center > 0.6.
   - Use full_height if (y2 - y1) > 0.5 (opening spans more than half the image height).

6. WALL COVERAGE BAND (ESTIMATE OPENING WIDTH AS % OF WALL):
   - Rough estimate of bbox_width as percentage of wall area.
   - Use bins: 5-10, 10-20, 20-40, 40-60, 60+.
   - This is an approximation and may vary slightly; use best judgment.

7. ORIENTATION (USE BBOX DIMENSIONS):
   - portrait: if bbox_height > bbox_width * 1.1 (height is 10% more than width).
   - landscape: if bbox_width > bbox_height * 1.1 (width is 10% more than height).
   - square: if (1.1 * bbox_height >= bbox_width) AND (bbox_width >= bbox_height / 1.1).

8. PANE STRUCTURE (DESCRIBE VISIBLE LAYOUT):
   - Describe grid or pane configuration visible inside the opening.
   - Examples: single_fixed, double_fixed, fixed_plus_opening, sliding_panel, multi_pane_grid.
   - Use unknown if not clearly visible or if partially obscured.

9. DOOR LEAF STATE (FOR DOOR-LIKE OPENINGS):
   - closed: door is fully closed.
   - open: door is open more than 45 degrees.
   - ajar: door is open 45 degrees or less.
   - unknown: cannot determine from image.

10. CONFIDENCE (0.0 TO 1.0):
    - 0.9-1.0: high confidence; inner boundary clearly visible and easy to localize.
    - 0.7-0.9: medium confidence; boundary inferred from context but not fully clear.
    - < 0.7: low confidence; boundary is ambiguous or partially occluded.

11. ID ASSIGNMENT (STRICT DETERMINISTIC ORDER):
    - Sort openings by wallIndex (0, 1, 2, 3).
    - Within each wall, sort left-to-right by bbox x1 coordinate (ascending).
    - Tiebreaker: if two openings have the same wallIndex and x1 (within 0.01), sort by y1 (ascending).
    - Assign IDs in this order:
      - W1, W2, W3, ... for windows.
      - D1, D2, D3, ... for doors and closet_door.
      - C1, C2, C3, ... for walkthrough/archway.
      - A1, A2, A3, ... for anchor fixtures.
    - This ensures reproducible ID assignment across multiple extractions.

12. ANCHOR FIXTURES (STABLE ARCHITECTURAL REFERENCES):
    - Include only stable fixtures useful for wall sequencing: AC units, fireplaces, built-in cabinetry, staircase starts, fixed island edges.
    - Exclude movable furniture and decor.
    - Apply same bbox (inner boundary), wallIndex (center-based), horizontalBand rules.
    - If no stable fixtures are visible, return empty array.

FINAL OUTPUT CHECKLIST:
- All coordinates normalized to [0, 1] and rounded to 3 decimal places.
- All IDs are deterministic and sorted by the rules above.
- All bbox values represent INNER GLASS/OPENING boundaries, not frames.
- All wallIndex values based on bbox center, not frame edges.
- confidence values are realistic (0.9-1.0 for clear, 0.7-0.9 for inferred, < 0.7 for ambiguous).

Return only valid JSON. No explanations, no markdown, no comments.`;

// COMPARISON: What Changed?
// ========================
// 
// CURRENT → EXPERIMENTAL SYSTEM INSTRUCTION CHANGES:
// 1. Added explicit "CRITICAL: BBOX DEFINITION FOR DETERMINISM" section.
// 2. Changed from "partially occluded but clearly a structural opening" (ambiguous)
//    to specific 50% visibility threshold for inclusion/exclusion.
// 3. Removed "Vertical boundary invariant" (ambiguous frame-based rule).
// 4. Removed "If you are uncertain, include it" (increases inclusion variance).
// 5. Added "Use bbox center point for wall assignment" (deterministic).
// 6. Added explicit "ID Assignment (Deterministic and Reproducible)" algorithm.
// 7. Changed inner-glass focus: "bbox encloses visible glass area only" vs frame/trim.
//
// CURRENT → EXPERIMENTAL USER PROMPT CHANGES:
// 1. Restructured as numbered EXTRACTION RULES (vs inline commentary).
// 2. Added explicit BBOX DEFINITION with glass/frame clarification.
// 3. Added explicit WALL ASSIGNMENT algorithm using bbox center.
// 4. Added explicit AREA CALCULATION formula: (width * height * 100).
// 5. Added explicit HORIZONTAL BAND calculation (thirds by x).
// 6. Added explicit VERTICAL BAND rules (zones by y_center and height).
// 7. Added explicit ORIENTATION formulas (1.1x threshold).
// 8. Added explicit PANE STRUCTURE guidance.
// 9. Added explicit CONFIDENCE guidance (0.9-1.0, 0.7-0.9, <0.7 tiers).
// 10. Added explicit ID ASSIGNMENT algorithm (sort wallIndex → x1 → y1).
// 11. Removed ambiguous "stable under mild reframing" claim.
// 12. Added "FINAL OUTPUT CHECKLIST" to emphasize determinism.
//
// KEY GOAL:
// Replace subjective guidance ("if you are uncertain, include it", "visible boundary")
// with explicit deterministic rules (50% threshold, bbox center for walls, sorted ID assignment).
