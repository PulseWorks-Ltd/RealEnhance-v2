// Door/walkthrough access-clearance check.
//
// GAP THIS CLOSES (RealEnhance validator-scope audit, 2026-08-29, finding
// H1): every opening check in this codebase validates PRESENCE — is the
// door/walkthrough still visible, unaltered, not covered. None validates
// FUNCTION — whether furniture placed during staging blocks the floor
// area a person needs to actually walk through the opening or swing the
// door open. This is not hypothetical: anchorLockedStaging.ts's own
// comments document a real, confirmed production case (Bedroom 12) where
// the anchor-locked bed-placement plan correctly identified a door-bearing
// wall as the only viable anchor wall, computed a genuine clear segment,
// and the prompt instructed the generation model to respect it — but the
// generated image still placed the bed's footprint across the doorway.
// That fix (computeDoorClearSegment + the "ANCHOR WALL — DOOR ACCESS
// REQUIREMENT" prompt block) is a generation-time instruction; nothing
// validates that Gemini actually complied with it. This check is
// deliberately independent of that anchor-locked, bedroom/study-only
// subsystem — it must catch the same failure class for ANY door or
// walkthrough in ANY room type, not only ones that went through anchor
// planning.
//
// SCOPE: doors and walkthroughs only — closet doors are deliberately
// excluded, mirroring the same judgment call already made in
// anchorLockedStaging.ts ("a closet door doesn't lead anywhere a person
// walks"): a closet with furniture in front of it is a normal, common
// staging choice (nobody needs continuous walk-in access to a closet the
// way they need to actually get through a doorway), not a functional
// failure. Sliding doors are NOT exempted here the way they are exempted
// from the PRESENCE check's floor-clearance expectation — that exemption
// is specifically about the door's own visual/structural presence not
// requiring floor clearance to be considered intact; it says nothing about
// whether the room's circulation past that location is blocked.
//
// DESIGN NOTE — HONESTY ABOUT MATURITY: every other check in this file
// family (occlusionVsRemovalCheck.ts's five questions, the flooring
// boundary check, the fabricated-opening/fixture checks) was hand-tuned
// against multiple real, captured production failures before shipping.
// This check has no such track record yet — it is new. Following this
// codebase's own established rollout discipline (see
// validatorModelCall.ts's newValidatorChecksBlocking history), it ships
// gated behind its own independent flag (doorAccessClearanceCheckBlocking,
// default false / advisory-only) rather than inheriting the blocking
// status already earned by the structurally different presence-checking
// family. It should be observed against real batches and have its prompt/
// classification refined against real captured cases — the same way every
// other check here reached its current, carefully-calibrated state —
// before being trusted to block jobs.
import type { StructuralOpening } from "./openingPreservationValidator";
import { buildSemanticReference, type PickedItem } from "./semanticItemRef";
import { callValidatorModel } from "./validatorModelCall";

const DOOR_ACCESS_CLEARANCE_CHECK_MODEL = String(process.env.WINDOW_ARTWORK_CHECK_MODEL || "gemini-2.5-pro");
const DOOR_ACCESS_CLEARANCE_CHECK_TIMEOUT_MS = Math.max(0, Number(process.env.WINDOW_ARTWORK_CHECK_TIMEOUT_MS || 30000));

// Circulation-implying openings only — the same category
// anchorLockedStaging.ts's own tier-4 "hasDoorOrWalkthrough" logic uses,
// for the same reason: a real door or walkthrough carries foot traffic
// into another space; a closet door does not.
const ACCESS_CLEARANCE_TYPE_APPLICABLE = new Set(["door", "walkthrough"]);
export function isDoorAccessClearanceCheckApplicable(itemType: string): boolean {
  return ACCESS_CLEARANCE_TYPE_APPLICABLE.has(String(itemType || "").toLowerCase());
}

export type DoorAccessClearanceObservation = {
  itemId: string;
  approachAreaDescription: string;
  accessBlocked: "yes" | "no" | "cannot_tell";
};

function buildBatchPrompt(items: { id: string; semanticRef: string }[]): string {
  const itemList = items.map((it) => `- itemId: "${it.id}" — find this item: ${it.semanticRef}`).join("\n");
  return `Below is a list of doors and walkthroughs from this room's baseline photo:

${itemList}

Look at THIS photo (only this one photo — the current/staged version) at EACH item's own immediate approach area — the floor space directly in front of the doorway, roughly as wide as the opening itself and extending out from it about one typical step, the space a person would need to actually walk through the opening or an outward/inward-swinging door would need to sweep through to open. Do not consider furniture elsewhere in the room, only what sits in that immediate approach area.

For EACH item listed above, answer:

1. approachAreaDescription — Describe concretely what occupies the immediate approach area in front of this doorway right now. Is it clear floor space, or does furniture (a bed, sofa, dresser, table, chair, or similar) sit across it? If something sits there, name what it is and roughly how much of the approach width it blocks — a small side table or a single chair pushed against the wall beside the opening, out of the direct path, is normal and does not by itself block access; a large piece of furniture whose own footprint crosses the doorway's threshold or swing path is what this question is asking about.
2. accessBlocked — Answer exactly one of: "yes" (a large piece of furniture's footprint crosses the doorway's own threshold or swing path, such that a person could not walk through, or an outward/inward-swinging door could not fully open, without first moving it), "no" (the approach area is clear, or only has something minor/out-of-the-way near it), "cannot_tell" (visibility too poor to judge, or the location is cropped out of frame).

Respond with ONLY a single valid JSON object:
{
  "items": [
    { "itemId": string, "approachAreaDescription": string, "accessBlocked": "yes" | "no" | "cannot_tell" }
  ]
}
One entry per item listed above, in the same order, matching itemId exactly.`;
}

