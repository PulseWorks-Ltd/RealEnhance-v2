// server/policies/unified-structural.ts
// Single source of truth for all structural rules

export const DOORWAY_CLEARANCE_RULE = 
  "Doorways & egress: Door type matters! HINGED DOORS (traditional swing doors, French doors, bifold doors): NEVER place furniture in front of, across, or within the door swing arc - keep full swing clearance PLUS 30–60 cm walkway for safe egress. SLIDING DOORS (pocket doors, barn doors, patio sliders): Require clear walking access of 75–90 cm (30–36 inch minimum pathway) to reach the door - NO swing clearance needed since they slide parallel to wall. ALL door frames, handles, tracks, and hardware must remain fully unobstructed and visible.";

export const WINDOW_CLEARANCE_RULE = 
  "Windows: Furniture may sit in front of windows (sofa/desk/bench/planter) as long as window frames/glass remain clearly visible and windows remain operable. Never block or intersect frames, handles, or openings. Keep 5–15 cm visual clearance from frames/sills.";

export const UNIFIED_STRUCTURAL_POLICY = `
[STRUCTURAL RULES — DO NOT BREAK]
• Do not add, remove, resize, or distort fixed architectural features (doors, windows, walls, ceilings, stairs, pillars, beams, built-ins, fixed plumbing/electrical).
• ${DOORWAY_CLEARANCE_RULE}
• FLOOR-ONLY placement: legs meet the floor with a soft, consistent ground shadow. Nothing attached to vertical planes (walls, doors, cupboards), nothing floating.
• Respect perspective: verticals vertical; align furniture with the floor plane.

[WINDOW CLARIFICATION]  
• ${WINDOW_CLEARANCE_RULE}

[NEGATIVE CONSTRAINTS]
• Do NOT block, overlap, or partially intersect any door, doorway, frame, or handle with any furniture footprint (bed/sofa/table/chair/nightstand/sideboard/plant).
• HINGED DOORS (including French & bifold): Do NOT place furniture within the door swing arc or directly across the egress path. SLIDING DOORS: Maintain minimum 75-90cm (30-36 inch) clear walking pathway to reach the door.
• Do NOT cover window glass or door openings with walls, artwork, or building materials.

[COMPOSITION & SPACING]
• Stage the whole usable room—don't bunch everything in one corner.
• CIRCULATION CLEARANCES: In-room walkways (moving between furniture within same room): 30–60 cm minimum. Room-to-room passages through wall openings (doorways, archways, pass-throughs): 75-90 cm (30-36 inch) minimum for safe pedestrian flow between spaces. Furniture must NOT narrow openings or create circulation bottlenecks.
• Wall spacing: 10–20 cm off walls for sofas/beds (unless flush is typical). Chairs at tables need realistic pull-out space.
• Use correct scale; prefer fewer correctly scaled items over many tiny pieces.

[IF CONFLICT]
• If any planned item risks blocking egress or intersecting frames/walls, relocate or omit it. Prioritize one believable main vignette over forcing items.
`.trim();