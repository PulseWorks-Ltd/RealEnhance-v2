export const ENHANCED_IMAGE_COMPLETION_TYPES = [
  "full_success",
  "fallback_1b",
  "fallback_1a",
  "intentional_1a_success",
  "optimized_1a_success",
] as const;

export type EnhancedImageCompletionType =
  (typeof ENHANCED_IMAGE_COMPLETION_TYPES)[number];

export function isEnhancedImageCompletionType(
  value: unknown,
): value is EnhancedImageCompletionType {
  return (
    typeof value === "string" &&
    ENHANCED_IMAGE_COMPLETION_TYPES.includes(
      value as EnhancedImageCompletionType,
    )
  );
}