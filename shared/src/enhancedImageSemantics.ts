import type { EnhancedImageCompletionType } from "./completionTypes";

export const ENHANCED_IMAGE_USER_OUTCOMES = [
  "success",
  "partial_success",
  "failed",
] as const;

export const ENHANCED_IMAGE_EXECUTION_MODES = [
  "full_pipeline",
  "fallback_1b",
  "fallback_1a",
  "intentional_1a",
  "optimized_1a",
  "stage2_repair",
] as const;

export const ENHANCED_IMAGE_PERSISTENCE_STATUSES = [
  "recorded",
  "recorded_with_warnings",
  "pending_repair",
] as const;

export type EnhancedImageUserOutcome =
  (typeof ENHANCED_IMAGE_USER_OUTCOMES)[number];
export type EnhancedImageExecutionMode =
  (typeof ENHANCED_IMAGE_EXECUTION_MODES)[number];
export type EnhancedImagePersistenceStatus =
  (typeof ENHANCED_IMAGE_PERSISTENCE_STATUSES)[number];

const COMPLETION_TO_EXECUTION_MODE: Record<
  EnhancedImageCompletionType,
  Exclude<EnhancedImageExecutionMode, "stage2_repair">
> = {
  full_success: "full_pipeline",
  fallback_1b: "fallback_1b",
  fallback_1a: "fallback_1a",
  intentional_1a_success: "intentional_1a",
  optimized_1a_success: "optimized_1a",
};

const EXECUTION_MODE_TO_COMPLETION: Partial<
  Record<EnhancedImageExecutionMode, EnhancedImageCompletionType>
> = {
  full_pipeline: "full_success",
  fallback_1b: "fallback_1b",
  fallback_1a: "fallback_1a",
  intentional_1a: "intentional_1a_success",
  optimized_1a: "optimized_1a_success",
};

export function isEnhancedImageUserOutcome(
  value: unknown,
): value is EnhancedImageUserOutcome {
  return (
    typeof value === "string" &&
    ENHANCED_IMAGE_USER_OUTCOMES.includes(value as EnhancedImageUserOutcome)
  );
}

export function isEnhancedImageExecutionMode(
  value: unknown,
): value is EnhancedImageExecutionMode {
  return (
    typeof value === "string" &&
    ENHANCED_IMAGE_EXECUTION_MODES.includes(value as EnhancedImageExecutionMode)
  );
}

export function isEnhancedImagePersistenceStatus(
  value: unknown,
): value is EnhancedImagePersistenceStatus {
  return (
    typeof value === "string" &&
    ENHANCED_IMAGE_PERSISTENCE_STATUSES.includes(
      value as EnhancedImagePersistenceStatus,
    )
  );
}

export function deriveUserOutcomeFromCompletionType(
  completionType?: EnhancedImageCompletionType | null,
): EnhancedImageUserOutcome {
  if (completionType === "fallback_1a") return "partial_success";
  return "success";
}

export function deriveExecutionModeFromCompletionType(
  completionType?: EnhancedImageCompletionType | null,
): EnhancedImageExecutionMode {
  if (!completionType) return "full_pipeline";
  return COMPLETION_TO_EXECUTION_MODE[completionType] || "full_pipeline";
}

export function deriveLegacyCompletionTypeFromExecutionMode(
  executionMode?: EnhancedImageExecutionMode | null,
): EnhancedImageCompletionType {
  if (!executionMode) return "full_success";
  return EXECUTION_MODE_TO_COMPLETION[executionMode] || "full_success";
}