// Room brief — ONE AI call that reads the room photo and returns, in plain
// language, everything the staging prompt needs: what the room is, the
// visible landmarks (windows, doors, TV bracket, kitchen bench...), the
// zones, and a furniture layout described by those landmarks ("mount the TV
// on the black bracket on the white wall on the right", "dining table in
// front of the kitchen bench at the back").
//
// Replaces, for the staging prompt, the anchor-locked planner's chain of
// calls (structural baseline x2, wall visibility, zoning, fridge cavity),
// whose decisions reached Gemini as coordinates and wall ids it couldn't
// follow reliably (Kitchen 01/12, 2026-10-12: dining table in the lounge,
// TV on an invented wall). Image models follow descriptions of what they
// can see; this writes the layout that way.
//
// Behind STAGE2_ROOM_BRIEF=1 (off by default). Rule checks run on the
// answer (TV on the bracket, dining next to a visible kitchen, no
// coordinates); a failed check gets one corrected retry, then the caller
// falls back to the existing planner.

import fs from "fs";
import sharp from "sharp";
import { getGeminiClient } from "../ai/gemini";
import { visibleFloorPct } from "./stage2Masked/floorLine";

export const ROOM_BRIEF_MODEL = String(process.env.ROOM_BRIEF_MODEL || "gemini-3.8-flash");
const ROOM_BRIEF_MAX_SIDE = Math.max(512, Number(process.env.ROOM_BRIEF_IMAGE_MAX_SIDE || 1280));
const ROOM_BRIEF_THINKING_BUDGET = Math.max(512, Number(process.env.ROOM_BRIEF_THINKING_BUDGET || 2048));
const ROOM_BRIEF_TIMEOUT_MS = Math.max(10_000, Number(process.env.ROOM_BRIEF_TIMEOUT_MS || 90_000));

export function roomBriefEnabled(): boolean {
  return ["1", "on", "true", "yes"].includes(String(process.env.STAGE2_ROOM_BRIEF || "").trim().toLowerCase());
}

export type RoomBriefLandmark = {
  id: string;
  type: string;
  description: string;
  box?: number[]; // [x1, y1, x2, y2], 0..1 — for the door check / protections, never for layout
};

export type RoomBrief = {
  roomSummary: string;
  camera: string;
  landmarks: RoomBriefLandmark[];
  walls: Array<{ name: string; description: string; usableForLargeFurniture: boolean; partlyVisible: boolean }>;
  zones: Array<{ name: string; description: string }>;
  kitchenVisible: boolean;
  fridgeSpace?: { present: boolean; description?: string };
  // How much dining furniture the visible floor really takes; "none" lets a
  // tight kitchen/dining shot go without a table instead of the image model
  // reshaping the room to make one fit.
  diningSpace?: { fits: "full" | "small" | "none"; reason?: string };
  // Same idea for bedrooms: the largest bed and the number of bedside
  // tables the visible floor really takes.
  bedSpace?: { bed: "king" | "queen" | "double" | "single"; bedsideTables: 0 | 1 | 2; wallMetres?: number; depthMetres?: number; wallRunsOffPhoto?: boolean; measuredWith?: string; reason?: string };
  layout: Array<{ item: string; placement: string }>;
  relationships: string[];
  avoid: string[];
  keepUntouched: string[];
  // Set in code (never by the model) when the photo shows very little floor.
  tightShot?: { floorPct: number };
};

export type RoomBriefUsage = { model: string; inputTokens: number; outputTokens: number; thinkingTokens: number; latencyMs: number };

export type RoomBriefResult =
  | { ok: true; brief: RoomBrief; issues: string[]; usage: RoomBriefUsage[] }
  | { ok: false; reason: string; issues: string[]; brief?: RoomBrief; usage: RoomBriefUsage[] };

const ROOM_LABELS: Record<string, string> = {
  bedroom: "bedroom",
  living_room: "living room",
  living: "living room",
  dining_room: "dining room",
  dining: "dining room",
  kitchen: "kitchen",
  kitchen_dining: "open-plan kitchen and dining room",
  kitchen_living: "open-plan kitchen and living room",
  living_dining: "open-plan living and dining room",
  kitchen_living_dining: "open-plan kitchen, living and dining room",
  study: "study",
  office: "home office",
};

export function roomLabelFor(roomType: string): string {
  const key = String(roomType || "").toLowerCase().replace(/-/g, "_").trim();
  if (ROOM_LABELS[key]) return ROOM_LABELS[key];
  if (/^bedroom/.test(key)) return "bedroom";
  if (/^bathroom/.test(key)) return "bathroom";
  return key ? key.replace(/_/g, " ") : "room";
}

