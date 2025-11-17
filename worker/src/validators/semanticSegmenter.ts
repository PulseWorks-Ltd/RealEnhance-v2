// Semantic segmentation stub for class-based structural validation
// This should be replaced with a real ADE20K/DeepLab or similar model integration

export type SemanticClass =
  | "wall"
  | "floor"
  | "ceiling"
  | "window"
  | "door"
  | "opening"
  | "light_fixture"
  | "grass"
  | "pavement"
  | "driveway"
  | "building"
  | "car";

export interface SemanticMask {
  className: SemanticClass;
  mask: Uint8Array; // binary mask, 1 for class pixel, 0 otherwise
  boundingBoxes?: Array<{ x: number; y: number; w: number; h: number }>;
  area?: number;
}

export interface SegmentationResult {
  width: number;
  height: number;
  masks: SemanticMask[];
}

// Stub: returns empty masks for now
export async function segmentImageClasses(imagePath: string): Promise<SegmentationResult> {
  // TODO: Integrate real segmentation model
  return {
    width: 0,
    height: 0,
    masks: [],
  };
}
