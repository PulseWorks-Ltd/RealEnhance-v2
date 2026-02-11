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
  // Stage 1A must succeed for any charge
  if (!flags.stage1A) {
    return { amount: 0, reason: "stage1A_failed" };
  }

  // Exterior billing cap: always 1 credit
  if (flags.sceneType === "exterior") {
    return { amount: 1, reason: "exterior_cap" };
  }

  // Interior: 2 credits if both Stage 1B and Stage 2 succeeded
  if (flags.stage1B && flags.stage2) {
    return { amount: 2, reason: "interior_full_pipeline" };
  }

  // Otherwise 1 credit
  return { amount: 1, reason: "interior_partial_pipeline" };
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
  if (params.sceneType === "exterior") {
    return 1;
  }

  // Interior logic
  if (params.userSelectedStage1B && params.userSelectedStage2) {
    return 2;
  }

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
