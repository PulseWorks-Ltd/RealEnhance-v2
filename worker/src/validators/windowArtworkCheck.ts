// Window-replaced-by-artwork check. A window's own expected location now
// occupied by hung artwork/a painting is never a legitimate staging
// outcome — deliberately NOT routed through the general occlusion-vs-
// removal logic in occlusionVsRemovalCheck.ts, since that logic correctly
// (and deliberately) classifies a covered-but-structurally-intact opening
// as "occluded", not altered, to avoid a false-positive pattern confirmed
// elsewhere in this codebase (a real, confirmed case: a window fully
// replaced by a hung painting read as "occluded" and therefore not failed).
// This check is a direct, hard-coded implausibility override that fires
// regardless of whether the window can otherwise be confirmed present/
// occluded/absent by the standard check.
//
// Ported from tmp/implausibleStagingCheck.ts (Part B only — Part C,
// artwork-on-door-surface, is not part of this integration). Restructured
// from a per-window call into ONE call covering every window in the room at
// once, mirroring occlusionVsRemovalCheck.ts's runOcclusionObservationCall
// pattern (all openings examined in a single prompt) — a room typically has
// 0-3 windows, so this keeps the check's cost to a single call per attempt
// regardless of window count, rather than one call per window.
import type { StructuralOpening } from "./openingPreservationValidator";
import { buildSemanticReference, type PickedItem } from "./semanticItemRef";
import { callValidatorModel } from "./validatorModelCall";

const WINDOW_ARTWORK_CHECK_MODEL = String(process.env.WINDOW_ARTWORK_CHECK_MODEL || "gemini-2.5-pro");
const WINDOW_ARTWORK_CHECK_TIMEOUT_MS = Math.max(0, Number(process.env.WINDOW_ARTWORK_CHECK_TIMEOUT_MS || 30000));

export function isWindowArtworkCheckApplicable(itemType: string): boolean {
  return String(itemType || "").toLowerCase() === "window";
}

export type WindowArtworkObservation = {
  itemId: string;
  locationDescription: string;
  artworkAtLocation: "yes" | "no" | "cannot_tell";
  // Rescue signal for ambiguous-by-nature items (e.g. a small gathered
  // curtain with no visible rod/window frame, which legitimately looks
  // art-like even when completely unaltered — confirmed real case: 2
  // Valentine St / Kitchen 01, both preserving the original curtain pixel-
  // for-pixel yet independently reading as "framed abstract artwork" from
  // the staged photo alone, since this check was originally one-sided
  // (staged photo only, no baseline to compare against). Comparing against
  // the baseline photo directly answers "is this the same object as
  // before" — a strictly narrower, more reliable signal than re-judging
  // "does this look like artwork" a second time.
  sameAsBaseline: "yes" | "no" | "cannot_tell";
};

function buildBatchPrompt(windows: { id: string; semanticRef: string }[]): string {
  const itemList = windows.map((w) => `- itemId: "${w.id}" — find this item: ${w.semanticRef}`).join("\n");
  return `You are given TWO photos of the same room: the ORIGINAL (baseline, unstaged) photo, then the STAGED (current) photo.

Below is a list of windows from this room's baseline photo:

${itemList}

Look at EACH window's expected location, one at a time, independently, comparing the same location across both photos.

For EACH window listed above, answer:

1. locationDescription — Describe concretely what is visible at that window's expected location in the STAGED photo right now. Do you see actual window elements (glass panes, a frame, a sill, blinds/curtains hung for an operable window), or does something else entirely occupy that same wall area? If something else occupies it, name specifically what it is (e.g. "a large framed abstract painting hangs there") and roughly how much of the window's expected footprint it covers.

2. artworkAtLocation — Answer exactly one of: "yes" (a framed picture, painting, canvas, or similar wall art occupies most/all of THAT window's own expected footprint — not merely present somewhere else in the room), "no" (the window's own glass/frame/sill is genuinely visible there, even if partially covered by ordinary curtains/blinds — those are normal window dressings, not artwork replacing the window), "cannot_tell" (visibility is too poor to judge, or the location is cropped out of frame).

3. sameAsBaseline — Now compare this exact same wall location in the ORIGINAL baseline photo. Is the object visible at this location in the STAGED photo the SAME physical item as what is shown at this location in the ORIGINAL photo — same fabric/material, same pattern or color, same general shape and position — even if, taken on its own, it happens to look like it could be wall art (a real, legitimate case: a small gathered curtain with no visible rod or window frame around it can look art-like by its own nature, in both the original and staged photo, while being completely unaltered)? Answer "yes" only if it is clearly the same original item, unaltered, carried over from the baseline photo. Answer "no" if this is a different, new item not present at this location in the baseline photo. Answer "cannot_tell" if the baseline photo's view of this location is unclear or cropped out.

Respond with ONLY a single valid JSON object:
{
  "windows": [
    { "itemId": string, "locationDescription": string, "artworkAtLocation": "yes" | "no" | "cannot_tell", "sameAsBaseline": "yes" | "no" | "cannot_tell" }
  ]
}
One entry per window listed above, in the same order, matching itemId exactly.`;
}