// What a well-staged room of each type contains and how it is arranged.
function roomTypeGuidance(roomType: string): string {
  const key = String(roomType || "").toLowerCase().replace(/-/g, "_");
  const living = `LIVING AREA: a sofa (and an armchair if there is room), a coffee table and a rug, arranged as one conversation group. If the room has a TV wall bracket, the TV is mounted ON that bracket and the seating faces it; a low TV unit may sit on the floor below it. Without a bracket, put a TV unit flat against a solid, clearly visible wall opposite the seating, parallel to it — or, if no wall suits a TV, face the seating toward the window or fireplace and add no TV. Never stand a TV unit against a wall the photo doesn't show (for example a side wall imagined just past the photo edge). A visible wall that carries on past the photo edge is fine — the TV unit just stands on its visible part. If no visible wall suits a TV, leave the TV out. Never mount a TV on a wall with a window; on such a wall a TV may only stand on a low unit, below the window sill, never in front of the glass.
SOFA PLACEMENT, in this order: (1) its back against a plain solid wall with no door, doorway or sliding door along that stretch, facing the TV or focal point; (2) in an open-plan room only, a free-standing sofa may divide the living area from the dining area, with its back at least one door-width (about 0.8 m) from any walking path; (3) never in front of, across or touching a door, a doorway, the opening side of a sliding door, or the walking path between two doors. A piece may stand in front of a fixed glass panel beside a sliding door's opening. A sofa may sit in front of a window with its back overlapping the bottom of the glass, as long as most of the window stays visible.
DOOR SWING AND PATHS: every door must still be able to close and every doorway and sliding door stays walkable. The open door leaf, its frame, the floor it sweeps, the opening side of every sliding door, and a clear path about one door-width wide between the doors and to the kitchen stay completely clear — no sofa, armchair, coffee table, TV unit or rug edge may block them. Keep a TV unit at least one door-width from any door frame.
MEASURE WITH THE DOOR AS A RULER: a standard door is about 0.8 m wide. A 3-seater sofa is about 2.75 door-widths long, a 2-seater about 2, an armchair about 1; the coffee table needs about half a door-width of space in front of the sofa. Photos make walls look longer than they are; when space is at all tight use a 2-seater and leave out the armchair.
WHEN THE SOFA WALL IS SHORT OR ENDS AT A DOOR: never centre the sofa on it. Push it to the far end, away from the door — against the corner or out to the edge of the photo, letting the photo edge cut off part of it (a foreground sofa partly cut off by the photo edge looks natural).
In "placement", always say what the sofa's back is against (or that it is free-standing between the areas) and where it sits relative to the nearest door (for example "back against the plain left wall, leaving a clear path to the sliding door on its right").`;
  const dining = `DINING AREA: a dining table with 4–6 chairs, freestanding with room to pull the chairs out — never pushed flat against a wall. Only when a ceiling light fitting is clearly visible in the dining area itself (and listed in "landmarks") may the placement say the table is centred under that light, naming it. Otherwise never mention lights, pendants or light fittings for the dining table — describe its position by the walls, windows, kitchen bench and walkways instead (a mention of a light makes the image AI invent one).
DINING CLEARANCE: leave about one door-width (0.8 m) of clear floor on every side of the table so the chairs can be pulled out. The table and chairs never stand in a door's swing, across a sliding door's path, in a doorway, or on the walking line between two doorways or between the entrance and the kitchen.
MEASURE WITH THE DOOR AS A RULER: a standard door is about 0.8 m wide. A 4-seat table is about 1.5–1.75 door-widths long, a 6-seat table about 2.25; with chairs pulled out the set needs roughly 2 door-widths more in each direction. When space is at all tight, use a round 4-seat table, then a round bistro table for two.
A table in the foreground may be partly cut off by the edge of the photo. In "placement", say where the table sits relative to the nearest door or walkway (for example "in front of the kitchen bench, clear of the doorway on the left").
DINING SPACE CHECK: first judge the open floor you can actually see. If a 4-seat table with chairs pulled out AND a clear walking path will not fit there, plan a small table for two (a round bistro table) instead. If even that would block a walkway, a door, the stairs or the kitchen's working area, plan NO dining table. Record your decision in "diningSpace".`;
  const kitchenOnly = `KITCHEN: do not add large furniture. Bar stools only where an island or peninsula has an overhang for seating; a few small items on the benches (a bowl of fruit, a plant, a chopping board) are enough.`;
  const openPlan = `OPEN-PLAN RULES: each area keeps its own furniture. The dining table goes in the area nearest the kitchen (in front of or beside the kitchen bench/island) — never inside the living area, never in front of the sofa, and never between the sofa and the TV. The living area is the part of the room furthest from the kitchen, around the TV bracket or focal wall. The back of the sofa may face the dining area to separate the two areas. Keep a clear walking path from the entrance to the kitchen.`;
  if (key === "kitchen_living_dining") return [living, dining, kitchenOnly, openPlan].join("\n");
  if (key === "kitchen_dining") return [dining, kitchenOnly, `The dining table sits next to the kitchen (in front of or beside the bench/island) without blocking the kitchen's working area, with a clear path into the kitchen.`].join("\n");
  if (key === "kitchen_living") return [living, kitchenOnly, `The living furniture stays out of the kitchen's working area.`].join("\n");
  if (key === "living_dining") return [living, dining, openPlan].join("\n");
  if (key === "dining_room" || key === "dining") return [dining, `Do not add a sofa, armchair, coffee table or TV — this is a dining room only. A sideboard against a solid, clearly visible wall is optional if there is room.`].join("\n");
  if (key === "living_room" || key === "living") return living;
  if (key === "kitchen") return kitchenOnly;
  if (key.startsWith("bedroom")) {
    return `BEDROOM: a bed with its headboard against a solid, clearly visible wall — not across a window or in front of a door or wardrobe — with a bedside table and lamp beside it.
BED WALL CHOICE, in this order: (1) a plain wall with no door, doorway, wardrobe door or window anywhere along it; (2) only if there is no such wall, a wall with a window — the headboard and pillows may overlap the bottom of the glass, but most of the window stays visible and nothing hangs above the headboard; (3) never a wall with a door, doorway or wardrobe door on it, even beside the bed. Mark walls with a door, doorway or wardrobe door as "usableForLargeFurniture": false. Only if every visible wall has a door, doorway or wardrobe door, use the one with the longest plain stretch, with the whole bed and its bedside tables on that plain stretch, well clear of the door and its swing.
DOOR SWING: every door must still be able to close. The open door leaf, its frame and the floor it sweeps when it closes stay completely clear — no bed, headboard, bedside table or lamp may touch, overlap or stand in front of them, even partly. Measure the plain wall available for the bed from the photo edge or room corner up to the door frame, minus the door's swing. If the bed with two bedside tables does not fit there, do this, in order, until it fits: (1) keep only the bedside table on the side away from the door; (2) choose a smaller bed; (3) slide the bed further away from the door, letting the edge of the photo cut off its far side or foot. Never let any part of the bed, headboard or bedside tables reach the door.
MEASURE WITH THE DOOR AS A RULER: a standard door is about 0.8 m wide and 2 m tall. Photos make walls look longer than they are, so measure the plain stretch in door-widths before choosing: a queen bed with two bedside tables needs about 3.5 door-widths of plain wall (2.8 m), a queen with one table about 2.8, a double with one table about 2.4, a single with one table about 1.6 — plus one more door-width of clear wall between the setup and any door frame on the same wall. If unsure, go one size smaller.
CHECK THE DEPTH TOO, NOT JUST THE WALL: the bed sticks out from the headboard wall about 2.6 door-widths (2.1 m) for a queen or double, 2.4 for a single, and still needs about one door-width (0.8 m) of clear floor beyond its foot to walk past. Measure the visible floor from the chosen wall to the opposite wall, cupboard or photo edge in that direction. If it is not clearly deep enough, that wall is wrong for the bed even when it is the plain one: in a narrow room, turn the bed so it runs along the room's LONGEST direction, with the headboard against a shorter end wall — even one with a window (low headboard below the sill) — rather than across the narrow width. A bed that fits beats the plain-wall preference. Never plan furniture that only fits if the walls, skirting or floor are moved.
FURNITURE NEEDS VISIBLE FLOOR UNDER IT: follow the headboard wall's skirting line. Where it runs off the bottom or side edge of the photo, the wall beyond that point has no visible floor in front of it — nothing can stand there (this is where a bedside table usually gets wrongly placed). The usable wall is only the stretch whose skirting AND the floor in front of it are both visible. Fit the bed and tables on that stretch, pushed toward the far corner, using one or no bedside table, and let the photo edge cut off the foot or near side of the bed if needed. If even that is too short, put the headboard against another wall (even a window wall, with a low headboard below the sill).
NEVER CHANGE THE ROOM TO FIT THE FURNITURE: skirting lines, wall corners and the floor edge stay exactly where they are. If the furniture does not fit, use less or smaller furniture, or let the photo edge cut it off.
SINGLE BEDS ARE NORMAL: many bedrooms, especially in older New Zealand houses, realistically take only a single bed. When a double would leave no clear walkway along at least one long side, or would need the bed pushed hard against two walls, plan a single bed (one bedside table or none), typically along the longest plain wall.
BE CONSERVATIVE, NOT OPTIMISTIC: an under-furnished bedroom looks fine; a crowded one, or one with a blocked door, is a failure. Plan TWO bedside tables only when the plain wall is clearly long enough for them with room to spare. When space is at all tight, plan ONE bedside table (on the side away from any door), and NONE if even one would crowd a door, wardrobe or window. Choose the smaller bed whenever in doubt.
WHEN THE BED WALL ENDS AT A DOOR: never centre the bed on that wall. Push the whole setup to the far end, away from the door — against the room corner or out to the edge of the photo, letting the photo edge cut off the far bedside table or the side of the bed — and describe it that way in "layout" (for example "pushed to the far left end of the left wall, partly cut off by the left edge of the photo, leaving a clear gap before the door").
BED SPACE CHECK: first judge the open floor you can actually see, and record your measurements in "bedSpace" (wallMetres, depthMetres, measuredWith) — they are checked. Measure the headboard wall by its VISIBLE length only — if it runs off the edge of the photo, the hidden part does not count, so a bed and bedside tables must fit within what is shown (they may run slightly past the photo edge, but never need more room than the visible wall). Choose the largest bed that still leaves a clear walkway along at least one long side and past the foot of the bed, and lets the door and wardrobe open fully: king, else queen, else double, else single. Then bedside tables: one on each side if both sides have room, one if only one side does, none if neither (never squeeze one in front of a door, wardrobe or window). Name the bed size in the layout item (for example "Double bed"). Record your decision in "bedSpace".
Optionally a dresser, a chair or a bench at the end of the bed, only if there is still clear floor after all of the above. Keep the paths to the door and the wardrobe clear.`;
  }
  if (key === "study" || key === "office") {
    return `STUDY: a desk and desk chair, with the desk's back flat against a wall. Add a bookshelf or a small armchair only if there is clearly room to spare.
DESK WALL CHOICE, in this order: (1) a plain solid wall with no door, doorway or wardrobe door anywhere along it; (2) under a window on a wall with no door — the desk may overlap the bottom of the glass, as long as most of the window stays visible; (3) never against a wall with a door or doorway on it, even beside the desk, and never free-standing in the middle of the room or "in front of" a window away from the wall. In "placement", name the exact wall the desk stands against (for example "against the plain right wall of the alcove") — never "centred in the room" or "in front of the window".
DOOR SWING: every door must still be able to close and every doorway stays walkable. The open door leaf, its frame, the floor it sweeps and the path straight through a doorway stay completely clear — no desk, chair (even pulled out), bookshelf, armchair or lamp may touch, overlap or stand in front of them, even partly. Keep at least one door-width of clear wall between the desk setup and any door frame.
MEASURE WITH THE DOOR AS A RULER: a standard door is about 0.8 m wide. A standard desk (1.2 m) needs about 1.5 door-widths of plain wall, a compact writing desk (0.9 m) about 1.1, and the chair needs about one door-width of clear floor behind the desk. Photos make walls look longer than they are; if unsure, choose the compact desk and leave out the bookshelf and armchair.
WHEN THE DESK WALL IS SHORT OR ENDS AT A DOOR: never centre the desk on it. Push the desk to the far end, away from the door — against the corner or out to the edge of the photo, letting the photo edge cut off part of the desk — and describe it that way in "layout".`;
  }
  if (key.startsWith("bathroom")) return `BATHROOM: add no furniture — the "layout" stays empty. Styling is limited to small touches (towels, a bath mat, a soap dispenser, a small plant), which are handled separately.`;
  if (key === "laundry") return `LAUNDRY: add no furniture or appliances — the "layout" stays empty. Styling is limited to small touches (a laundry basket, folded towels, a plant), which are handled separately.`;
  if (key === "pantry" || key === "closet") return `${key === "pantry" ? "PANTRY" : "CLOSET"}: add no furniture — the "layout" stays empty. Styling is limited to a few neat items on the existing shelves, which are handled separately.`;
  if (key === "garage") return `GARAGE: show it clean and empty — the "layout" stays empty. Do not add cars, furniture, shelving or tools.`;
  if (key === "staircase") return `STAIRCASE: add no furniture on or around the stairs — the "layout" stays empty unless a landing has clear floor away from every step, where one small plant stand or bench may go.`;
  if (key === "hallway" || key === "entryway") return `${key === "hallway" ? "HALLWAY" : "ENTRYWAY"}: at most one slim console table or bench against a solid, clearly visible wall, and only if the walkway stays wide and every door can open fully. Otherwise the "layout" stays empty.`;
  if (key === "sunroom") return `SUNROOM: relaxed seating facing the windows or the view — a small sofa or two armchairs, a coffee or side table and a rug, with plants. Keep the doors and walkway clear.`;
  if (key === "basement") return `BASEMENT: furnish it as a family or rumpus room — a sofa, a coffee table and a rug, plus a TV unit against a solid, clearly visible wall if one suits. Keep the stairs and doors clear.`;
  if (key === "attic") return `ATTIC: furnish it as a quiet retreat sized to the headroom — a reading nook (armchair, side table, floor lamp, rug), or a single or double bed only where the ceiling is high enough to stand beside it. Keep the stairs or hatch clear.`;
  return `Furnish the room for its purpose with a small number of correctly scaled pieces.`;
}

