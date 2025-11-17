export type StagePresetConfig = {
  temperature: number;
  topP?: number;
  topK?: number;
  styleName: string;
};

export const NZ_REAL_ESTATE_PRESETS = {
  stage1AInterior: <StagePresetConfig>{
    temperature: 0.18,
    styleName: "nz-real-estate-interior",
  },
  stage1AExterior: <StagePresetConfig>{
    temperature: 0.21,
    styleName: "nz-real-estate-exterior",
  },
  stage2Interior: <StagePresetConfig>{
    temperature: 0.10,
    topP: 0.90,
    topK: 30,
    styleName: "nz-real-estate-staging-interior",
  },
  stage2Exterior: <StagePresetConfig>{
    temperature: 0.12,
    styleName: "nz-real-estate-staging-exterior",
  },
};

export function isNZStyleEnabled(): boolean {
  // Default ON; set USE_NZ_REAL_ESTATE_STYLE=0 to disable
  return process.env.USE_NZ_REAL_ESTATE_STYLE !== '0';
}
