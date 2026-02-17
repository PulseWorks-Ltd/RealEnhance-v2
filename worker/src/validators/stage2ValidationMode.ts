export type Stage2ValidationMode = "REFRESH_OR_DIRECT" | "FULL_AFTER_FULL_REMOVAL";

export function getStage2ValidationModeFromPromptMode(mode: "refresh" | "full"): Stage2ValidationMode {
  return mode === "full" ? "FULL_AFTER_FULL_REMOVAL" : "REFRESH_OR_DIRECT";
}