const LANDMARK_TYPES =
  "window | door | sliding_door | doorway | closet_door | curtain | blind | tv_bracket | fireplace | heat_pump | light_fitting | switch_or_outlet | kitchen_bench | kitchen_island | kitchen_cabinetry | appliance | built_in_wardrobe | stairs | radiator | other_fixture";

export function buildRoomBriefInstruction(roomType: string, styleDescription?: string): string {
  return `You are an experienced real-estate stager planning the virtual staging of the empty room in this photo, a ${roomLabelFor(roomType)}. An image-editing AI will add the furniture to this same photo. It cannot read coordinates; it follows plain descriptions of places it can see in the photo. Your job is to look carefully at the room and write the staging plan in that language.

1. Understand the room: where the camera stands and what it looks at, each visible wall, and every landmark — windows, doors, sliding doors, doorways, curtains, heat pumps, light fittings, switches and outlets, TV wall brackets, fireplaces, kitchen benches, islands and cabinetry, built-in wardrobes, stairs.
2. Decide where each area of the room is (for example living, dining, kitchen, sleeping) and describe it by its landmarks.
3. Plan the furniture for this room type:
${roomTypeGuidance(roomType)}
${styleDescription ? `Style: ${styleDescription}.\n` : ""}
Rules — these always apply:
- Use only the floor and the walls that are clearly visible in the photo. A wall cut off at the edge of the photo may only be used for the part that is visible; never place anything that needs more wall than the photo shows, and never invent, extend or move a wall.
- Every TV must hang on, or stand against, a wall that is clearly visible. If there is a TV wall bracket, the TV goes on that bracket and nowhere else.
- Keep every door, sliding door and doorway clear, with a walking path between them. Furniture may stand in front of the lower part of a window (a sofa back, headboard, desk or low unit overlapping the bottom of the glass is fine), but never hide most of a window, and never paint, wall or board over a window. Do not cover the heat pump, switches, outlets, the fireplace or any other fixed feature.
- Wall art only on plain wall: never above a door, doorway or wardrobe door, never over or above a window, and never above a headboard that stands below a window.
- Describe every position with words about visible landmarks and the room ("at the back of the room, in front of the kitchen bench", "against the plain wall on the left, between the sliding door and the window"). Never use coordinates, pixels, percentages or wall numbers in "layout", "relationships", "avoid" or "keepUntouched".
- Write each placement so that someone looking at the same photo can find the exact spot. Only refer to features you listed in "landmarks".
- Name every wall by where it is in the photo AND what is on it — never by a direction alone. Good: "the wall straight ahead with the high strip window", "the wall on the right of the photo with the large picture window", "the short wall at the left edge of the photo, next to the entry". Never write just "the left wall", "the right wall", "the far wall" or "the back wall": in a photo taken from a corner those are ambiguous, and the furniture ends up on the wrong wall. In "layout", "relationships" and "avoid", refer to walls using exactly the names you gave them in "walls".
- Write "camera" as a full sentence starting "The camera…", and each "avoid" entry as a full sentence starting "Do not…".
- Plan only the main furniture in "layout" (up to about 8 items, fewer in a small or tight space, and none where the room type above says the layout stays empty). Small decor is handled separately.
- Every piece must fit in the floor space the photo really shows. Never plan furniture that would only fit if the room were bigger or the camera were moved. A wall that runs off the edge of the photo counts only for its visible length.
- When in doubt between two sizes, choose the smaller one — a slightly small piece looks natural; a piece that is too big forces the room to change.

Return ONLY a JSON object:
{
  "roomSummary": string,          // 1–2 sentences: what the room is and how it is laid out
  "camera": string,               // where the camera stands and what it looks toward
  "landmarks": [ { "id": "L1", "type": ${LANDMARK_TYPES}, "description": string, "box_2d": [ymin, xmin, ymax, xmax] } ],
                                  // description says what it is and where ("black TV wall bracket on the wall on the right of the photo"); box_2d = rough bounding box, top/left/bottom/right on a 0–1000 scale
  "walls": [ { "name": string, "description": string, "usableForLargeFurniture": boolean, "partlyVisible": boolean } ],   // name = where it is in the photo + what is on it ("the wall straight ahead with the high strip window")
  "zones": [ { "name": string, "description": string } ],
  "kitchenVisible": boolean,
  "fridgeSpace": { "present": boolean, "description": string },   // true only for an empty cavity clearly built for a fridge
  "diningSpace": { "fits": "full" | "small" | "none", "reason": string },   // only for room types with a dining area
  "bedSpace": { "bed": "king" | "queen" | "double" | "single", "bedsideTables": 0 | 1 | 2, "wallMetres": number, "depthMetres": number, "wallRunsOffPhoto": boolean, "measuredWith": string, "reason": string },   // only for bedrooms. wallRunsOffPhoto = true when the headboard wall's skirting runs off the bottom or side edge of the photo; wallMetres = the plain stretch of the headboard wall whose skirting AND the floor in front of it are both visible (stop where the skirting runs off the photo edge); depthMetres = the visible floor from the headboard wall straight out to the opposite wall, cupboard or photo edge; measuredWith = the reference you measured against (a door ~0.8 m wide, a window, a power socket, the skirting, floor boards)
  "layout": [ { "item": string, "placement": string } ],          // e.g. { "item": "TV", "placement": "mounted on the black TV wall bracket on the white wall on the right, covering the bracket" }
  "relationships": [ string ],    // how the areas and pieces relate, e.g. "The dining table stays at the back near the kitchen, never between the sofa and the TV."
  "avoid": [ string ],            // specific placements to avoid in THIS room
  "keepUntouched": [ string ]     // each fixed feature of THIS room that must stay exactly as it is, described by position
}`;
}

// Room types whose guidance allows (or requires) no large furniture.
export function roomAllowsEmptyLayout(roomType: string): boolean {
  const key = String(roomType || "").toLowerCase().replace(/-/g, "_");
  return key === "kitchen" || key.startsWith("bathroom") || ["laundry", "pantry", "closet", "garage", "staircase", "hallway", "entryway"].includes(key);
}

// Small finishing touches that suit each kind of room.
function finishingTouchesFor(roomType: string): string {
  const key = String(roomType || "").toLowerCase().replace(/-/g, "_");
  const art = `artwork on plain wall areas (never over windows, doors, switches or other features)`;
  if (key.startsWith("bathroom")) return `neatly folded towels on the existing rails or vanity, a bath mat, a soap dispenser and a small plant`;
  if (key === "kitchen" || key === "laundry") return `a few items on the benches (a bowl of fruit, a plant, a chopping board${key === "laundry" ? ", a laundry basket, folded towels" : ""})`;
  if (key === "pantry" || key === "closet") return key === "pantry" ? `neat jars and baskets on the existing shelves` : `a few clothes on hangers and folded items or baskets on the existing shelves`;
  if (key === "garage") return `nothing — leave the garage clean and empty`;
  if (key === "staircase" || key === "hallway" || key === "entryway") return `a runner rug where the floor is clear, a plant, and ${art}`;
  return `a rug under the seating, bed or dining table, a floor or table lamp, cushions and a throw, a plant, books and small decor on surfaces, and ${art}`;
}