export async function observeWindowArtworkReplacementBatch(params: {
  baselineImagePath: string;
  imagePath: string;
  windows: { id: string; semanticRef: string }[];
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<WindowArtworkObservation[]> {
  const raw = await callValidatorModel({
    images: [
      { path: params.baselineImagePath, label: "ORIGINAL (baseline) Photo:" },
      { path: params.imagePath, label: "STAGED (current) Photo:" },
    ],
    systemInstruction: "You are a careful visual inspector checking whether a room's staging arrangement is physically plausible.",
    userPrompt: buildBatchPrompt(params.windows),
    model: WINDOW_ARTWORK_CHECK_MODEL,
    reasonPrefix: "window_artwork",
    timeoutMs: WINDOW_ARTWORK_CHECK_TIMEOUT_MS,
    ctx: params.ctx,
  });
  const stateEnum = ["yes", "no", "cannot_tell"];
  const items: any[] = Array.isArray(raw?.windows) ? raw.windows : [];
  return items.map((it) => ({
    itemId: String(it?.itemId || ""),
    locationDescription: typeof it?.locationDescription === "string" ? it.locationDescription : "",
    artworkAtLocation: stateEnum.includes(it?.artworkAtLocation) ? it.artworkAtLocation : "cannot_tell",
    sameAsBaseline: stateEnum.includes(it?.sameAsBaseline) ? it.sameAsBaseline : "cannot_tell",
  }));
}

export type WindowArtworkVerdict = {
  verdict: "fail_window_replaced_by_artwork" | "not_applicable" | "pass";
  reason: string;
};

// Pure, deterministic, offline-testable. Unconditional: fires independent
// of the general presence/occlusion logic elsewhere — that is the entire
// point of this rule.
export function evaluateWindowArtworkReplacement(itemType: string, observation: Omit<WindowArtworkObservation, "itemId">): WindowArtworkVerdict {
  if (!isWindowArtworkCheckApplicable(itemType)) {
    return { verdict: "not_applicable", reason: `item type "${itemType}" is not a window — this check only applies to windows` };
  }
  if (observation.artworkAtLocation === "yes") {
    if (observation.sameAsBaseline === "yes") {
      return { verdict: "pass", reason: `artworkAtLocation="yes" but sameAsBaseline="yes" — this is the same original item carried over unaltered from the baseline photo, not a replacement, even though it independently reads as artwork-like: "${observation.locationDescription}"` };
    }
    return { verdict: "fail_window_replaced_by_artwork", reason: `artwork confirmed occupying the window's own expected footprint, and not confirmed to be the same original item from the baseline photo (sameAsBaseline="${observation.sameAsBaseline}"): "${observation.locationDescription}"` };
  }
  return { verdict: "pass", reason: `artworkAtLocation="${observation.artworkAtLocation}" — not confirmed artwork at the window's own location: "${observation.locationDescription}"` };
}

export type WindowArtworkItemResult = {
  itemId: string;
  type: string;
  description: string;
  verdict: WindowArtworkVerdict["verdict"] | "error";
  reason: string;
};

// Orchestration: filters to window-type openings, issues ONE batched call
// (skipped entirely if there are no windows), evaluates each item's verdict
// via the pure function above. The whole call is wrapped in a single
// try/catch so any failure (API error, timeout, malformed JSON) degrades to
// a safe "error" verdict for every window in this batch — never propagating
// to the caller's own Promise.all (see openingEnvelopeValidator.ts).
export async function runWindowArtworkCheckForOpenings(
  openings: StructuralOpening[],
  baselineImagePath: string,
  stagedImagePath: string,
  ctx: { jobId: string; imageId: string; attempt?: number }
): Promise<WindowArtworkItemResult[]> {
  const windows = (openings || []).filter((o) => isWindowArtworkCheckApplicable(o.type));
  if (windows.length === 0) return [];

  const toPicked = (o: StructuralOpening): PickedItem => ({
    id: o.id,
    type: o.type,
    description: o.description,
    wallIndex: o.wallIndex,
    horizontalBand: o.horizontalBand,
    verticalBand: o.verticalBand,
    bbox: o.bbox,
  });

  try {
    const windowRefs = windows.map((w) => ({ id: w.id, semanticRef: buildSemanticReference(toPicked(w)) }));
    const observations = await observeWindowArtworkReplacementBatch({
      baselineImagePath,
      imagePath: stagedImagePath,
      windows: windowRefs,
      ctx: { ...ctx, callLabel: "batch" },
    });
    const byId = new Map(observations.map((o) => [o.itemId, o]));
    return windows.map((w) => {
      const obs = byId.get(w.id) || { itemId: w.id, locationDescription: "", artworkAtLocation: "cannot_tell" as const, sameAsBaseline: "cannot_tell" as const };
      const verdict = evaluateWindowArtworkReplacement(w.type, obs);
      return { itemId: w.id, type: w.type, description: w.description || w.type, verdict: verdict.verdict, reason: verdict.reason };
    });
  } catch (e: any) {
    console.log(
      JSON.stringify({
        event: "NEW_VALIDATOR_CHECK_ERROR",
        check: "window_artwork",
        jobId: ctx.jobId,
        imageId: ctx.imageId,
        attempt: ctx.attempt,
        error: String(e?.message || e),
      })
    );
    return windows.map((w) => ({ itemId: w.id, type: w.type, description: w.description || w.type, verdict: "error", reason: `check failed, degraded to non-blocking: ${String(e?.message || e)}` }));
  }
}
