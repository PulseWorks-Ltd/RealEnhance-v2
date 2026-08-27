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
//
// REVERTED (same session, hours later): briefly added a "sameAsBaseline"
// rescue that showed the model both the baseline and staged photo and asked
// "is this the same original item, even if it looks art-like" — intended to
// stop a real false-positive on an ambiguous, art-like curtain (2 Valentine
// St) that was genuinely preserved unaltered. Confirmed in real production
// within hours: the rescue was too permissive — a case where the curtain
// was actually replaced by a completely different framed painting got
// answered "yes, same as baseline" and passed on the first attempt. A false
// negative here (a fabricated window shipped as "validated") is categorically
// worse than the false positive it was meant to fix (one wasted retry), so
// this reverts to the original one-sided, stricter check rather than trying
// to further tune the rescue prompt under that risk asymmetry. If the
// ambiguous-curtain false positive needs solving, it should be solved via
// generation-time grounding (see anchorLockedStaging.ts's
// buildUniversalFeatureProtectionSection curtain-specific wording) or a
// stricter comparison mechanism than one text-based yes/no question — not by
// letting this specific check rescue itself.
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
};

function buildBatchPrompt(windows: { id: string; semanticRef: string }[]): string {
  const itemList = windows.map((w) => `- itemId: "${w.id}" — find this item: ${w.semanticRef}`).join("\n");
  return `Below is a list of windows from this room's baseline photo:

${itemList}

Look at THIS photo (only this one photo — the current/staged version) at EACH window's expected location, one at a time, independently.

For EACH window listed above, answer:

1. locationDescription — Describe concretely what is visible at that window's expected location in THIS photo right now. Do you see actual window elements (glass panes, a frame, a sill, blinds/curtains hung for an operable window), or does something else entirely occupy that same wall area? If something else occupies it, name specifically what it is (e.g. "a large framed abstract painting hangs there") and roughly how much of the window's expected footprint it covers.

2. artworkAtLocation — Answer exactly one of: "yes" (a framed picture, painting, canvas, or similar wall art occupies most/all of THAT window's own expected footprint — not merely present somewhere else in the room), "no" (the window's own glass/frame/sill is genuinely visible there, even if partially covered by ordinary curtains/blinds — those are normal window dressings, not artwork replacing the window), "cannot_tell" (visibility is too poor to judge, or the location is cropped out of frame).

Respond with ONLY a single valid JSON object:
{
  "windows": [
    { "itemId": string, "locationDescription": string, "artworkAtLocation": "yes" | "no" | "cannot_tell" }
  ]
}
One entry per window listed above, in the same order, matching itemId exactly.`;
}

export async function observeWindowArtworkReplacementBatch(params: {
  imagePath: string;
  windows: { id: string; semanticRef: string }[];
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<WindowArtworkObservation[]> {
  const raw = await callValidatorModel({
    images: [{ path: params.imagePath, label: "Photo:" }],
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
  }));
}

export type WindowArtworkVerdict = {
  verdict: "fail_window_replaced_by_artwork" | "not_applicable" | "pass";
  reason: string;
};

// Fabric/textile rescue for an ambiguous, art-like curtain (no visible rod
// or window frame — a real case, described even at baseline-extraction
// time as "hung like a valance"). The categorical artworkAtLocation
// question above genuinely cannot tell "this exact curtain, unaltered"
// apart from "replaced by real artwork": both read as "yes" from the
// staged photo alone, since the ambiguous item looks artwork-like whether
// or not anything actually changed (real production case, 2 Valentine St).
// An earlier same-day fix tried resolving this by showing the model both
// photos and asking "is this the same item, even though it may look
// art-like" — reverted after it rescued a genuine replacement in
// production, because that framing sits a premise directly next to the
// question ("this is a legitimate, expected case") for the model to
// simply agree with, the exact bias pattern occlusionVsRemovalCheck.ts's
// header documents and rebuilt its own design around.
//
// This is not that: no new question, no new image, no premise. It's a
// plain keyword check on the SAME free-text locationDescription the model
// already writes to answer the categorical question above. Across 3 real,
// independently-generated captures, the signal was completely clean: a
// genuine replacement described a rigid, framed object with zero fabric
// wording ("a large rectangular framed painting"), while two separate
// genuine-preservation captures of the same real curtain each
// independently used fabric/textile language ("a textured, possibly
// gathered, fabric" / "a draped textile") even while still correctly
// reading art-like overall.
const FABRIC_MATERIAL_SIGNAL = /\b(fabric|curtains?|drapes?|draped|drapery|gathered|textile|cloth|valance|sheer)\b/i;

// Pure, deterministic, offline-testable. Unconditional: fires independent
// of the general presence/occlusion logic elsewhere — that is the entire
// point of this rule.
export function evaluateWindowArtworkReplacement(itemType: string, observation: Omit<WindowArtworkObservation, "itemId">): WindowArtworkVerdict {
  if (!isWindowArtworkCheckApplicable(itemType)) {
    return { verdict: "not_applicable", reason: `item type "${itemType}" is not a window — this check only applies to windows` };
  }
  if (observation.artworkAtLocation === "yes") {
    if (FABRIC_MATERIAL_SIGNAL.test(observation.locationDescription)) {
      return { verdict: "pass", reason: `artworkAtLocation="yes" but the description still identifies the material as fabric/textile, not a rigid framed object — treated as the same ambiguous, art-like curtain/covering rather than a genuine replacement: "${observation.locationDescription}"` };
    }
    return { verdict: "fail_window_replaced_by_artwork", reason: `artwork confirmed occupying the window's own expected footprint, with no fabric/textile material identified in the description: "${observation.locationDescription}"` };
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
      imagePath: stagedImagePath,
      windows: windowRefs,
      ctx: { ...ctx, callLabel: "batch" },
    });
    const byId = new Map(observations.map((o) => [o.itemId, o]));
    return windows.map((w) => {
      const obs = byId.get(w.id) || { itemId: w.id, locationDescription: "", artworkAtLocation: "cannot_tell" as const };
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