export async function observeDoorAccessClearanceBatch(params: {
  imagePath: string;
  items: { id: string; semanticRef: string }[];
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<DoorAccessClearanceObservation[]> {
  const raw = await callValidatorModel({
    images: [{ path: params.imagePath, label: "Photo:" }],
    systemInstruction: "You are a careful visual inspector checking whether a room's staging arrangement is physically plausible.",
    userPrompt: buildBatchPrompt(params.items),
    model: DOOR_ACCESS_CLEARANCE_CHECK_MODEL,
    reasonPrefix: "door_access_clearance",
    timeoutMs: DOOR_ACCESS_CLEARANCE_CHECK_TIMEOUT_MS,
    ctx: params.ctx,
  });
  const stateEnum = ["yes", "no", "cannot_tell"];
  const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
  return items.map((it) => ({
    itemId: String(it?.itemId || ""),
    approachAreaDescription: typeof it?.approachAreaDescription === "string" ? it.approachAreaDescription : "",
    accessBlocked: stateEnum.includes(it?.accessBlocked) ? it.accessBlocked : "cannot_tell",
  }));
}

export type DoorAccessClearanceVerdict = {
  verdict: "fail_access_blocked" | "not_applicable" | "pass";
  reason: string;
};

// Pure, deterministic, offline-testable. "cannot_tell" deliberately passes
// rather than fails — the same asymmetric-default judgment
// classifyStructuralEvidence in occlusionVsRemovalCheck.ts uses for its own
// rescue signal: an ambiguous read should never be the sole basis for a
// hard-fail on a brand-new, uncalibrated check.
export function evaluateDoorAccessClearance(
  itemType: string,
  observation: Omit<DoorAccessClearanceObservation, "itemId">
): DoorAccessClearanceVerdict {
  if (!isDoorAccessClearanceCheckApplicable(itemType)) {
    return { verdict: "not_applicable", reason: `item type "${itemType}" is not a door or walkthrough — this check only applies to those` };
  }
  if (observation.accessBlocked === "yes") {
    return {
      verdict: "fail_access_blocked",
      reason: `furniture confirmed blocking this doorway's own threshold/swing path: "${observation.approachAreaDescription}"`,
    };
  }
  return {
    verdict: "pass",
    reason: `accessBlocked="${observation.accessBlocked}" — approach area not confirmed blocked: "${observation.approachAreaDescription}"`,
  };
}

export type DoorAccessClearanceItemResult = {
  itemId: string;
  type: string;
  description: string;
  verdict: DoorAccessClearanceVerdict["verdict"] | "error";
  reason: string;
};

// Orchestration — mirrors windowArtworkCheck.ts's runWindowArtworkCheckForOpenings
// and doorArtworkCheck.ts's runDoorArtworkCheckForOpenings exactly: filters
// to applicable-type openings, one batched call (skipped entirely if there
// are no doors/walkthroughs), evaluates each item via the pure function
// above. Wrapped in a single try/catch so any failure degrades to a safe
// "error" verdict for every item in this batch — never propagating to the
// caller's own Promise.all. Runs against the STAGED image only — there is
// no baseline comparison here, since the question is about the CURRENT
// staged arrangement's own physical plausibility, not a change from
// baseline (a room could legitimately have had furniture near a doorway in
// the baseline too; what matters is only whether the staged result itself
// leaves the doorway usable).
export async function runDoorAccessClearanceCheckForOpenings(
  openings: StructuralOpening[],
  stagedImagePath: string,
  ctx: { jobId: string; imageId: string; attempt?: number }
): Promise<DoorAccessClearanceItemResult[]> {
  const items = (openings || []).filter((o) => isDoorAccessClearanceCheckApplicable(o.type));
  if (items.length === 0) return [];

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
    const refs = items.map((it) => ({ id: it.id, semanticRef: buildSemanticReference(toPicked(it)) }));
    const observations = await observeDoorAccessClearanceBatch({
      imagePath: stagedImagePath,
      items: refs,
      ctx: { ...ctx, callLabel: "batch" },
    });
    const byId = new Map(observations.map((o) => [o.itemId, o]));
    return items.map((it) => {
      const obs =
        byId.get(it.id) ||
        ({ itemId: it.id, approachAreaDescription: "", accessBlocked: "cannot_tell" } as DoorAccessClearanceObservation);
      const verdict = evaluateDoorAccessClearance(it.type, obs);
      return { itemId: it.id, type: it.type, description: it.description || it.type, verdict: verdict.verdict, reason: verdict.reason };
    });
  } catch (e: any) {
    console.log(
      JSON.stringify({
        event: "NEW_VALIDATOR_CHECK_ERROR",
        check: "door_access_clearance",
        jobId: ctx.jobId,
        imageId: ctx.imageId,
        attempt: ctx.attempt,
        error: String(e?.message || e),
      })
    );
    return items.map((it) => ({ itemId: it.id, type: it.type, description: it.description || it.type, verdict: "error", reason: `check failed, degraded to non-blocking: ${String(e?.message || e)}` }));
  }
}
