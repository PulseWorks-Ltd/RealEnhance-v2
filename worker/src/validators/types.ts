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
  reason?: string;             // e.g. "window_missing", "landcover_changed"
  structuralChangeRatio?: number;
  windowIoU?: number;
  landcoverChangeRatio?: number;
  meta?: {
    compliance?: string[];
    [key: string]: any;
  };
};

export function isHardStructuralFailure(res: StructuralValidationResult | null | undefined): boolean {
  if (!res) return false;
  if (!res.ok && res.reason) return true;
  return false;
}
