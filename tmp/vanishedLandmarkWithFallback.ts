// Targeted refinement, not a new design. Composes two already-tested,
// UNMODIFIED modules from tonight's earlier tasks:
//   - vanishedLandmarkCheck.ts (strict same-landmark reconfirmation —
//     proved reliable for the vanish-check itself: Bedroom 12 1/3 -> 3/3,
//     zero false positives on clean controls. Left completely untouched.)
//   - relativeLandmarkResizeCheck.ts (Part 2's freely-chosen-landmark
//     mechanism — the thing that let Bedroom 09 hit 3/3 before the strict
//     reconfirmation requirement was added. Also left completely untouched.)
//
// The only new code here is the DECISION of which one to trust for the
// extent/position comparison, per explicit spec:
//   - either landmark confirmed "no"            -> fail_vanished_landmark, conclusive (strict path, unchanged)
//   - both landmarks confirmed "yes"             -> normal strict comparison (unchanged)
//   - a landmark is "cannot_tell" (out of frame) -> NOT a discard; fall back
//     to a fresh, freely-chosen landmark selection (Part 2's mechanism) for
//     the extent/position comparison ONLY. A confirmed "no" always
//     short-circuits to the conclusive fail before the fallback is even
//     considered — the fallback only ever triggers on genuine ambiguity
//     (cannot_tell), never on a confirmed absence.
import { observeLandmarkChoice, observeLandmarkConfirmation, compareVanishedLandmarkObservations, type LandmarkChoiceObservation, type LandmarkConfirmationObservation, type VanishedLandmarkVerdict } from "./vanishedLandmarkCheck";
import { observeRelativeLandmark, compareRelativeLandmarkObservations, type RelativeLandmarkObservation, type RelativeLandmarkVerdict } from "./relativeLandmarkResizeCheck";

export type CombinedVerdict = {
  verdict: "fail_vanished_landmark" | "fail_resized" | "fail_repositioned" | "fail_resized_fallback" | "fail_repositioned_fallback" | "pass";
  usedFallback: boolean;
  reason: string;
};

// Pure, offline-testable combine step — given an already-computed strict
// verdict (from the unmodified compareVanishedLandmarkObservations) and an
// optional fallback verdict (from the unmodified compareRelativeLandmarkObservations),
// decide the final outcome. No I/O, no model calls.
export function combineWithFallback(strict: VanishedLandmarkVerdict, fallback: RelativeLandmarkVerdict | null): CombinedVerdict {
  if (strict.verdict !== "inconclusive_occluded") {
    // Either a confirmed "no" (conclusive fail, short-circuits before any
    // fallback is even attempted) or both landmarks "yes" (normal strict
    // comparison) — both cases pass through completely unchanged from the
    // last task's behavior.
    return {
      verdict: strict.verdict as CombinedVerdict["verdict"],
      usedFallback: false,
      reason: `strict path resolved directly (${strict.verdict}): ${strict.reason}`,
    };
  }

  if (!fallback) {
    return { verdict: "pass", usedFallback: true, reason: "strict was inconclusive_occluded but no fallback observation was supplied — defaulting to pass (safe default)" };
  }

  if (!fallback.comparable) {
    return {
      verdict: "pass",
      usedFallback: true,
      reason: `fallback's freely-chosen substitute landmark also not comparable to baseline's (${fallback.reason}) — defaulting to pass, same safe-default philosophy as every ambiguous case tonight`,
    };
  }

  const verdict: CombinedVerdict["verdict"] = fallback.resized ? "fail_resized_fallback" : fallback.repositioned ? "fail_repositioned_fallback" : "pass";
  return {
    verdict,
    usedFallback: true,
    reason: `strict path inconclusive (original landmark out of frame in staged photo), fallback with a freshly, freely-chosen substitute landmark used instead: ${fallback.reason}`,
  };
}

export async function runVanishedLandmarkWithFallback(params: {
  baselinePath: string;
  stagedPath: string;
  semanticRef: string;
  ctx: { jobId: string; imageId: string };
}): Promise<{
  baselineChoice: LandmarkChoiceObservation;
  stagedConfirm: LandmarkConfirmationObservation;
  stagedFallbackChoice: RelativeLandmarkObservation | null;
  strictVerdict: VanishedLandmarkVerdict;
  fallbackVerdict: RelativeLandmarkVerdict | null;
  combined: CombinedVerdict;
}> {
  const baselineChoice = await observeLandmarkChoice({
    imagePath: params.baselinePath,
    semanticRef: params.semanticRef,
    ctx: { ...params.ctx, callLabel: "baseline_choice" },
  });
  const stagedConfirm = await observeLandmarkConfirmation({
    imagePath: params.stagedPath,
    semanticRef: params.semanticRef,
    primaryLandmark: baselineChoice.primaryLandmark,
    secondLandmark: baselineChoice.secondLandmark,
    ctx: { ...params.ctx, callLabel: "staged_confirm" },
  });

  const strictVerdict = compareVanishedLandmarkObservations(baselineChoice, stagedConfirm);

  let stagedFallbackChoice: RelativeLandmarkObservation | null = null;
  let fallbackVerdict: RelativeLandmarkVerdict | null = null;
  if (strictVerdict.verdict === "inconclusive_occluded") {
    stagedFallbackChoice = await observeRelativeLandmark({
      imagePath: params.stagedPath,
      semanticRef: params.semanticRef,
      ctx: { ...params.ctx, callLabel: "staged_fallback_free_choice" },
    });
    fallbackVerdict = compareRelativeLandmarkObservations(baselineChoice, stagedFallbackChoice);
  }

  const combined = combineWithFallback(strictVerdict, fallbackVerdict);
  return { baselineChoice, stagedConfirm, stagedFallbackChoice, strictVerdict, fallbackVerdict, combined };
}