function hasCoordinates(text: string): boolean {
  return /\[\s*0?\.\d|\b0\.\d{2,}\b|\d+\s*%|\bpixel|\bwall_\d|\bx\s*=|\by\s*=/i.test(text);
}

// A wall named by direction alone ("the left wall") is ambiguous in a photo
// taken from a corner: Oct 2026, job_56b49ee9 called the wall straight ahead
// (with the high strip window) "the left wall", and a re-stage put the bed
// against the real left wall at the photo's edge, across the entry.
const BARE_WALL = /\b(?:left|right|far|back|rear|front|side|near|end|opposite|main|long|short)(?:[- ]hand)?\s+wall\b/i;
const BARE_WALL_NAME = /^\s*(?:the\s+)?(?:(?:left|right|far|back|rear|front|side|near|end|opposite|main|long|short)(?:[- ]hand)?\s+)+wall\s*$/i;

/** Walls named by direction alone, in "walls" or in the placement text. */
export function checkWallNames(brief: RoomBrief): string[] {
  const issues: string[] = [];
  const names = (brief.walls || []).map((w) => String(w?.name || "").trim()).filter(Boolean);
  const bare = names.filter((n) => BARE_WALL_NAME.test(n));
  if (bare.length) issues.push(`name each wall by where it is in the photo and what is on it, not by direction alone (${bare.map((n) => `"${n}"`).join(", ")}) — for example "the wall straight ahead with the high strip window"`);
  let text = [...(brief.layout || []).map((l) => String(l?.placement || "")), ...(brief.relationships || []), ...(brief.avoid || [])].join(" \n ");
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    if (!BARE_WALL_NAME.test(n)) text = text.split(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")).join(" ");
  }
  const m = text.match(BARE_WALL);
  if (!bare.length && m) issues.push(`refer to walls by the names given in "walls", not by direction alone ("${m[0]}")`);
  return issues;
}

/** Landmark boxes: Gemini's native box_2d [ymin, xmin, ymax, xmax] on 0–1000 becomes box [x1, y1, x2, y2] on 0–1. */
export function normaliseLandmarkBoxes(brief: any): void {
  for (const l of Array.isArray(brief?.landmarks) ? brief.landmarks : []) {
    const b = Array.isArray(l?.box_2d) && l.box_2d.length === 4 ? l.box_2d.map(Number) : null;
    if (b && b.every((n: number) => Number.isFinite(n))) {
      const scale = Math.max(...b) > 1.5 ? 1000 : 1;
      const [y1, x1, y2, x2] = b.map((n: number) => Math.min(1, Math.max(0, n / scale)));
      l.box = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
      delete l.box_2d;
    }
  }
}

/** Checks the brief against the rules the code must guarantee. */
/** Space a bed set-up needs, in metres: bed length out from the wall, and wall width with its bedside tables. */
const BED_LENGTH_M: Record<string, number> = { king: 2.1, queen: 2.1, double: 2.0, single: 1.95 };
const BED_WIDTH_M: Record<string, number> = { king: 1.85, queen: 1.55, double: 1.4, single: 0.95 };
const BEDSIDE_TABLE_M = 0.5;
const WALKWAY_M = 0.7;

/**
 * Does the planned bed fit the planner's own measurements? The planner keeps
 * picking the plain wall and calling the room "ample" without checking how
 * far the bed sticks out (Oct 2026, client Image 02: a queen across a narrow
 * room — Gemini then pulled the skirting out at an angle to make it fit).
 * Asking for numbers and checking them in code catches that.
 */
export function checkBedFits(brief: RoomBrief): string[] {
  const bs: any = (brief as any).bedSpace;
  if (!bs) return ["record the bed decision in \"bedSpace\", including wallMetres, depthMetres and measuredWith"];
  const size = String(bs.bed || "").toLowerCase();
  const wall = Number(bs.wallMetres), depth = Number(bs.depthMetres);
  if (!BED_LENGTH_M[size]) return [];
  if (!(wall > 0) || !(depth > 0)) return ["bedSpace needs your measured wallMetres and depthMetres (measure against a door, window or other reference)"];
  const issues: string[] = [];
  const needDepth = BED_LENGTH_M[size] + WALKWAY_M;
  if (depth < needDepth) {
    issues.push(`by your own measurement the room is only ${depth} m deep from the headboard wall, but a ${size} bed sticks out ${BED_LENGTH_M[size]} m and needs ${WALKWAY_M} m to walk past its foot (${needDepth.toFixed(1)} m). Turn the bed so it runs along the room's longest direction (headboard against a shorter end wall — even a window wall, with a low headboard below the sill), or choose a smaller bed. Never plan furniture that only fits if a wall, skirting or the floor is moved`);
  }
  const tables = Math.max(0, Math.min(2, Number(bs.bedsideTables) || 0));
  const needWall = BED_WIDTH_M[size] + tables * BEDSIDE_TABLE_M;
  if (wall < needWall) {
    issues.push(`by your own measurement the plain headboard wall is only ${wall} m, but a ${size} bed with ${tables} bedside table(s) needs ${needWall.toFixed(1)} m — use fewer bedside tables, a smaller bed, another wall, or let the photo edge cut the set-up off`);
  }
  return issues;
}

export function checkRoomBrief(brief: RoomBrief, roomType: string): string[] {
  const issues: string[] = [];
  const key = String(roomType || "").toLowerCase().replace(/-/g, "_");
  const noDiningRoom = brief.diningSpace?.fits === "none" && /dining/.test(key);
  if (!Array.isArray(brief.layout)) {
    issues.push("layout is missing — plan the main furniture");
    return issues;
  }
  if (brief.layout.length === 0) {
    // Rooms that take no furniture, and a kitchen/dining shot too tight for
    // a table, may legitimately have an empty layout.
    if (!(roomAllowsEmptyLayout(key) || (noDiningRoom && /kitchen/.test(key)))) issues.push("layout is empty — plan the main furniture");
    return issues;
  }
  for (const l of brief.layout) {
    if (!l || typeof l.item !== "string" || typeof l.placement !== "string" || l.placement.trim().length < 12) {
      issues.push("every layout entry needs an item and a full placement description");
      break;
    }
  }
  const allText = [...brief.layout.map((l) => l.placement), ...(brief.relationships || []), ...(brief.avoid || [])].join(" \n ");
  if (hasCoordinates(allText)) issues.push("positions must be described with landmarks only — remove coordinates, percentages, pixels and wall numbers");

  const bracket = (brief.landmarks || []).find((l) => l?.type === "tv_bracket" || /\b(tv|television)\b.*\bbracket\b|\bbracket\b.*\b(tv|television)\b/i.test(String(l?.description || "")));
  const tvItems = brief.layout.filter((l) => /\b(tv|television)\b/i.test(l.item) && !/\b(unit|console|cabinet|stand)\b/i.test(l.item));
  if (bracket && tvItems.length === 0) issues.push("the room has a TV wall bracket — the layout must mount a TV on it");
  if (bracket && tvItems.length > 0 && !tvItems.some((t) => /bracket/i.test(t.placement))) {
    issues.push("the TV must be mounted on the existing TV wall bracket — say so in its placement");
  }

  if (key.startsWith("bedroom") && !brief.layout.some((l) => /\bbed\b/i.test(l.item))) issues.push("a bedroom needs a bed in the layout — choose the largest size that fits");
  const expectsDining = /dining/.test(key) && !noDiningRoom;
  const dining = brief.layout.find((l) => /\bdining\b|\btable\b/i.test(l.item) && !/\b(coffee|side|bedside|console)\b/i.test(l.item));
  if (expectsDining && !dining) issues.push("this room type needs a dining table in the layout");
  if (expectsDining && dining && brief.kitchenVisible && !/kitchen|bench|island|counter|peninsula/i.test(dining.placement)) {
    issues.push("a kitchen is visible — describe the dining table's position next to the kitchen (bench, island or counter)");
  }
  return issues;
}

async function loadImageForBrief(imagePath: string): Promise<{ data: string; mime: string }> {
  const buf = await sharp(fs.readFileSync(imagePath))
    .rotate()
    .resize(ROOM_BRIEF_MAX_SIDE, ROOM_BRIEF_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { data: buf.toString("base64"), mime: "image/jpeg" };
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
}

async function callBriefModel(image: { data: string; mime: string }, instruction: string, model: string): Promise<{ text: string; usage: RoomBriefUsage }> {
  const ai: any = getGeminiClient();
  const started = Date.now();
  const call = ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: instruction }, { inlineData: { mimeType: image.mime, data: image.data } }] }],
    // The token limit counts the model's hidden thinking too. Uncapped, a run
    // can think for ~8k tokens and cut the plan off mid-JSON (Oct 2026,
    // production: 7,860 thinking + 325 answer, both tries, 2 minutes lost and
    // the room plan dropped). Normal runs think 200-2,600 tokens. The budget
    // is a soft limit for this model (production: up to 5,715 with a 2,048
    // budget), so the overall limit leaves room for the answer too; only the
    // tokens actually used are billed.
    config: { temperature: 0.2, maxOutputTokens: 16384, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: ROOM_BRIEF_THINKING_BUDGET } },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`room brief timed out after ${ROOM_BRIEF_TIMEOUT_MS}ms`)), ROOM_BRIEF_TIMEOUT_MS);
  });
  let resp: any;
  try {
    resp = await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const parts: any[] = resp?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p: any) => typeof p?.text === "string" && !p?.thought).map((p: any) => p.text).join("");
  const um = resp?.usageMetadata || {};
  return {
    text,
    usage: {
      model,
      inputTokens: Number(um.promptTokenCount || 0),
      outputTokens: Number(um.candidatesTokenCount || 0),
      thinkingTokens: Number(um.thoughtsTokenCount || 0),
      latencyMs: Date.now() - started,
    },
  };
}

