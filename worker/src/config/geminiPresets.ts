export type StagePresetConfig = {
  temperature: number;
  topP?: number;
  topK?: number;
  styleName: string;
};

export const NZ_REAL_ESTATE_PRESETS = {
  stage1AInterior: <StagePresetConfig>{
    temperature: 0.0,
    topP: 1.0,
    topK: 1,
    styleName: "nz-real-estate-interior",
  },
  stage1AExterior: <StagePresetConfig>{
    temperature: 0.0,
    topP: 0.25,
    topK: 40,
    styleName: "nz-real-estate-exterior",
  },
  // Dusk/twilight exterior transformation needs real creative latitude (sky
  // repaint, synthesized window/path lighting) — the near-deterministic
  // daylight preset above is tuned for "don't change anything" and would
  // suppress the repaint this mode explicitly asks for.
  stage1AExteriorDusk: <StagePresetConfig>{
    temperature: 0.35,
    topP: 0.85,
    topK: 40,
    styleName: "nz-real-estate-exterior-dusk",
  },
  stage2Interior: <StagePresetConfig>{
    temperature: 0.33,
    topP: 0.78,
    topK: 34,
    styleName: "nz-real-estate-staging-interior",
  },
  stage2Exterior: <StagePresetConfig>{
    temperature: 0.10,
    topP: 0.70,
    topK: 24,
    styleName: "nz-real-estate-staging-exterior",
  },
};

export function isNZStyleEnabled(): boolean {
  // Default ON; set USE_NZ_REAL_ESTATE_STYLE=0 to disable
  return process.env.USE_NZ_REAL_ESTATE_STYLE !== '0';
}
