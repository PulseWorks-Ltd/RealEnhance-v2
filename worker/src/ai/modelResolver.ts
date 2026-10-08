export function resolveStage2ImageModel(attempt: number): string {
  void attempt;
  return (process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "").trim() || "gemini-2.5-flash-image";
}
