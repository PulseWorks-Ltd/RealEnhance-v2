export function resolveStage2ImageModel(attempt: number): string {
  void attempt;
  return process.env.GROK_IMAGE_MODEL || "grok-imagine-image-quality";
}
