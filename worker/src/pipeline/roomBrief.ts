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

export const ROOM_BRIEF_MODEL = String(process.env.ROOM_BRIEF_MODEL || "gemini-3.8-flash");
const ROOM_BRIEF_MAX_SIDE = Math.max(512, Number(process.env.ROOM_BRIEF_IMAGE_MAX_SIDE || 1280));
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
  bedSpace?: { bed: "king" | "queen" | "double" | "single"; bedsideTables: 0 | 1 | 2; reason?: string };
  layout: Array<{ item: string; placement: string }>;
  relationships: string[];
  avoid: string[];
  keepUntouched: string[];
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
  const living = `LIVING AREA: a sofa (and an armchair if there is room), a coffee table and a rug, arranged as one conversation group. If the room has a TV wall bracket, the TV is mounted ON that bracket and the seating faces it; a low TV unit may sit on the floor below it. Without a bracket, put a TV unit against a solid, clearly visible wall opposite the seating — or, if no wall suits a TV, face the seating toward the window or fireplace and add no TV.`;
  const dining = `DINING AREA: a dining table with 4–6 chairs, freestanding with room to pull the chairs out. Centre it under the dining light fitting if there is one.
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
BED SPACE CHECK: first judge the open floor you can actually see. Measure the headboard wall by its VISIBLE length only — if it runs off the edge of the photo, the hidden part does not count, so a bed and bedside tables must fit within what is shown (they may run slightly past the photo edge, but never need more room than the visible wall). Choose the largest bed that still leaves a clear walkway along at least one long side and past the foot of the bed, and lets the door and wardrobe open fully: king, else queen, else double, else single. Then bedside tables: one on each side if both sides have room, one if only one side does, none if neither (never squeeze one in front of a door, wardrobe or window). Name the bed size in the layout item (for example "Double bed"). Record your decision in "bedSpace".
Optionally a dresser, a chair or a bench at the end of the bed, only if there is still clear floor after all of the above. Keep the paths to the door and the wardrobe clear.`;
  }
  if (key === "study" || key === "office") return `STUDY: a desk and desk chair, ideally facing the window or a wall with the window to the side, plus a bookshelf or a small armchair if there is room.`;
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
- Keep every door, sliding door and doorway clear, with a walking path between them. Do not cover windows, the heat pump, switches, outlets, the fireplace or any other fixed feature.
- Describe every position with words about visible landmarks and the room ("at the back of the room, in front of the kitchen bench", "against the plain wall on the left, between the sliding door and the window"). Never use coordinates, pixels, percentages or wall numbers in "layout", "relationships", "avoid" or "keepUntouched".
- Write each placement so that someone looking at the same photo can find the exact spot. Only refer to features you listed in "landmarks".
- Write "camera" as a full sentence starting "The camera…", and each "avoid" entry as a full sentence starting "Do not…".
- Plan only the main furniture in "layout" (up to about 8 items, fewer in a small or tight space, and none where the room type above says the layout stays empty). Small decor is handled separately.
- Every piece must fit in the floor space the photo really shows. Never plan furniture that would only fit if the room were bigger or the camera were moved. A wall that runs off the edge of the photo counts only for its visible length.
- When in doubt between two sizes, choose the smaller one — a slightly small piece looks natural; a piece that is too big forces the room to change.

Return ONLY a JSON object:
{
  "roomSummary": string,          // 1–2 sentences: what the room is and how it is laid out
  "camera": string,               // where the camera stands and what it looks toward
  "landmarks": [ { "id": "L1", "type": ${LANDMARK_TYPES}, "description": string, "box": [x1, y1, x2, y2] } ],
                                  // description says what it is and where ("black TV wall bracket on the white wall on the right"); box = rough 0–1 bounding box
  "walls": [ { "name": string, "description": string, "usableForLargeFurniture": boolean, "partlyVisible": boolean } ],
  "zones": [ { "name": string, "description": string } ],
  "kitchenVisible": boolean,
  "fridgeSpace": { "present": boolean, "description": string },   // true only for an empty cavity clearly built for a fridge
  "diningSpace": { "fits": "full" | "small" | "none", "reason": string },   // only for room types with a dining area
  "bedSpace": { "bed": "king" | "queen" | "double" | "single", "bedsideTables": 0 | 1 | 2, "reason": string },   // only for bedrooms
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

/** Checks the brief against the rules the code must guarantee. */
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
    config: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: "application/json" },
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
  const base = buildRoomBriefInstruction(params.roomType, params.styleDescription);
  let lastIssues: string[] = [];
  let lastBrief: RoomBrief | undefined;
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
    } catch {
      lastIssues = ["the answer was not valid JSON — return only the JSON object"];
      continue;
    }
    lastBrief = brief;
    lastIssues = checkRoomBrief(brief, params.roomType);
    if (lastIssues.length === 0) return { ok: true, brief, issues: [], usage };
  }
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
    ...(avoid.length ? [``, `AVOID IN THIS ROOM`, ...avoid.map((a) => `- ${a}`)] : []),
    ``,
    `KEEP EXACTLY AS IN THE PHOTO`,
    ...keep.map((k) => `- ${k}`),
    `- Every wall, window, door, doorway, floor, ceiling, light fitting and fixed feature, exactly where and how it is. Use only the walls and floor visible in the photo — never extend, add or move a wall, and never mount anything on a wall that is not in the photo.`,
    `- Keep every doorway and walking path clear.`,
    `- If a piece does not fit in the floor space shown, make it smaller or leave it out — never change the room, the stairs, the cabinetry or the camera view to make room for it.`,
    `- A piece may be partly cut off by the edge of the photo, or partly hidden behind a wall, doorframe, bench or other fixed feature, exactly as real furniture would be. Keep each piece in its planned spot — only its size and how much of it shows may change.`,
    ``,
    `FINISHING TOUCHES`,
    `You may add a few small finishing touches that suit this room: ${finishingTouchesFor(opts.roomType)}. Do not add any other large furniture, and do not move the pieces listed above.`,
    ``,
    `The result must look like a real, professionally staged listing photograph of this exact room.`,
  ].join("\n");
}
