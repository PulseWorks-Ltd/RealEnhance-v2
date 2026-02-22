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
`;

export const STAGE2_CAMERA_IMMUTABILITY_BLOCK = `
────────────────────────────────
CAMERA IMMUTABILITY — HARD LOCK
────────────────────────────────
Maintain exact camera geometry:
- same viewpoint
- same perspective
- same focal length / field-of-view
- same framing and crop

Do NOT introduce camera shift, re-angle, zoom, or recrop.
`;

export const STAGE2_OUTPUT_FORMAT_BLOCK = `
────────────────────────────────
OUTPUT
────────────────────────────────
Return only the edited image.
`;
