export type Stage2ValidationMode = "REFRESH_OR_DIRECT" | "FULL_STAGE_ONLY";

export function getStage2ValidationModeFromPromptMode(mode: "refresh" | "full"): Stage2ValidationMode {
  return mode === "full" ? "FULL_STAGE_ONLY" : "REFRESH_OR_DIRECT";
}
