export const STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK = `
────────────────────────────────
ARCHITECTURAL IMMMUTABILITY — HARD LOCK
────────────────────────────────
Preserve exactly:
- walls, ceilings, floors, trims, coves, soffits, beams, columns
- windows, doors, frames, reveals, openings, glazing
- built-in cabinetry, islands, vanities, fixed shelving, fixed fixtures
- structural room footprint, wall positions, opening geometry

Do NOT:
- add/remove/move/resize walls, windows, doors, or openings
- create partitions, bulkheads, room splits, recesses, or new planes
- alter built-in footprints or fixed fixture geometry
- repaint/retile/re-floor to conceal structural edits

Maintain all existing installed ceiling lighting and fixtures unchanged.
Do not introduce new ceiling-mounted or hanging light fixtures.
Do NOT introduce new pendant, suspended, or decorative feature lights above dining tables or kitchen islands unless the same fixed fixture already exists in that position in the source image.
Portable staged lighting decor (for example floor lamps and table lamps) is allowed.

🔒 Architectural Priority Clarification

Do NOT modify wall returns, wall angles, corner geometry, window side margins, or window height for aesthetic balance.
Do NOT adjust sill height or window proportions to accommodate furniture.
If furniture conflicts with architecture, reposition or resize the furniture instead.
Furniture must adapt to the room. The room must never adapt to the furniture.

PERSPECTIVE / VANISHING-POINT LOCK

Keep the TARGET image perspective, vanishing-point logic, and room geometry consistent.

Adapt furnishing placement, scale, and orientation so the staged result sits naturally within the TARGET room's native 3D geometry and perspective.

Contact points between furniture and architectural surfaces must respect the TARGET room's geometry.
Furniture must visually conform to the existing floor plane and wall angles.
Architectural surfaces must not deform at furniture contact points.

NEVER warp, skew, rotate, widen, narrow, stretch, bend, or reinterpret the walls, corners, ceiling lines, floor plane, openings, or architectural geometry to accommodate furniture placement.

Furniture must adapt to the room.
The room must never adapt to the furniture.
`;

export const STAGE2_CAMERA_IMMUTABILITY_BLOCK = `
────────────────────────────────
CAMERA IMMUTABILITY — HARD LOCK
────────────────────────────────
Keep the TARGET image viewpoint, framing, horizon alignment, and field-of-view visually consistent.

Maintain exact camera geometry:
- same viewpoint
- same perspective
- same focal length / field-of-view
- same framing and crop

Do NOT:
- recrop
- rotate
- widen
- narrow
- alter viewing angle
- adjust perspective
- introduce camera shift, re-angle, zoom, or recrop

All staging must stay within the existing TARGET view rather than re-framing the room.
`;

export const STAGE2_FIXED_FINISH_IMMUTABILITY_BLOCK = `
────────────────────────────────
FIXED-FINISH IMMUTABILITY — ABSOLUTE
────────────────────────────────
All permanent room finishes must remain visually identical to the source image.

The following elements must retain their exact:
- color
- tone
- material identity
- texture
- reflectivity
- finish appearance
- surface patterning
- visual age/wear characteristics

APPLIES TO:
- Flooring (all types: tile, wood, stone, carpet, linoleum)
- Cabinetry and built-in joinery
- Benchtops / countertops
- Splashbacks / backsplashes
- Vanities and fixed surfaces
- Built-in shelving and storage
- Fireplaces and mantels
- Wall paint, wallpaper, and surface finishes
- Ceiling finishes and textures
- Tile finishes (kitchen, bathroom, laundry)
- Appliance exterior finishes
- Any permanently attached or built-in materials

🚫 STRICTLY PROHIBITED — ZERO TOLERANCE:
- Recoloring finishes
- Brightening or darkening materials
- Warming or cooling tones
- Repainting or resurfacing
- Restaining or refinishing
- Retiling or replacing surface materials
- Restyle or modernizing finishes
- Luxury-upgrading appearance
- Visually reinterpreting materials
- Material tone drift or color shift
- Texture alteration or surface refinement
- Visual "refreshing" or "enhancement"
- Aesthetic harmonization of fixed finishes
- Altering material appearance through grading or relighting

CRITICAL PRINCIPLE
Staging style must ALWAYS adapt to existing finishes.
Existing finishes must NEVER be altered to match staging style.
If style conflicts with existing finishes, choose different furniture/décor — never modify the room.

EXPOSURE NORMALIZATION ONLY
Lighting correction may improve overall image exposure and realism only.
This must NOT result in any visual change to fixed room materials or finishes.
Pixel-perfect color matching required for all permanent room elements.
`;

export const STAGE2_OUTPUT_FORMAT_BLOCK = `
────────────────────────────────
OUTPUT
────────────────────────────────
Return only the edited image.
`;
