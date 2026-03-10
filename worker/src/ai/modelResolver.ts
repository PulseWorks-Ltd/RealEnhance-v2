export function resolveStage2ImageModel(attempt: number): string {
  if (attempt <= 2) {
    return "gemini-2.5-flash-image";
  }

  return attempt % 2 === 0
    ? "gemini-2.5-flash-image"
    : "gemini-3.1-flash-image";
}