/**
 * After the code cuts the bed set-up to one bedside table, make the rest of
 * the plan agree: one lamp, and no "both bedside tables" or "centred" left in
 * the zones and relationships (live test, Oct 2026: a leftover "lamp on the
 * near bedside table" brought the dropped table back).
 */
function tidyToOneBedsideTable(brief: any): any {
  const isLamp = (it: any) => /lamp/i.test(String(it?.item || "")) && !/floor lamp|pendant|bedside|night ?stand|side table/i.test(String(it?.item || ""));
  const nearish = /\bnear\b|foreground|toward(s)? the camera|door|each|both/i;
  const lamps = (brief.layout || []).filter(isLamp);
  const keepLamp = lamps.find((it: any) => !nearish.test(String(it?.placement || ""))) || lamps[0];
  const layout = (brief.layout || [])
    .filter((it: any) => !isLamp(it) || it === keepLamp)
    .map((it: any) => (it === keepLamp ? { ...it, item: "Table lamp", placement: "on the bedside table" } : it));
  const fix = (t: string) => String(t || "")
    .replace(/\b(both|two|the two|a pair of|pair of|each of the|matching) bedside tables\b/gi, "the single bedside table")
    .replace(/\bbedside tables\b/gi, "bedside table")
    .replace(/\bflanked by\b/gi, "beside")
    .replace(/\bcente?red\b/gi, "placed");
  return {
    ...brief,
    layout,
    relationships: Array.isArray(brief.relationships) ? brief.relationships.map(fix) : brief.relationships,
    zones: Array.isArray(brief.zones) ? brief.zones.map((z: any) => ({ ...z, description: fix(z?.description) })) : brief.zones,
  };
}

/**
 * Conservative bed plan (code, not AI judgement). The planner keeps judging
 * walls longer than they are (Oct 2026, production: "ample room for a queen
 * and two bedside tables" beside an open door, three runs out of three). When
 * a bedroom plan mentions a door near the bed setup: at most ONE bedside table
 * (the one on the door side goes), and the bed is pushed to the end of the
 * wall away from the door, letting the photo edge cut it off.
 */
export function makeBedPlanConservative(brief: RoomBrief, roomType: string): { brief: RoomBrief; changed: string[] } {
  const changed: string[] = [];
  if (!/bed/i.test(String(roomType || "")) || !Array.isArray(brief?.layout)) return { brief, changed };
  const isBed = (it: any) => /\bbed\b/i.test(String(it?.item || "")) && !/bedside|side table|bed end|bench/i.test(String(it?.item || ""));
  const isTable = (it: any) => /bedside|night ?stand|side table/i.test(String(it?.item || ""));
  const bedSetupText = [
    ...brief.layout.filter((it: any) => isBed(it) || isTable(it)).map((it: any) => String(it?.placement || "")),
    String((brief as any).bedSpace?.reason || ""),
  ].join(" ");
  if (!brief.layout.some(isBed)) return { brief, changed };
  const nearDoor = /door/i.test(bedSetupText);
  const offPhoto = !nearDoor && (brief as any).bedSpace?.wallRunsOffPhoto === true;
  if (!nearDoor && !offPhoto) return { brief, changed };
  // "Bedside tables (set of 2)" as ONE layout entry (production, client
  // Image 02): turn it into a single table on the safe side, and its lamps
  // into one lamp.
  const pluralTables = /tables|set of (2|two)|pair|\btwo\b|each side|both sides|flanking|either side/i;
  const safeSide = offPhoto ? "on the far side of the bed, toward the far corner" : "on the side of the bed away from the door";
  brief = {
    ...brief,
    layout: brief.layout.map((it: any) => {
      const t = `${String(it?.item || "")} ${String(it?.placement || "")}`;
      if (isTable(it) && pluralTables.test(t)) {
        changed.push(`one bedside table instead of "${String(it.item || "").slice(0, 60)}"`);
        return { ...it, item: "Bedside table", placement: `a single bedside table against the same wall ${safeSide}` };
      }
      if (/lamp/i.test(String(it?.item || "")) && /lamps|set of (2|two)|pair|\btwo\b|each/i.test(t)) {
        return { ...it, item: "Table lamp", placement: "on the bedside table" };
      }
      return it;
    }),
  };
  // Bed wall running off the photo edge (Oct 2026, client Image 02): a
  // centred set-up puts the near bedside table past where the skirting leaves
  // the photo, with no floor to stand on, and Gemini paints floor over the
  // wall to make it fit. Same cure as a door: drop the near table and push
  // the bed into the far corner.
  if (offPhoto) {
    const tables = brief.layout.filter(isTable);
    let layout = brief.layout;
    if (tables.length > 1) {
      const text = (it: any) => `${String(it?.item || "")} ${String(it?.placement || "")}`;
      const nearWords = /foreground|toward(s)? the camera|closest to the (camera|viewer)|\bnear (side|end)\b|\bnear bedside\b|\bfront\b/i;
      const farWords = /\bfar\b|back corner|toward(s)? the window|\bback wall\b/i;
      const near = tables.find((it: any) => nearWords.test(text(it)) && !farWords.test(text(it)))
        || tables.find((it: any) => !farWords.test(text(it)))
        || tables[tables.length - 1];
      layout = layout.filter((it: any) => it !== near);
      changed.push(`dropped the near bedside table "${String(near?.placement || "").slice(0, 80)}"`);
    }
    layout = layout.map((it: any) => {
      if (!isBed(it)) return it;
      changed.push("bed pushed into the far corner (wall runs off the photo)");
      return {
        ...it,
        placement: `${String(it.placement || "").replace(/\bcente?red\b/gi, "placed").replace(/\.\s*$/, "")} — pushed toward the far corner of that wall, with its single bedside table on the far side; nothing stands beyond the point where the wall's skirting runs off the photo edge, and the photo edge may cut off the near side or foot of the bed; it must not be centred on the wall`,
      };
    });
    const out: any = tidyToOneBedsideTable({ ...brief, layout });
    if (Number((brief as any).bedSpace?.bedsideTables) > 1) out.bedSpace = { ...(brief as any).bedSpace, bedsideTables: 1 };
    return { brief: out, changed };
  }
  const tables = brief.layout.filter(isTable);
  let layout = brief.layout;
  if (tables.length > 1) {
    const doorSide = tables.find((it: any) => /door/i.test(String(it?.placement || ""))) || tables[tables.length - 1];
    layout = layout.filter((it: any) => it !== doorSide);
    changed.push(`dropped the bedside table "${String(doorSide?.placement || "").slice(0, 80)}"`);
  }
  layout = layout.map((it: any) => {
    if (!isBed(it)) return it;
    changed.push("bed pushed away from the door");
    return {
      ...it,
      placement: `${String(it.placement || "").replace(/\bcente?red\b/gi, "placed").replace(/\.\s*$/, "")} — pushed to the end of the wall furthest from the door (against the corner or out to the edge of the photo, which may cut part of it off), leaving at least one door-width of clear wall before the door frame; it must not be centred on the wall`,
    };
  });
  const bedSpace = (brief as any).bedSpace;
  const out: any = tidyToOneBedsideTable({ ...brief, layout });
  if (bedSpace && Number(bedSpace.bedsideTables) > 1) out.bedSpace = { ...bedSpace, bedsideTables: 1 };
  return { brief: out, changed };
}

