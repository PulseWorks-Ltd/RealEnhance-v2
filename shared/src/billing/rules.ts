import type { EnhancedImageCompletionType } from "../completionTypes";

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
}

/**
 * Compute charge based on stage success flags and scene type
 * 
 * Rules:
 * - if !stage1A_success → charge = 0
 * - else if sceneType == "exterior" → charge = 1 (billing cap)
 * - else if stage1B_success && stage2_success → charge = 2
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

  return { amount: 1, reason: "flat_one_image_model" };
}

/**
 * Estimate credit cost before job submission
 * 
 * Rules:
 * - if sceneType == exterior → return 1
 * - if interior:
 *   - if userSelectedStage1B && userSelectedStage2 → return 2
 *   - else → return 1
 * 
 * Does NOT call Gemini - uses sceneType + user selections only
 */
export function estimateCredits(params: {
  sceneType: string;
  userSelectedStage1B: boolean; // declutter enabled
  userSelectedStage2: boolean; // virtual staging enabled
}): number {
  return 1;
}

/**
 * Estimate total credits for a batch of images
 */
export function estimateBatchCredits(
  images: Array<{
    sceneType: string;
    userSelectedStage1B: boolean;
    userSelectedStage2: boolean;
  }>
): number {
  return images.reduce((sum, img) => {
    return sum + estimateCredits(img);
  }, 0);
}
