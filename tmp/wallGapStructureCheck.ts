// New hypothesis, user-proposed: replace the continuous 0-1 "extent
// fraction" (proven noisy all night — e.g. 3e255f88's -50%/+80% swings on a
// physically unchanged light fixture) with two independent, concrete,
// countable/categorical facts instead:
//   1. boundarySizeCategory — an ORDINAL bucket (touching/narrow/medium/wide)
//      for the wall segment between a DETERMINISTICALLY-CHOSEN corner
//      (whichever of the item's wall's two corners sits closer to the
//      photo's own horizontal center — not freely chosen, removing the
//      landmark-selection-mismatch failure mode that broke Part 2 and
//      required the vanish-check's strict reconfirmation workaround) and
//      whatever is nearest to it at the item's expected location.
//   2. itemStructureCount — a discrete integer (pane/panel/section count),
//      something vision models are typically far more reliable at counting
//      than estimating a continuous spatial fraction.
// Two independent signals converging (boundary jumps AND structure count
// changes) is meant to be stronger, more legible evidence of a real resize
// than either alone — directly testing whether concrete/discrete facts are
// more stable than the continuous estimates used by every prior mechanism
// tonight.
import { toBase64 } from "../worker/src/utils/images";
import { grokAnalyzeImages, grokVisionModel } from "../worker/src/ai/grok";
import { resolveValidatorModel } from "../worker/src/validators/occlusionVsRemovalCheck";

export type WallGapObservation = {
  identifiedItemDescription: string;
  itemLocationDescription: string;
  structuralTraceDescription: string;
  itemPresenceState: "present" | "present_partial" | "occluded" | "absent" | "cannot_tell";
  nearestCenterCorner: string | null;
  boundaryDescription: string | null;
  boundarySizeCategory: "touching" | "narrow" | "medium" | "wide" | "unknown";
  boundaryDefinedBy: "item_itself" | "new_object" | "open_wall" | "cannot_tell";
  itemStructureDescription: string | null;
  itemStructureCount: number | null;
};

// Item-type-aware trace vocabulary (fixes the Living 07 root cause: the
// original generic vocabulary was door/window-biased — edge, frame, hinge,
// track, sill, jamb — and never prompted the model to recognize a visible
// fireplace hearth as a valid remnant, so its own trace search said "looked
// for hearth stone... found none" while a hearth WAS actually visible in
// the photo, per the user's own direct visual confirmation). Union with the
// generic list, never replace, so an imperfect type mapping never removes
// coverage.
const TRACE_VOCAB_BY_TYPE: Record<string, string[]> = {
  window: ["edge", "frame", "sill", "jamb", "mullion", "sash", "glazing edge"],
  door: ["edge", "frame", "hinge", "track", "sill", "jamb", "threshold", "mounting hardware"],
  closet_door: ["edge", "frame", "hinge", "track", "jamb", "mounting hardware", "bifold track"],
  walkthrough: ["opening edge", "header/lintel line", "casing or trim edge", "flooring material transition at the threshold"],
  ac_unit: ["wall sleeve or grille", "vent louvers", "control panel", "mounting bracket", "exterior sleeve cutout"],
  fireplace: ["hearth", "hearth platform or raised stone/tile base", "firebox opening", "mantel", "flue or chimney breast", "surround"],
  built_in_cabinet: ["cabinet face frame edge", "toe kick", "shelf ledge line", "cabinet scribe strip"],
  kitchen_island: ["base/plinth footprint outline", "countertop overhang edge", "toe kick"],
  staircase: ["stringer edge", "handrail or baluster line", "tread nosing", "newel post base"],
  plumbing_fixture: ["supply line stub", "drain rough-in", "mounting bracket", "valve or escutcheon plate"],
  light_fixture: ["mounting plate or canopy", "junction box cover", "bracket or arm stub", "wiring nub"],
};
const GENERIC_TRACE_VOCAB = ["edge", "corner", "frame", "mounting hardware", "base or plinth trace"];

function getTraceVocabulary(itemType: string): string[] {
  const specific = TRACE_VOCAB_BY_TYPE[String(itemType || "").toLowerCase()] || [];
  return Array.from(new Set([...specific, ...GENERIC_TRACE_VOCAB]));
}

