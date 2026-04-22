import type { StructuralOpening } from "../validators/openingPreservationValidator";
import { extractStructuralBaseline } from "../validators/openingPreservationValidator";

export type OpeningRegionType = "window" | "doorway" | "opening";

export interface OpeningRegion {
  type: OpeningRegionType;
  bbox: { x: number; y: number; width: number; height: number };
  mask?: Buffer;
  confidence: number;
  openingId: string;
  normalizedBbox: [number, number, number, number];
}

function mapOpeningType(opening: StructuralOpening): OpeningRegionType | null {
  if (opening.type === "window") return "window";
  if (opening.type === "door" || opening.type === "walkthrough") return "doorway";
  return null;
}

export async function detectOpeningsFromStage1A(
  imagePath: string,
  options?: { jobId?: string; imageId?: string; attempt?: number },
): Promise<OpeningRegion[]> {
  const baseline = await extractStructuralBaseline(imagePath, options);

  return baseline.openings
    .map((opening): OpeningRegion | null => {
      const mappedType = mapOpeningType(opening);
      if (!mappedType) return null;

      const [x1, y1, x2, y2] = opening.bbox;
      const width = Math.max(0, x2 - x1);
      const height = Math.max(0, y2 - y1);
      if (width <= 0 || height <= 0) return null;

      return {
        type: mappedType,
        bbox: {
          x: x1,
          y: y1,
          width,
          height,
        },
        confidence: Number(opening.confidence || 0),
        openingId: opening.id,
        normalizedBbox: opening.bbox,
      };
    })
    .filter((opening): opening is OpeningRegion => !!opening);
}