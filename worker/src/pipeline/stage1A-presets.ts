export interface AblationSettings {
  STAGE1A_ENABLE_PRESERVATION_PREGEN: boolean;
  STAGE1A_PREGEN_NORMALIZE_ENABLED: boolean;
  STAGE1A_PREGEN_TONE_STACK_SCALE: number;
  STAGE1A_PREGEN_LOCAL_CONTRAST_SCALE: number;
  STAGE1A_PREGEN_MEDIAN_ENABLED: boolean;
  STAGE1A_ENABLE_POSTGEN_FINISH: boolean;
  PREPROCESS_CANONICAL_HIGH_FIDELITY: boolean;
  PREPROCESS_CANONICAL_WEBP_QUALITY: number;
  STAGE1A_PREGEN_SHARPEN_ENABLED: boolean;
  STAGE1A_PREGEN_SHARPEN_SCALE: number;
  STAGE1A_PREGEN_SHADOW_OFFSET_SCALE: number;
  STAGE1A_PREGEN_MODULATE_SCALE: number;
  STAGE1A_PREGEN_HIGH_FIDELITY_ENCODE: boolean;
}

export const AblationPresets: Record<string, AblationSettings> = {
  production: {
    STAGE1A_ENABLE_PRESERVATION_PREGEN: false,
    STAGE1A_PREGEN_NORMALIZE_ENABLED: true,
    STAGE1A_PREGEN_TONE_STACK_SCALE: 1,
    STAGE1A_PREGEN_LOCAL_CONTRAST_SCALE: 1,
    STAGE1A_PREGEN_MEDIAN_ENABLED: true,
    STAGE1A_ENABLE_POSTGEN_FINISH: false,
    PREPROCESS_CANONICAL_HIGH_FIDELITY: false,
    PREPROCESS_CANONICAL_WEBP_QUALITY: 95,
    STAGE1A_PREGEN_SHARPEN_ENABLED: true,
    STAGE1A_PREGEN_SHARPEN_SCALE: 1,
    STAGE1A_PREGEN_SHADOW_OFFSET_SCALE: 1,
    STAGE1A_PREGEN_MODULATE_SCALE: 1,
    STAGE1A_PREGEN_HIGH_FIDELITY_ENCODE: false,
  },

  // Target: Fixes chalky white walls and dead carpet in dark interiors.
  "interior-open-ambient": {
    STAGE1A_ENABLE_PRESERVATION_PREGEN: true,
    STAGE1A_PREGEN_NORMALIZE_ENABLED: false,
    STAGE1A_PREGEN_TONE_STACK_SCALE: 0.6,
    STAGE1A_PREGEN_LOCAL_CONTRAST_SCALE: 0.45,
    STAGE1A_PREGEN_MEDIAN_ENABLED: false,
    STAGE1A_ENABLE_POSTGEN_FINISH: true,
    PREPROCESS_CANONICAL_HIGH_FIDELITY: true,
    PREPROCESS_CANONICAL_WEBP_QUALITY: 95,
    STAGE1A_PREGEN_SHARPEN_ENABLED: false,
    STAGE1A_PREGEN_SHARPEN_SCALE: 0.7,
    STAGE1A_PREGEN_SHADOW_OFFSET_SCALE: 0.4,
    STAGE1A_PREGEN_MODULATE_SCALE: 0.8,
    STAGE1A_PREGEN_HIGH_FIDELITY_ENCODE: true,
  },

  // Target: Mixed-light exteriors with deep lawn shadows and reflective glazing.
  "exterior-nz-hero": {
    STAGE1A_ENABLE_PRESERVATION_PREGEN: true,
    STAGE1A_PREGEN_NORMALIZE_ENABLED: false,
    STAGE1A_PREGEN_TONE_STACK_SCALE: 1.05,
    STAGE1A_PREGEN_LOCAL_CONTRAST_SCALE: 0.95,
    STAGE1A_PREGEN_MEDIAN_ENABLED: false,
    STAGE1A_ENABLE_POSTGEN_FINISH: true,
    PREPROCESS_CANONICAL_HIGH_FIDELITY: true,
    PREPROCESS_CANONICAL_WEBP_QUALITY: 98,
    STAGE1A_PREGEN_SHARPEN_ENABLED: false,
    STAGE1A_PREGEN_SHARPEN_SCALE: 0.6,
    STAGE1A_PREGEN_SHADOW_OFFSET_SCALE: 0.5,
    STAGE1A_PREGEN_MODULATE_SCALE: 0.92,
    STAGE1A_PREGEN_HIGH_FIDELITY_ENCODE: true,
  },
};

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeScene(sceneType?: string): "interior" | "exterior" | "other" {
  if (sceneType === "interior") return "interior";
  if (sceneType === "exterior") return "exterior";
  return "other";
}