// FIX 1 (found via the full standing-regression run): the original version
// only ever asked for a structure count, with no way to express "can't find
// it" other than count=0/"not found" — which the comparison layer always
// read as a real structural removal. Fixed by adding a present/occluded/
// absent/cannot_tell classification (mirroring vanish-check's landmark-
// presence logic), forcing a concrete "what's actually at this location"
// description BEFORE classifying.
//
// FIX 2 (found live-testing FIX 1 against the two motivating cases,
// Bedroom 11 FIXED and Living 07): FIX 1's binary present/occluded/absent
// still missed Living 07 — the model's own trace search failed to
// recognize a visible fireplace hearth as a remnant, landing on a
// confident (wrong) "absent" instead of "occluded". Fixed here with (a) the
// item-type-aware vocabulary above, and (b) a new "present_partial" state:
// furniture present AND a confirmed remnant found -> the item survives,
// pass, without needing a full pane/structure count from a fragment.
//
// FIX 3 (found live-testing FIX 1 against Bedroom 02): FIX 1 correctly
// stopped false-failing Bedroom 02 via "absent" (the door is genuinely
// relocated, but new furniture also sits where it used to be, so staged
// correctly resolves to "occluded") — but this meant the catch rate
// dropped, because the existing gap/boundary-distance signal was gated
// behind itemPresenceState === "present" on both sides, so it never ran
// once staged was "occluded". Fixed by un-gating nearestCenterCorner/
// boundaryDescription/boundarySizeCategory (renamed from gapDescription/
// gapSizeCategory) to always be asked regardless of presence state, and
// adding boundaryDefinedBy so the comparison can tell whether the boundary
// is defined by the item itself, new unrelated furniture, or open wall —
// a meaningful shift in this boundary is itself evidence of a structural
// change at that wall location, independent of whether the occupying
// object is identified as the original item.
function buildPrompt(semanticRef: string, itemType: string): string {
  const typeVocab = getTraceVocabulary(itemType);
  return `Look at THIS photo (only this one photo — no other photo is given to you). Find this item: ${semanticRef}

Answer, for this photo only:

1. identifiedItemDescription — Briefly state what item you actually find matching that description in THIS photo. If you cannot find it, say so plainly.

2. itemLocationDescription — Describe concretely and specifically what is visible at this item's expected location in THIS photo, whether or not you can clearly identify the item itself. Explicitly name any furniture, decor, or other new objects positioned in or near that location, and state where exactly they sit relative to the item's expected position (in front of it / overlapping it / to the side of it / nowhere near it).

3. structuralTraceDescription — Independent of the above, look SPECIFICALLY (even if you just described this location as blocked, covered, or plain) for any small physical trace of the item's OWN structure that might still be visible. For THIS item type in particular, look for: ${typeVocab.join(", ")}. A visible remnant does NOT need to show the whole item — a single unambiguous fragment (e.g. just a hearth platform, just a sill, just a track) counts as a trace. Describe concretely whatever you find, however subtle, and where it is relative to any new furniture; or state plainly that you looked carefully and found none.

4. itemPresenceState — Based on BOTH of the above, classify as EXACTLY one of:
   - "present" — the item's own structure is directly visible essentially in full, not significantly blocked by anything new in front of it (minor edge cropping from camera angle is fine).
   - "present_partial" — new furniture, decor, or another object DOES sit at, in front of, or overlapping this location, hiding most of the item, BUT step 3 found a clear, unambiguous structural trace/remnant that is confidently part of the item itself (not a guess) — e.g. a hearth platform visible below new furniture, a door track visible above a dresser. Use this whenever you have DIRECT visual confirmation the item's own structure survives, even though you cannot see enough of it to fully describe its internal structure or reliably count its panes/panels/sections.
   - "occluded" — new furniture, decor, or another object sits at, in front of, or overlapping this exact location, AND step 3 found NO clear structural trace/remnant belonging to the item itself. Use this whenever furniture/an object is present and you have no direct trace evidence either way.
   - "absent" — use this ONLY when BOTH hold: (a) no new furniture, decor, or object is positioned at, in front of, or overlapping this exact location — it is openly, unobstructedly visible, not blocked by anything, AND (b) step 3 found no structural trace. If furniture/an object IS present at this location, do NOT classify as "absent" — use "present_partial" (trace found) or "occluded" (no trace found) instead, since a confident "gone" verdict requires an unobstructed view of the location, not just an obstructed one.
   - "cannot_tell" — you genuinely cannot determine any of the above (e.g. poor visibility, cropped out of frame). Do NOT default to "absent" here — this is a distinct, more conservative state to use whenever you are not confident.

Regardless of your answer above, also answer the following — these describe the wall boundary at this item's expected location, not the item itself, so answer them even if the item is occluded, absent, or uncertain:

5. nearestCenterCorner — This item sits on (or would sit on) one wall. That wall has two corners (where it meets each adjacent wall). Identify whichever of those TWO corners is closer to the HORIZONTAL CENTER of the photo itself (not necessarily the corner nearest to the item's location — specifically pick based on which corner's position in the photo frame is nearer the photo's own horizontal midline). Describe it concretely, e.g. "the corner where the left wall meets the back wall, appearing left-of-center in this photo."

6. boundaryDescription — Describe, in concrete visual terms, the wall segment between that corner and whatever is nearest to it at this item's expected location: this could be the item's own nearest edge (if present or present_partial), the nearest edge of a different new object (if occluded/replaced), or simply open wall continuing past the item's whole expected footprint (if absent or nothing there). State plainly which of these it is. Do not give a numeric estimate here.

7. boundarySizeCategory — Classify that segment's width as exactly one of: "touching" (whatever is nearest sits right at the corner, no meaningful gap), "narrow" (a small strip of wall, less than roughly one item-width), "medium" (roughly one to two item-widths of wall), "wide" (more than two item-widths of wall, or fully open with nothing bounding it before the far side).

8. boundaryDefinedBy — Classify what defines the near end of that boundary (i.e. what you measured "up to" in step 7) as exactly one of: "item_itself" (the edge/trace you measured to is confidently part of the item itself), "new_object" (the edge you measured to belongs to a different, new piece of furniture/decor/staging, not the item), "open_wall" (nothing obstructs; the segment is open wall for its full length), "cannot_tell" (you cannot confidently tell which of the above applies).

ONLY IF itemPresenceState is "present" (fully present, not present_partial), also answer:

9. itemStructureDescription — Describe the item's own internal structure as visible in THIS photo — for a window or door: how many distinct panes, panels, or sections does it have, and how are they arranged (e.g. "two single panes flanking one large central double pane" or "a single pane" or "two sliding panels"). For a light fixture or other item type, describe the closest analogous distinguishing structural detail (e.g. number of bulbs/arms, shape).

10. itemStructureCount — A single integer: the total count of distinct panes/panels/sections/bulbs you described in itemStructureDescription.

If itemPresenceState is NOT "present" (i.e. "present_partial", "occluded", "absent", or "cannot_tell"), set itemStructureDescription and itemStructureCount to null.

Respond with ONLY a single valid JSON object:
{
  "identifiedItemDescription": "string",
  "itemLocationDescription": "string",
  "structuralTraceDescription": "string",
  "itemPresenceState": "present" | "present_partial" | "occluded" | "absent" | "cannot_tell",
  "nearestCenterCorner": "string" | null,
  "boundaryDescription": "string" | null,
  "boundarySizeCategory": "touching" | "narrow" | "medium" | "wide" | "unknown",
  "boundaryDefinedBy": "item_itself" | "new_object" | "open_wall" | "cannot_tell",
  "itemStructureDescription": "string" | null,
  "itemStructureCount": number | null
}`;
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export async function observeWallGapStructure(params: {
  imagePath: string;
  semanticRef: string;
  itemType: string;
  ctx: { jobId: string; imageId: string; callLabel: string };
}): Promise<WallGapObservation> {
  const loaded = toBase64(params.imagePath);
  const validatorModel = resolveValidatorModel();
  if (validatorModel !== "grok") {
    throw new Error("This test run is Grok-primary; Gemini path not implemented in this script.");
  }
  const text = await grokAnalyzeImages({
    images: [{ buffer: Buffer.from(loaded.data, "base64"), mimeType: loaded.mime, label: "Photo:" }],
    prompt: `You are a careful visual inspector describing precisely where one item is located in a single room photo, using a deterministically-chosen fixed wall corner and the item's own countable structural details.\n\n${buildPrompt(params.semanticRef, params.itemType)}`,
    jobId: params.ctx.jobId,
    imageId: params.ctx.imageId,
    reason: `wall_gap_structure_${params.ctx.callLabel}`,
    expectJson: true,
  });
  console.log(JSON.stringify({ event: "GROK_VALIDATOR_USAGE", jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", callLabel: `wall_gap_structure_${params.ctx.callLabel}`, model: grokVisionModel() }));
  const raw = extractJson(text);
  const categoryEnum = ["touching", "narrow", "medium", "wide"];
  const presenceEnum = ["present", "present_partial", "occluded", "absent", "cannot_tell"];
  const definedByEnum = ["item_itself", "new_object", "open_wall", "cannot_tell"];
  return {
    identifiedItemDescription: typeof raw?.identifiedItemDescription === "string" ? raw.identifiedItemDescription : "",
    itemLocationDescription: typeof raw?.itemLocationDescription === "string" ? raw.itemLocationDescription : "",
    structuralTraceDescription: typeof raw?.structuralTraceDescription === "string" ? raw.structuralTraceDescription : "",
    itemPresenceState: presenceEnum.includes(raw?.itemPresenceState) ? raw.itemPresenceState : "cannot_tell",
    nearestCenterCorner: typeof raw?.nearestCenterCorner === "string" ? raw.nearestCenterCorner : null,
    boundaryDescription: typeof raw?.boundaryDescription === "string" ? raw.boundaryDescription : null,
    boundarySizeCategory: categoryEnum.includes(raw?.boundarySizeCategory) ? raw.boundarySizeCategory : "unknown",
    boundaryDefinedBy: definedByEnum.includes(raw?.boundaryDefinedBy) ? raw.boundaryDefinedBy : "cannot_tell",
    itemStructureDescription: typeof raw?.itemStructureDescription === "string" ? raw.itemStructureDescription : null,
    itemStructureCount: typeof raw?.itemStructureCount === "number" ? raw.itemStructureCount : null,
  };
}

export type WallGapVerdict = {
  verdict: "fail_item_absent" | "fail_boundary_shifted" | "fail_structure_changed" | "fail_both" | "pass_remnant_confirmed" | "inconclusive_occluded" | "pass";
  boundaryShiftDetected: boolean;
  boundaryDelta: number | null;
  boundaryQualifiedByNewObject: boolean;
  structureCountChanged: boolean;
  structureCountDelta: number | null;
  reason: string;
};

const CATEGORY_ORDER = ["touching", "narrow", "medium", "wide"];

function computeBoundaryShift(baseline: WallGapObservation, staged: WallGapObservation): { evaluable: boolean; delta: number | null; shifted: boolean } {
  const baseIdx = CATEGORY_ORDER.indexOf(baseline.boundarySizeCategory);
  const stagedIdx = CATEGORY_ORDER.indexOf(staged.boundarySizeCategory);
  const evaluable = baseIdx >= 0 && stagedIdx >= 0 && baseline.boundaryDefinedBy !== "cannot_tell" && staged.boundaryDefinedBy !== "cannot_tell";
  const delta = evaluable ? stagedIdx - baseIdx : null;
  const shifted = evaluable && delta !== null && Math.abs(delta) >= 2;
  return { evaluable, delta, shifted };
}

// Pure, deterministic, offline-testable. See the plan/report for the full
// precedence table; summarized here:
//   staged "absent"                              -> fail_item_absent (conclusive, boundary not needed)
//   staged "present_partial", no boundary shift   -> pass_remnant_confirmed
//   staged "present_partial", boundary shifted     -> fail_boundary_shifted
//   both sides "present"                          -> original gap/structure comparison, extended with boundary shift
//   anything else (occluded/cannot_tell either side, or baseline not present)
//     -> boundary shift is the ONLY possible signal: shifted -> fail_boundary_shifted, else -> inconclusive_occluded
// The boundary-shift check is only evaluable when both sides' boundaryDefinedBy
// isn't "cannot_tell" and both boundarySizeCategory values are parseable — a
// genuinely ambiguous read is skipped rather than guessed, so this new signal
// can't itself become a source of noise on top of the presence classification.
export function compareWallGapObservations(baseline: WallGapObservation, staged: WallGapObservation): WallGapVerdict {
  const boundary = computeBoundaryShift(baseline, staged);
  const boundaryQualifiedByNewObject = staged.boundaryDefinedBy === "new_object";
  const boundaryReasonPart = `boundary: ${baseline.boundarySizeCategory}(${baseline.boundaryDefinedBy})->${staged.boundarySizeCategory}(${staged.boundaryDefinedBy}) (delta=${boundary.delta}, shifted=${boundary.shifted}, evaluable=${boundary.evaluable})`;

  if (staged.itemPresenceState === "absent") {
    return {
      verdict: "fail_item_absent",
      boundaryShiftDetected: false,
      boundaryDelta: null,
      boundaryQualifiedByNewObject,
      structureCountChanged: false,
      structureCountDelta: null,
      reason: `staged photo shows a confident "absent" classification — item's expected location is openly visible and plain, with no trace of it (not merely occluded): "${staged.itemLocationDescription}"`,
    };
  }

  if (staged.itemPresenceState === "present_partial") {
    if (boundary.shifted) {
      return {
        verdict: "fail_boundary_shifted",
        boundaryShiftDetected: true,
        boundaryDelta: boundary.delta,
        boundaryQualifiedByNewObject,
        structureCountChanged: false,
        structureCountDelta: null,
        reason: `item confirmed present via structural remnant, but ${boundaryReasonPart}`,
      };
    }
    return {
      verdict: "pass_remnant_confirmed",
      boundaryShiftDetected: false,
      boundaryDelta: boundary.delta,
      boundaryQualifiedByNewObject,
      structureCountChanged: false,
      structureCountDelta: null,
      reason: `item confirmed present via a structural remnant, rest occluded by new furniture: "${staged.structuralTraceDescription}"; ${boundaryReasonPart}`,
    };
  }

  if (baseline.itemPresenceState === "present" && staged.itemPresenceState === "present") {
    const structureCountDelta =
      typeof baseline.itemStructureCount === "number" && typeof staged.itemStructureCount === "number" ? staged.itemStructureCount - baseline.itemStructureCount : null;
    const structureCountChanged = structureCountDelta !== null && structureCountDelta !== 0;

    let verdict: WallGapVerdict["verdict"] = "pass";
    if (boundary.shifted && structureCountChanged) verdict = "fail_both";
    else if (boundary.shifted) verdict = "fail_boundary_shifted";
    else if (structureCountChanged) verdict = "fail_structure_changed";

    return {
      verdict,
      boundaryShiftDetected: boundary.shifted,
      boundaryDelta: boundary.delta,
      boundaryQualifiedByNewObject,
      structureCountChanged,
      structureCountDelta,
      reason: `both sides present; ${boundaryReasonPart}; structure count: ${baseline.itemStructureCount}->${staged.itemStructureCount} (delta=${structureCountDelta}, changed=${structureCountChanged})`,
    };
  }

  // Remaining cases: staged occluded/cannot_tell, and/or baseline itself not
  // "present" -- item-presence gives no signal either way, so the boundary
  // shift (measurable independent of full item identification) is the only
  // possible signal. This is the Bedroom 02 path: staged "occluded" (new
  // furniture at the door's old spot, no trace), but the corner-to-boundary
  // distance shifted because the door genuinely relocated.
  if (boundary.shifted) {
    return {
      verdict: "fail_boundary_shifted",
      boundaryShiftDetected: true,
      boundaryDelta: boundary.delta,
      boundaryQualifiedByNewObject,
      structureCountChanged: false,
      structureCountDelta: null,
      reason: `item presence uncertain (staged=${staged.itemPresenceState}, baseline=${baseline.itemPresenceState}), but ${boundaryReasonPart}`,
    };
  }

  return {
    verdict: "inconclusive_occluded",
    boundaryShiftDetected: false,
    boundaryDelta: boundary.delta,
    boundaryQualifiedByNewObject,
    structureCountChanged: false,
    structureCountDelta: null,
    reason: `item presence uncertain (staged=${staged.itemPresenceState}, baseline=${baseline.itemPresenceState}) and boundary not evaluable or unchanged — defaulting to not-flagged: ${boundaryReasonPart}`,
  };
}