// ── Tight shots ─────────────────────────────────────────────────────────────
// A photo taken from a doorway, high up or pointed up shows very little floor.
// The plan still asked for a queen bed, bedside tables and a rug, and Gemini
// made room by raising the floor / pushing a wall back; the merge then pasted
// the rug onto the real wall (Oct 2026, 33 Golf Rd Image 05: 9.5% floor; a
// normal room shot shows 15-30%). For these photos the plan is cut down in
// code and the prompt says the furniture may run off the photo edge.
// STAGE2_TIGHT_SHOT=off disables it.
export const TIGHT_SHOT_ENABLED = String(process.env.STAGE2_TIGHT_SHOT ?? "on").trim().toLowerCase() !== "off";
export const TIGHT_SHOT_MAX_FLOOR_PCT = Number(process.env.STAGE2_TIGHT_SHOT_MAX_FLOOR_PCT || 12);

// Rooms where the floor line is a fair measure. Kitchens are left out: the
// cabinet plinths read as the floor line, so the floor looks smaller than it is.
export function tightShotApplies(roomType: string): boolean {
  const key = String(roomType || "").toLowerCase().replace(/-/g, "_");
  return !/kitchen|bath|laundry|pantry|closet|garage|stair|hall|entry/.test(key);
}

export function tightShotInstruction(floorPct: number): string {
  return `TIGHT SHOT: this photo shows very little floor (about ${Math.round(floorPct)}% of the picture). Plan only what the visible floor really holds: the main piece pushed toward the far corner with the bottom or side edge of the photo cutting off its foot or near side (that is normal in a real listing photo), at most one bedside or side table, and NO rug. Choose the smaller size of every piece: a double bed rather than a queen or king, or a single bed where even a double would crowd the visible floor. Never plan anything that needs more floor than the photo shows.`;
}

export function makeTightShotPlan(brief: RoomBrief, roomType: string, floorPct: number): { brief: RoomBrief; changed: string[] } {
  const changed: string[] = [];
  if (!Array.isArray(brief?.layout)) return { brief, changed };
  const isRug = (it: any) => /\brug\b|\bcarpet\b|\bmat\b/i.test(String(it?.item || ""));
  let layout = brief.layout.filter((it: any) => {
    if (!isRug(it)) return true;
    changed.push(`dropped "${String(it.item || "").slice(0, 60)}"`);
    return false;
  });
  // Mentions of the dropped rug elsewhere would bring it back.
  const noRug = (t: string) => String(t || "").replace(/,?\s*(on|over|with|and)?\s*(an?|the)\s+(area\s+)?rug\b[^,.;]*/gi, "").trim();
  layout = layout.map((it: any) => ({ ...it, placement: noRug(it.placement) || it.placement }));
  let out: any = { ...brief, layout, relationships: (brief.relationships || []).map(noRug).filter(Boolean), tightShot: { floorPct } };
  if (/^bedroom/i.test(String(roomType || "").toLowerCase().replace(/-/g, "_"))) {
    const big = /\b(king|queen)(\s*-?\s*size(d)?)?\b/gi;
    const bs = (brief as any).bedSpace;
    if (bs && /king|queen/i.test(String(bs.bed || ""))) {
      changed.push(`${bs.bed} bed -> double`);
      out.bedSpace = { ...bs, bed: "double" };
    }
    const downsize = (t: string) => String(t || "").replace(big, "double");
    out.layout = out.layout.map((it: any) => ({ ...it, item: downsize(it.item), placement: downsize(it.placement) }));
    out.relationships = out.relationships.map(downsize);
    const isBed = (it: any) => /\bbed\b/i.test(String(it?.item || "")) && !/bedside|side table|bed end|bench/i.test(String(it?.item || ""));
    out.layout = out.layout.map((it: any) => {
      if (!isBed(it) || /photo edge|edge of the photo/i.test(String(it.placement || ""))) return it;
      return { ...it, placement: `${String(it.placement || "").replace(/\.\s*$/, "")} — the bottom or side edge of the photo may cut off the foot or near side of the bed` };
    });
    // One bedside table, on the far side: the near one is where the floor
    // runs out of the photo first.
    const isTable = (it: any) => /bedside|night ?stand|side table/i.test(String(it?.item || ""));
    const text = (it: any) => `${String(it?.item || "")} ${String(it?.placement || "")}`;
    const plural = /tables|set of (2|two)|pair|\btwo\b|each side|both sides|flanking|either side/i;
    out.layout = out.layout.map((it: any) => (isTable(it) && plural.test(text(it))
      ? { ...it, item: "Bedside table", placement: "a single bedside table on the far side of the bed, toward the far corner" }
      : it));
    const tables = out.layout.filter(isTable);
    if (tables.length > 1) {
      const near = /foreground|toward(s)? the camera|closest to the (camera|viewer)|\bnear (side|end)\b|\bnear bedside\b|\bfront\b/i;
      const keep = tables.find((it: any) => !near.test(text(it))) || tables[0];
      out.layout = out.layout.filter((it: any) => !isTable(it) || it === keep);
      changed.push(`kept one bedside table of ${tables.length}`);
    }
    out = tidyToOneBedsideTable(out);
    if (out.bedSpace && Number(out.bedSpace.bedsideTables) > 1) out.bedSpace = { ...out.bedSpace, bedsideTables: 1 };
  }
  return { brief: out, changed };
}

/**
 * Office/study plans, checked in code (Oct 2026, production: desks staged in
 * front of an alcove's door while a plain wall was free). A desk whose plan
 * mentions a door is pushed to the far end of its wall, away from the door,
 * with the photo edge allowed to cut it off; the bookshelf and armchair are
 * dropped when the plan puts them by a door.
 */
export function makeDeskPlanConservative(brief: RoomBrief, roomType: string): { brief: RoomBrief; changed: string[] } {
  const changed: string[] = [];
  if (!/study|office/i.test(String(roomType || "")) || !Array.isArray(brief?.layout)) return { brief, changed };
  const isDesk = (it: any) => /\bdesk\b|work ?table/i.test(String(it?.item || "")) && !/chair|lamp/i.test(String(it?.item || ""));
  const isExtra = (it: any) => /book ?shel|bookcase|shelving|armchair|accent chair|reading chair/i.test(String(it?.item || ""));
  let layout = brief.layout.filter((it: any) => {
    if (isExtra(it) && /door/i.test(String(it?.placement || ""))) {
      changed.push(`dropped "${String(it.item || "").slice(0, 40)}" placed by a door`);
      return false;
    }
    return true;
  });
  layout = layout.map((it: any) => {
    if (!isDesk(it) || !/door/i.test(String(it?.placement || ""))) return it;
    changed.push("desk pushed away from the door");
    return {
      ...it,
      placement: `${String(it.placement || "").replace(/\bcente?red\b/gi, "placed").replace(/\.\s*$/, "")} — pushed to the end of that wall furthest from the door (against the corner or out to the edge of the photo, which may cut part of it off), leaving at least one door-width of clear wall before the door frame; the desk and chair never reach the door or its swing`,
    };
  });
  return { brief: { ...brief, layout }, changed };
}

/**
 * Living / dining plans, checked in code (same idea as beds and desks). The
 * planner is asked to say where each main piece sits relative to the nearest
 * door, so a door mention alone is fine ("leaving a clear path to the sliding
 * door"); only a piece placed BESIDE / IN FRONT OF / ACROSS a door is pushed
 * away, and an armchair, sideboard or shelf placed there is dropped.
 */
const NEXT_TO_DOOR = /\b(?:(?:next to|beside|near|by|in front of|across|adjacent to|alongside|against|blocking)\s+(?:the\s+|a\s+|an\s+)?(?:[\w-]+\s+){0,3}?|between\s[^,.;]{0,60}?\b)(door|doors|doorway|doorways|sliding door|sliding doors|entrance|entry)\b/i;
export function makeLivingPlanConservative(brief: RoomBrief, roomType: string): { brief: RoomBrief; changed: string[] } {
  const changed: string[] = [];
  if (!/living|dining/i.test(String(roomType || "")) || !Array.isArray(brief?.layout)) return { brief, changed };
  const item = (it: any) => String(it?.item || "");
  const isMain = (it: any) =>
    /\bsofa\b|couch|sectional|loveseat|lounge suite/i.test(item(it))
    || (/\btable\b/i.test(item(it)) && /dining/i.test(item(it)))
    || /tv unit|media (unit|console|cabinet)|entertainment unit|tv console|tv cabinet/i.test(item(it));
  const isExtra = (it: any) => /armchair|accent chair|occasional chair|sideboard|buffet|console table|book ?shel|bookcase|shelving|side table/i.test(item(it)) && !/bedside/i.test(item(it));
  let layout = brief.layout.filter((it: any) => {
    if (isExtra(it) && NEXT_TO_DOOR.test(String(it?.placement || ""))) {
      changed.push(`dropped "${item(it).slice(0, 40)}" placed by a door`);
      return false;
    }
    return true;
  });
  layout = layout.map((it: any) => {
    if (!isMain(it) || !NEXT_TO_DOOR.test(String(it?.placement || ""))) return it;
    changed.push(`"${item(it).slice(0, 40)}" kept clear of the door`);
    return {
      ...it,
      placement: `${String(it.placement || "").replace(/\bcente?red\b/gi, "placed").replace(/\.\s*$/, "")} — kept well clear of that door: at least one door-width of clear floor between it and the door frame, the door's swing and the path through the doorway; if the space is short it is pushed to the far end away from the door (the photo edge may cut it off), or made smaller`,
    };
  });
  return { brief: { ...brief, layout }, changed };
}

