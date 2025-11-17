export type StructuralIssueCode =
  | "none"
  | "window_count_change"
  | "window_position_change"
  | "window_size_change"
  | "wall_structure_change"
  | "dimension_change"
  | "exterior_landcover_change"
  | "implausible_crop_or_padding";

export type StructuralValidationResult = {
  ok: boolean;
  issue: StructuralIssueCode;
  message?: string;
  windowIoU?: number;
  wallIoU?: number;
  landcoverDiffRatio?: number;
  baseSize?: { width: number; height: number };
  outSize?: { width: number; height: number };
};
