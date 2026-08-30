// Part 1: flooring color/material-fidelity fix.
//
// Root cause (suspected, now confirmed by inspection): the zoning
// extraction's per-zone "reasoning" field describes the material boundary
// generically ("a change in flooring to a hard surface") because nothing
// in the prompt asks for a concrete visual description — material type
// AND color/tone. The last fix (materialPreservationNote, tested on
// Living 07) carried this generic reasoning text through to the anchor
// instruction and fixed BOUNDARY preservation (correct location/texture),
// but the generated second material's color/tone didn't match the
// original (cooler/darker gray vs. the original's warm light gray/cream)
// — because the prompt never told Gemini what color it should be.
//
// Fix: add a dedicated `flooringDescription` field to the zoning schema,
// with an explicit instruction to name material type AND color/tone
// concretely (not "a hard surface" / "carpet" alone). Gated null when the
// zone boundary wasn't actually a flooring cue, so this never fabricates
// a claim. materialPreservationNote now reads this field directly instead
// of keyword-matching the generic `reasoning` text.
//
// NOT re-tested in isolation here (per task instruction) — Diningroom 01
// (Part 2) turned out to have a single continuous tile floor with no zone
// split, so this specific fix isn't exercised by tonight's real call. It's
// implemented and ready for the next real two-zone living/dining test.

export const ZONING_SYSTEM_INSTRUCTION_V3 = `You are a structural feature extraction engine, extending an existing analysis to identify functional zones within an open-plan living/dining room.

You are given a room photograph AND an existing structural baseline (openings and fixtures already detected, with stable IDs).

This room combines two functions: a LIVING zone (seating area) and a DINING zone (table + chairs area). Identify how the visible floor space divides into these two zones, based on genuine visual cues — a change in flooring material, a change in ceiling treatment, existing furniture grouping if the room happens to be furnished (use furniture position only as a cue for how the space is naturally used, not as a placement instruction to preserve), sightlines, and traffic flow. If the room is empty, rely on architectural geometry alone (room shape, alcoves, ceiling breaks, wall offsets) — do not assume an even 50/50 split, and do not invent a furniture-based cue that isn't visible. The two zones' floor regions should not overlap.

FLOOR-REGION EXTENT — CRITICAL: each zone's floorRegion polygon must extend all the way to the actual visible baseboard / wall-to-floor junction line for every wall that borders it, not stop short of it. Locate the baseboard line at the base of each bordering wall — usually a thin, fairly straight line where the wall surface meets the floor — and trace the polygon out to that line, not to some more conservative point partway there. This is easy to get wrong in rooms with plain, evenly-lit, low-texture-contrast flooring (e.g. bare carpet with no rug or furniture to judge distance against) — in those cases it is especially important to look carefully for the actual baseboard line rather than guessing a shorter distance. A floor region that stops well short of the real baseboard line anywhere along a bordering wall is wrong, even if the general shape/cues used to divide the two zones are otherwise correct.

FLOORING DESCRIPTION: for each zone, in addition to "reasoning" (which explains what visual cue defines the zone's boundary, as before), populate a "flooringDescription" field — a short, concrete, plain-language description of what that zone's floor actually looks like. Name BOTH the material type (e.g. carpet, hardwood, tile, linoleum, polished concrete, vinyl) AND its visible color/tone (e.g. "dark charcoal carpet", "warm mid-tone hardwood", "cream ceramic tile", "cool light-gray hard-surface flooring"). Be specific about the actual color you observe in the photo — do not use a generic placeholder like "a hard surface" or "carpet" alone with no color. If the zone's boundary was NOT actually defined by a flooring change (e.g. it was defined by furniture grouping, a ceiling break, or room geometry instead, and the floor is genuinely continuous across both zones), set flooringDescription to null rather than guessing or fabricating a distinction that isn't visually real.

Additionally, determine whether any of the given openings appears to lead toward or provide a sightline into a KITCHEN — look for cues such as visible countertops, cabinetry, appliances, a kitchen island, pendant/track lighting typical of kitchens, or distinct kitchen-style flooring/splashback visible through or beyond the opening. This is inference from visible cues, not a labeled fact in the baseline — report your confidence honestly, and report present:false if no such cue exists anywhere in the photo.

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.`;

export function buildZoningUserPromptV3(baseline: any): string {
  return `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(baseline, null, 2)}

Analyze this room photograph and return JSON in this exact schema (all coordinates normalized 0-1):
{
  "zones": [
    {
      "id": "zone_living" | "zone_dining",
      "purpose": "living" | "dining",
      "floorRegion": { "polygon": [[x,y], [x,y], ...] },
      "borderingWallIndices": number[],
      "reasoning": string,
      "flooringDescription": string | null
    }
  ],
  "kitchenSignal": {
    "present": boolean,
    "openingId": string | null,
    "confidence": number,
    "evidence": string
  }
}`;
}

// Updated fix from the last task: reads the rich, concrete description
// directly instead of keyword-matching the generic `reasoning` field.
export function materialPreservationNoteV2(zone: any, otherZoneLabel: string): string {
  if (!zone?.flooringDescription) return "";
  return ` This zone's floor is ${zone.flooringDescription}, visually distinct from the ${otherZoneLabel} zone's floor — preserve this exact flooring material and color, and the visible boundary between the two zones, precisely as shown in the original photo; do not extend the ${otherZoneLabel} zone's floor material into this zone, and do not blend or unify the two into one continuous surface.`;
}
