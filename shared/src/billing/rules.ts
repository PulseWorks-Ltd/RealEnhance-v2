import type { EnhancedImageCompletionType } from "../completionTypes";

/**
 * STAGE1A_EXTERIOR_OUTLOOK=on shows the "Enhance Exterior Outlook" option and
 * lets the worker use it. Default off. Set it the same on server and worker.
 */
export function exteriorOutlookEnabled(): boolean {
  const raw = typeof process !== "undefined" ? process.env?.STAGE1A_EXTERIOR_OUTLOOK : undefined;
  return ["1", "true", "on", "yes"].includes(String(raw || "").trim().toLowerCase());
}

/**
 * BILLING_DECLUTTER_STAGE_EXTRA_CREDIT=on turns on "staged image = 2 credits":
 * an image that comes back staged (with or without declutter) costs 2
 * credits; enhance only, or enhance + declutter, costs 1; exteriors cost 1.
 * Default off: every image costs 1 credit, whatever processing is requested.
 * (The name is historical — it used to charge 2 only for declutter + stage.)
 * Must be set the same on the server and the worker.
 */
export function declutterStageExtraCreditEnabled(): boolean {
  const raw = typeof process !== "undefined" ? process.env?.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT : undefined;
  return ["1", "true", "on", "yes"].includes(String(raw || "").trim().toLowerCase());
}

/** Credits for one delivered image when it is staged (switch on) — kept in one place. */
export const STAGED_IMAGE_CREDITS = 2;

/**
 * The credits actually taken for one finished image (the worker's charge).
 * - nothing billable delivered (failure, refund, free manual retry) -> 0
 * - switch on, interior, staged image delivered -> 2, but never more than
 *   was quoted before submit (a job quoted 1 by an older client stays 1)
 * - otherwise -> 1
 */
export function deliveredImageCharge(params: {
  billable: boolean;
  sceneType: string;
  stagedDelivered: boolean;
  quotedCredits?: number | null;
}): number {
  if (!params.billable) return 0;
  if (String(params.sceneType || "").toLowerCase() === "exterior") return 1;
  if (!declutterStageExtraCreditEnabled() || !params.stagedDelivered) return 1;
  const quoted = Number(params.quotedCredits);
  if (Number.isFinite(quoted) && quoted > 0 && quoted < STAGED_IMAGE_CREDITS) return Math.max(1, Math.floor(quoted));
  return STAGED_IMAGE_CREDITS;
}

/**
 * Billing Finalization - Pure Functions
 * 
 * Stage-based billing rules for finalize-at-end credit deduction
 * These are pure functions with no side effects
 */

export interface StageFlags {
  stage1A: boolean;
  stage1B: boolean;
  stage2: boolean;
  sceneType: string; // "interior" | "exterior"
  /** Final output classification written to history metadata. */
  completionType?: EnhancedImageCompletionType;
  /** Final stage delivered to the user (1A | 1B | 2). */
  finalDeliveredStage?: "1A" | "1B" | "2";
  /** True when user requested enhancement beyond Stage 1A. */
  requestedBeyond1A?: boolean;
  /** Whether the user explicitly selected declutter/Stage1B before submission.
   * Optional for backward compatibility — existing callers that omit it retain prior behaviour.
   */
  stage1BUserSelected?: boolean;
  /** Whether Gemini confirmed hasFurniture=true during the routing gate.
   * Optional for backward compatibility.
   */
  geminiHasFurniture?: boolean;
  /** Whether declutter + stage is billable at 2 credits for this image: the
   * furniture pre-check found the room furnished and 2 credits were quoted
   * before submit. When omitted, the user's declutter selection decides.
   */
  declutterAndStageBillable?: boolean;
}

/**
 * Compute charge based on stage success flags and scene type
 * 
 * Rules:
 * - if !stage1A_success → charge = 0
 * - else if sceneType == "exterior" → charge = 1
 * - else if interior fell back to 1A after asking for more → charge = 0 (refund)
 * - else if the switch is on and the staged image was delivered → charge = 2
 * - else → charge = 1
 */
export function computeCharge(flags: StageFlags): { amount: number; reason: string } {
  if (!flags.stage1A) {
    return { amount: 0, reason: "stage1A_failed" };
  }

  const sceneType = String(flags.sceneType || "").toLowerCase();
  const completionType = flags.completionType;
  const finalDeliveredStage = flags.finalDeliveredStage;
  const requestedBeyond1A = flags.requestedBeyond1A === true;

  // Exterior is intentionally Stage-1A-only today; successful output remains billable.
  if (sceneType === "exterior") {
    return { amount: 1, reason: "flat_one_image_model" };
  }

  // Interior fallback to Stage-1A is refundable ONLY when user asked for >1A enhancement
  // AND the terminal state is a true downstream failure (not intentional or detector-optimized).
  // intentional_1a_success: user explicitly chose Enhance Only → billable
  // optimized_1a_success:   detector confirmed empty room → billable (successful optimization)
  if (
    (completionType === "fallback_1a" || finalDeliveredStage === "1A") &&
    requestedBeyond1A &&
    completionType !== "intentional_1a_success" &&
    completionType !== "optimized_1a_success"
  ) {
    return { amount: 0, reason: "interior_fallback_1a_refund" };
  }

  // Staged image: 2 credits when the switch is on and the staged image was
  // delivered (with or without declutter). Staging that fell back to the
  // decluttered image costs 1; one that fell back to 1A is refunded above.
  if (declutterStageExtraCreditEnabled() && flags.stage2 && (flags.finalDeliveredStage === undefined || flags.finalDeliveredStage === "2")) {
    return { amount: STAGED_IMAGE_CREDITS, reason: "staged_image" };
  }

  return { amount: 1, reason: "flat_one_image_model" };
}

/**
 * Estimate credit cost before job submission (the quote).
 * - exterior → 1
 * - switch on, interior, staging chosen → 2 (with or without declutter)
 * - else → 1
 *
 * Does NOT call Gemini - uses sceneType + user selections only.
 * userSelectedStage1B no longer changes the price; it is kept so existing
 * callers compile.
 */
export function estimateCredits(params: {
  sceneType: string;
  userSelectedStage1B?: boolean;
  userSelectedStage2: boolean; // virtual staging enabled
}): number {
  const sceneType = String(params.sceneType || "").toLowerCase();
  if (sceneType === "exterior") return 1;
  if (!declutterStageExtraCreditEnabled()) return 1;
  return params.userSelectedStage2 ? STAGED_IMAGE_CREDITS : 1;
}

/**
 * Credits to reserve for a stored job (resume, awaiting-payment release,
 * requeue). The quote made at upload wins; jobs without one (older clients)
 * use the same rule as the upload quote.
 */
export function requiredCreditsForJobOptions(options: any): number {
  if (!declutterStageExtraCreditEnabled()) return 1;
  const quoted = Number(options?.quotedCredits);
  if (Number.isFinite(quoted) && quoted >= 1) return Math.min(STAGED_IMAGE_CREDITS, Math.floor(quoted));
  return estimateCredits({
    sceneType: String(options?.sceneType || "").toLowerCase() === "exterior" ? "exterior" : "interior",
    userSelectedStage2: !!options?.virtualStage,
  });
}

/**
 * Estimate total credits for a batch of images
 */
export function estimateBatchCredits(
  images: Array<{
    sceneType: string;
    userSelectedStage1B?: boolean;
    userSelectedStage2: boolean;
  }>
): number {
  return images.reduce((sum, img) => {
    return sum + estimateCredits(img);
  }, 0);
}