/** Soft check: the sofa must say what its back is against (or that it divides the areas). */
export function checkSofaPlacement(brief: RoomBrief, roomType: string): string[] {
  if (!/living/i.test(String(roomType || "")) || !Array.isArray(brief?.layout)) return [];
  const sofa = brief.layout.find((it: any) => /\bsofa\b|couch|sectional|loveseat|lounge suite/i.test(String(it?.item || "")));
  if (!sofa) return [];
  const pl = String(sofa.placement || "");
  if (!/\bwall\b|\bback\b|free-?standing|divid|separat/i.test(pl)) {
    return ["the sofa's placement must say what its back is against (for example \"back against the plain left wall\") or that it stands free between the living and dining areas, and where it sits relative to the nearest door"];
  }
  return [];
}

/** Soft check: the desk must stand against a named wall, not float in the room. */
export function checkDeskPlacement(brief: RoomBrief, roomType: string): string[] {
  if (!/study|office/i.test(String(roomType || "")) || !Array.isArray(brief?.layout)) return [];
  const desk = brief.layout.find((it: any) => /\bdesk\b|work ?table/i.test(String(it?.item || "")) && !/chair|lamp/i.test(String(it?.item || "")));
  if (!desk) return ["a study needs a desk in the layout"];
  const pl = String(desk.placement || "");
  if (!/\bwall\b/i.test(pl) || /\b(middle|centre|center) of the (room|floor)\b|free-?standing/i.test(pl)) {
    return ["the desk's placement must name the plain wall it stands against (for example \"against the plain right wall\"), never the middle of the room or in front of a window away from a wall"];
  }
  return [];
}

/**
 * Light mentions without a light (code, not AI judgement). "Centred under the
 * light" made Gemini add pendant lights over dining tables to satisfy it
 * (Oct 2026). When the plan lists no light fitting, every mention of one in
 * the layout, zones and relationships is removed.
 */
const LIGHT_PHRASE = /,?\s*(?:and\s+)?(?:(?:cente?red|centred|placed|positioned|set|directly|right|squarely)\s+)*(?:under|beneath|below)\s+(?:the\s+|a\s+|an\s+)?(?:[\w-]+\s+){0,3}?(?:light|lights|pendant|pendants|chandelier|light fitting|light fixture|fixture|fitting)s?\b(?:\s+(?:fitting|fixture)s?)?/gi;
export function removeUnbackedLightMentions(brief: RoomBrief): { brief: RoomBrief; changed: string[] } {
  const changed: string[] = [];
  const hasLight = (brief.landmarks || []).some((l: any) => l?.type === "light_fitting");
  if (hasLight || !Array.isArray(brief?.layout)) return { brief, changed };
  const strip = (t: string) => String(t || "").replace(LIGHT_PHRASE, "").replace(/\s{2,}/g, " ").replace(/^\s*[,;]\s*/, "").trim();
  const layout = brief.layout.map((it: any) => {
    const before = String(it?.placement || "");
    let after = strip(before);
    if (after === before) return it;
    if (after.length < 12) after = /dining|table/i.test(String(it?.item || "")) ? "freestanding in the dining area with clear floor on every side to pull the chairs out" : "in its area of the room";
    changed.push(`removed a light mention from "${String(it?.item || "").slice(0, 40)}"`);
    return { ...it, placement: after };
  });
  const out: any = { ...brief, layout };
  if (Array.isArray(brief.relationships)) out.relationships = brief.relationships.map(strip);
  if (Array.isArray(brief.zones)) out.zones = brief.zones.map((z: any) => ({ ...z, description: strip(z?.description) }));
  return { brief: out, changed };
}

/** One room-brief call (plus one corrected retry only if the rule checks fail). */
export async function buildRoomBrief(params: {
  imagePath: string;
  roomType: string;
  styleDescription?: string;
  model?: string;
}): Promise<RoomBriefResult> {
  const model = params.model || ROOM_BRIEF_MODEL;
  const usage: RoomBriefUsage[] = [];
  const image = await loadImageForBrief(params.imagePath);
  let floorPct: number | null = null;
  if (TIGHT_SHOT_ENABLED && tightShotApplies(params.roomType)) {
    floorPct = await visibleFloorPct(fs.readFileSync(params.imagePath)).catch(() => null);
  }
  const tight = floorPct !== null && floorPct < TIGHT_SHOT_MAX_FLOOR_PCT;
  console.log("[ROOM_BRIEF_FLOOR]", JSON.stringify({ roomType: params.roomType, visibleFloorPct: floorPct, tightShot: tight }));
  const base = buildRoomBriefInstruction(params.roomType, params.styleDescription) + (tight ? `\n\n${tightShotInstruction(floorPct!)}` : "");
  let lastIssues: string[] = [];
  let lastBrief: RoomBrief | undefined;
  let usableBrief: RoomBrief | undefined; // passed every rule but the bed-fit one
  for (let attempt = 1; attempt <= 2; attempt++) {
    const instruction = attempt === 1
      ? base
      : `${base}\n\nYour previous plan for this photo had these problems — return a corrected JSON plan:\n${lastIssues.map((i) => `- ${i}`).join("\n")}`;
    let text: string;
    try {
      const res = await callBriefModel(image, instruction, model);
      usage.push(res.usage);
      text = res.text;
    } catch (e: any) {
      lastIssues = [`call failed: ${String(e?.message || e).slice(0, 200)}`];
      continue;
    }
    let brief: RoomBrief;
    try {
      brief = extractJson(text) as RoomBrief;
      normaliseLandmarkBoxes(brief);
    } catch {
      lastIssues = ["the answer was not valid JSON — return only the JSON object"];
      continue;
    }
    const conservative = makeBedPlanConservative(brief, params.roomType);
    if (conservative.changed.length) {
      brief = conservative.brief;
      console.log("[ROOM_BRIEF_CONSERVATIVE_BED]", JSON.stringify({ changed: conservative.changed }));
    }
    const lightRule = removeUnbackedLightMentions(brief);
    if (lightRule.changed.length) {
      brief = lightRule.brief;
      console.log("[ROOM_BRIEF_LIGHT_MENTIONS_REMOVED]", JSON.stringify({ changed: lightRule.changed }));
    }
    const livingRule = makeLivingPlanConservative(brief, params.roomType);
    if (livingRule.changed.length) {
      brief = livingRule.brief;
      console.log("[ROOM_BRIEF_CONSERVATIVE_LIVING]", JSON.stringify({ changed: livingRule.changed }));
    }
    const deskRule = makeDeskPlanConservative(brief, params.roomType);
    if (deskRule.changed.length) {
      brief = deskRule.brief;
      console.log("[ROOM_BRIEF_CONSERVATIVE_DESK]", JSON.stringify({ changed: deskRule.changed }));
    }
    if (tight) {
      const tightRule = makeTightShotPlan(brief, params.roomType, floorPct!);
      brief = tightRule.brief;
      console.log("[ROOM_BRIEF_TIGHT_SHOT]", JSON.stringify({ visibleFloorPct: floorPct, changed: tightRule.changed }));
    }
    lastBrief = brief;
    lastIssues = checkRoomBrief(brief, params.roomType);
    // Bed fit is asked about once: a plan that still doesn't add up on the
    // retry is used anyway (logged) rather than losing the whole plan.
    const bedFit = [
      ...(/^bedroom/i.test(String(params.roomType || "")) ? checkBedFits(brief) : []),
      ...checkDeskPlacement(brief, params.roomType),
      ...checkSofaPlacement(brief, params.roomType),
      // Asked about once, like the fit rules: a plan that still names a wall
      // by direction alone is used rather than losing the whole plan.
      ...checkWallNames(brief),
    ];
    if (bedFit.length) console.log("[ROOM_BRIEF_FIT]", JSON.stringify({ attempt, bedSpace: (brief as any).bedSpace, issues: bedFit }));
    if (attempt === 1 && lastIssues.length === 0 && bedFit.length) usableBrief = brief;
    if (attempt === 1) lastIssues.push(...bedFit);
    if (lastIssues.length === 0) return { ok: true, brief, issues: [], usage };
  }
  if (usableBrief) return { ok: true, brief: usableBrief, issues: [], usage };
  return { ok: false, reason: "room_brief_checks_failed", issues: lastIssues, brief: lastBrief, usage };
}

