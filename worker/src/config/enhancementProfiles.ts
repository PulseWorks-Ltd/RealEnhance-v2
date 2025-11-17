export type EnhancementProfile = "nz_standard" | "nz_high_end";

export const DEFAULT_INTERIOR_PROFILE: EnhancementProfile = "nz_standard";

export const INTERIOR_PROFILE_CONFIG = {
  nz_standard: {
    label: "NZ Standard Real Estate",
    brightnessBoost: 0.22,
    midtoneLift: 0.25,
    shadowLift: 0.18,
    ceilingLift: 0.12,
    backWallBias: 0.20,
    warmth: 0.04,
    localContrast: 0.10,
    clarity: 0.08,
    saturation: 0.05,
    geminiTemperature: 0.16,
  },
  nz_high_end: {
    label: "NZ High-End Real Estate",
    brightnessBoost: 0.28,
    midtoneLift: 0.30,
    shadowLift: 0.22,
    ceilingLift: 0.16,
    backWallBias: 0.26,
    warmth: 0.06,
    localContrast: 0.13,
    clarity: 0.11,
    saturation: 0.07,
    geminiTemperature: 0.18,
  },
} as const;

export const INTERIOR_PROFILE_FROM_ENV: EnhancementProfile = (
  process.env.REALENHANCE_INTERIOR_PROFILE as EnhancementProfile
) === "nz_high_end" ? "nz_high_end" : DEFAULT_INTERIOR_PROFILE;
