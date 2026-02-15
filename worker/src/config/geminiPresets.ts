export type StagePresetConfig = {
  temperature: number;
  topP?: number;
  topK?: number;
  styleName: string;
};

export const NZ_REAL_ESTATE_PRESETS = {
  stage1AInterior: <StagePresetConfig>{
    temperature: 0.10,
    topP: 0.25,
    topK: 40,
    styleName: "nz-real-estate-interior",
  },
  stage1AExterior: <StagePresetConfig>{
    temperature: 0.10,
    topP: 0.25,
    topK: 40,
    styleName: "nz-real-estate-exterior",
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