function resolvePresetName(sceneType?: string): string {
  const scene = normalizeScene(sceneType);
  const mode = (process.env.STAGE1A_PRESET_MODE || "off").trim().toLowerCase();

  const explicit = process.env.STAGE1A_ABLATION_PRESET?.trim();
  if (explicit && AblationPresets[explicit]) {
    return explicit;
  }

  const sceneSpecific = scene === "interior"
    ? process.env.STAGE1A_ABLATION_PRESET_INTERIOR?.trim()
    : scene === "exterior"
      ? process.env.STAGE1A_ABLATION_PRESET_EXTERIOR?.trim()
      : undefined;
  if (sceneSpecific && AblationPresets[sceneSpecific]) {
    return sceneSpecific;
  }

  if (mode === "scene-auto") {
    if (scene === "interior") return "interior-open-ambient";
    if (scene === "exterior") return "exterior-nz-hero";
  }

  return "production";
}

export function resolveStage1AAblationSettings(sceneType?: string): {
  presetName: string;
  settings: AblationSettings;
} {
  const presetName = resolvePresetName(sceneType);
  const preset = AblationPresets[presetName] || AblationPresets.production;

  const settings: AblationSettings = {
    ...preset,
    STAGE1A_ENABLE_PRESERVATION_PREGEN:
      parseOptionalBoolean(process.env.STAGE1A_ENABLE_PRESERVATION_PREGEN)
      ?? preset.STAGE1A_ENABLE_PRESERVATION_PREGEN,
    STAGE1A_PREGEN_NORMALIZE_ENABLED:
      parseOptionalBoolean(process.env.STAGE1A_PREGEN_NORMALIZE_ENABLED)
      ?? preset.STAGE1A_PREGEN_NORMALIZE_ENABLED,
    STAGE1A_PREGEN_TONE_STACK_SCALE:
      clamp(parseOptionalNumber(process.env.STAGE1A_PREGEN_TONE_STACK_SCALE) ?? preset.STAGE1A_PREGEN_TONE_STACK_SCALE, 0, 2),
    STAGE1A_PREGEN_LOCAL_CONTRAST_SCALE:
      clamp(parseOptionalNumber(process.env.STAGE1A_PREGEN_LOCAL_CONTRAST_SCALE) ?? preset.STAGE1A_PREGEN_LOCAL_CONTRAST_SCALE, 0, 2),
    STAGE1A_PREGEN_MEDIAN_ENABLED:
      parseOptionalBoolean(process.env.STAGE1A_PREGEN_MEDIAN_ENABLED)
      ?? preset.STAGE1A_PREGEN_MEDIAN_ENABLED,
    STAGE1A_ENABLE_POSTGEN_FINISH:
      parseOptionalBoolean(process.env.STAGE1A_ENABLE_POSTGEN_FINISH)
      ?? preset.STAGE1A_ENABLE_POSTGEN_FINISH,
    PREPROCESS_CANONICAL_HIGH_FIDELITY:
      parseOptionalBoolean(process.env.PREPROCESS_CANONICAL_HIGH_FIDELITY)
      ?? preset.PREPROCESS_CANONICAL_HIGH_FIDELITY,
    PREPROCESS_CANONICAL_WEBP_QUALITY:
      clamp(
        parseOptionalNumber(process.env.PREPROCESS_CANONICAL_WEBP_QUALITY) ?? preset.PREPROCESS_CANONICAL_WEBP_QUALITY,
        80,
        100,
      ),
    STAGE1A_PREGEN_SHARPEN_ENABLED:
      parseOptionalBoolean(process.env.STAGE1A_PREGEN_SHARPEN_ENABLED)
      ?? preset.STAGE1A_PREGEN_SHARPEN_ENABLED,
    STAGE1A_PREGEN_SHARPEN_SCALE:
      clamp(parseOptionalNumber(process.env.STAGE1A_PREGEN_SHARPEN_SCALE) ?? preset.STAGE1A_PREGEN_SHARPEN_SCALE, 0, 2),
    STAGE1A_PREGEN_SHADOW_OFFSET_SCALE:
      clamp(parseOptionalNumber(process.env.STAGE1A_PREGEN_SHADOW_OFFSET_SCALE) ?? preset.STAGE1A_PREGEN_SHADOW_OFFSET_SCALE, 0, 2),
    STAGE1A_PREGEN_MODULATE_SCALE:
      clamp(parseOptionalNumber(process.env.STAGE1A_PREGEN_MODULATE_SCALE) ?? preset.STAGE1A_PREGEN_MODULATE_SCALE, 0, 2),
    STAGE1A_PREGEN_HIGH_FIDELITY_ENCODE:
      parseOptionalBoolean(process.env.STAGE1A_PREGEN_HIGH_FIDELITY_ENCODE)
      ?? preset.STAGE1A_PREGEN_HIGH_FIDELITY_ENCODE,
  };

  return { presetName, settings };
}