// Per-job cache, so a restage of the same input image reuses the brief
// instead of paying for it again.
const briefCache = new Map<string, Promise<RoomBriefResult>>();
const BRIEF_CACHE_MAX = 50;
function buildRoomBriefSafe(params: { imagePath: string; roomType: string; styleDescription?: string }): Promise<RoomBriefResult> {
  return buildRoomBrief(params).catch((e: any) => ({ ok: false as const, reason: `room_brief_error: ${String(e?.message || e).slice(0, 200)}`, issues: [], usage: [] }));
}

// Same canonical room type Stage 2 uses (stage2.ts canonicalRoomType).
export function canonicalRoomTypeForBrief(roomType: string): string {
  const n = String(roomType || "").toLowerCase().replace(/-/g, "_").trim();
  return n === "multiple_living_areas" || n === "multiple_living" ? "kitchen_living_dining" : n;
}

// Early start for EMPTY rooms: the worker starts the brief on the original
// photo while Stage 1A runs (Stage 1A changes light and colour, never the
// room's shape), so Stage 2 finds it ready instead of waiting ~20s. Keyed by
// job + room type, not by file, because Stage 2 asks with the Stage 1A path.
const prefetchedBriefs = new Map<string, Promise<RoomBriefResult>>();
const prefetchKey = (jobId: string, roomType: string) => `${jobId}::${canonicalRoomTypeForBrief(roomType)}`;

export function startRoomBriefPrefetch(params: { jobId: string; imagePath: string; roomType: string; styleDescription?: string }): void {
  const key = prefetchKey(params.jobId, params.roomType);
  if (prefetchedBriefs.has(key)) return;
  const startedAt = Date.now();
  console.log("[ROOM_BRIEF_PREFETCH_START]", JSON.stringify({ jobId: params.jobId, roomType: canonicalRoomTypeForBrief(params.roomType) }));
  const p = buildRoomBriefSafe({ ...params, roomType: canonicalRoomTypeForBrief(params.roomType) });
  void p.then((r) => console.log("[ROOM_BRIEF_PREFETCH_DONE]", JSON.stringify({ jobId: params.jobId, ok: r.ok, ms: Date.now() - startedAt })));
  prefetchedBriefs.set(key, p);
  while (prefetchedBriefs.size > BRIEF_CACHE_MAX) {
    const oldest = prefetchedBriefs.keys().next().value;
    if (oldest === undefined) break;
    prefetchedBriefs.delete(oldest);
  }
}

export function getRoomBriefCached(params: { jobId: string; imagePath: string; roomType: string; styleDescription?: string }): Promise<RoomBriefResult> {
  const key = `${params.jobId}::${params.imagePath}::${params.roomType}`;
  const hit = briefCache.get(key);
  if (hit) return hit;
  const early = prefetchedBriefs.get(prefetchKey(params.jobId, params.roomType));
  // A failed early brief is not reused — Stage 2 builds one the normal way.
  const p = early
    ? early.then((r) => {
        console.log("[ROOM_BRIEF_PREFETCH_USED]", JSON.stringify({ jobId: params.jobId, ok: r.ok }));
        if (r.ok) return r;
        for (const u of r.usage) console.log("[ROOM_BRIEF_USAGE]", JSON.stringify({ jobId: params.jobId, prefetch: true, ...u }));
        return buildRoomBriefSafe(params);
      })
    : buildRoomBriefSafe(params);
  briefCache.set(key, p);
  while (briefCache.size > BRIEF_CACHE_MAX) {
    const oldest = briefCache.keys().next().value;
    if (oldest === undefined) break;
    briefCache.delete(oldest);
  }
  return p;
}

/**
 * The Stage 2 staging prompt, built from the brief: task first, then the
 * room and its layout in plain language, then this room's own features to
 * keep, two hard rules, and a narrow allowance for small finishing touches.
 */
// Tidy one model-written phrase into a sentence: capital first letter,
// exactly one closing full stop.
function asSentence(s: string): string {
  const t = String(s || "").trim().replace(/[\s.;,]+$/, "");
  if (!t) return "";
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[!?]$/.test(t) ? "" : "."}`;
}

// The model sometimes drops the subject ("Stands in the front-left...").
function cameraSentence(s: string): string {
  const t = String(s || "").trim();
  if (!t) return "";
  if (/\bcamera\b/i.test(t)) return asSentence(t);
  if (/^(stands|sits|is|looks|faces|points)\b/i.test(t)) return asSentence(`The camera ${t.charAt(0).toLowerCase()}${t.slice(1)}`);
  return asSentence(`Camera position: ${t}`);
}

export function buildStage2PromptFromRoomBrief(brief: RoomBrief, opts: { roomType: string; styleDescription?: string }): string {
  const label = roomLabelFor(opts.roomType);
  const style = opts.styleDescription ? ` in a ${opts.styleDescription} style` : "";
  const layoutLines = brief.layout.map((l, i) => `${i + 1}. ${l.item}: ${asSentence(l.placement)}`);
  const relationships = (brief.relationships || []).filter(Boolean).map(asSentence);
  const avoid = (brief.avoid || []).filter(Boolean).map(asSentence);
  const keep = (brief.keepUntouched || []).filter(Boolean).map((k) => String(k).trim().replace(/[\s.;,]+$/, ""));
  const zones = (brief.zones || []).filter((z) => z?.name && z?.description).map((z) => `${z.name}: ${asSentence(z.description)}`);

  return [
    `RULE 1 — THE CAMERA IS LOCKED. This outranks everything below, including the layout. The result must be this exact photo with furniture added: the same size, framing, zoom, viewpoint and perspective. Every wall edge, corner, window, door, the ceiling line and the edges of the floor stay at exactly the same place in the picture. If the furniture does not fit, change the furniture — make it smaller, move it slightly, let the edge of the photo cut it off, or leave it out. Never zoom in or out, crop, widen, rotate, tilt or move the viewpoint to make room for furniture.`,
    ``,
    `Stage this empty ${label} for a real-estate listing photo. Add realistic, correctly scaled furniture and decor${style}, with lighting, shadows and perspective that match the photo. The room itself and the camera framing stay exactly as they are.`,
    ``,
    `THE ROOM`,
    [asSentence(brief.roomSummary), cameraSentence(brief.camera)].filter(Boolean).join(" "),
    ...(zones.length ? [``, `Areas of the room:`, ...zones.map((z) => `- ${z}`)] : []),
    ``,
    ...(layoutLines.length
      ? [`LAYOUT — place these pieces exactly as described:`, ...layoutLines]
      : [`LAYOUT — add no large furniture in this room. Add only the small finishing touches described below.`]),
    ...(relationships.length ? [``, `How the pieces relate: ${relationships.join(" ")}`] : []),
    ...(brief.tightShot
      ? [``, `TIGHT SHOT — this photo shows very little floor. Put furniture only on the floor that is visible. Let the bottom or side edge of the photo cut off the foot or near side of the bed or other large pieces, exactly as in a real photo taken from the doorway. Add no rug. The floor, skirting boards and walls stay exactly where they are — never raise the floor or push a wall back to make more room.`]
      : []),
    ...(avoid.length ? [``, `AVOID IN THIS ROOM`, ...avoid.map((a) => `- ${a}`)] : []),
    ``,
    `KEEP EXACTLY AS IN THE PHOTO`,
    ...keep.map((k) => `- ${k}`),
    `- Never add a ceiling or hanging light — no pendant, chandelier, ceiling fan or light fitting that is not in the photo. Lighting comes only from table and floor lamps.`,
    `- Every wall, window, door, doorway, floor, ceiling, light fitting and fixed feature, exactly where and how it is. Use only the walls and floor visible in the photo — never extend, add or move a wall, and never mount anything on a wall that is not in the photo.`,
    `- Never draw a new wall, corner or wall return to stand furniture against — not even at the edge of the photo. Each piece stands against a wall the photo already shows, or in the open room.`,
    `- Keep every doorway and walking path clear.`,
    `- If a piece does not fit in the floor space shown, make it smaller or leave it out — never change the room, the stairs, the cabinetry or the camera view to make room for it.`,
    `- A piece may be partly cut off by the edge of the photo, or partly hidden behind a wall, doorframe, bench or other fixed feature, exactly as real furniture would be. Keep each piece in its planned spot — only its size and how much of it shows may change.`,
    ``,
    `FINISHING TOUCHES`,
    `You may add a few small finishing touches that suit this room: ${brief.tightShot ? finishingTouchesFor(opts.roomType).replace(/^a rug under the seating, bed or dining table, /, "") : finishingTouchesFor(opts.roomType)}. Do not add any other large furniture${brief.tightShot ? " and no rug" : ""}, and do not move the pieces listed above.`,
    ``,
    `The result must look like a real, professionally staged listing photograph of this exact room.`,
  ].join("\n");
}
