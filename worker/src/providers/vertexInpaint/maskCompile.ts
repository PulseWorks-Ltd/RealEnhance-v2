import sharp from "sharp";
import { binarizeGrayscale, removeIsolatedSpecks, removeTinyConnectedComponents } from "./maskUtils";

// Deliberately small (VERTEX_INPAINTING_INVESTIGATION.md §9): binarize the raw
// Gemini mask response, drop isolated single-pixel noise, then drop any
// remaining connected component too small to be a real furniture-placement
// zone. No exclusion-mask merging, no multi-pass union, no continuity anchors
// — Gemini is asked to do exclusion semantically in the same prompt (§6/§7),
// so there is nothing else to compile in.
const MIN_COMPONENT_AREA_RATIO = 0.001; // ~0.1% of frame area

export async function compileMask(params: {
  rawMaskPngBuffer: Buffer;
  width: number;
  height: number;
}): Promise<Buffer> {
  const grayscaleRaw = await sharp(params.rawMaskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(params.width, params.height, { fit: "fill", kernel: sharp.kernel.nearest })
    .raw()
    .toBuffer();

  const binarized = binarizeGrayscale(grayscaleRaw);
  const despeckled = removeIsolatedSpecks(binarized, params.width, params.height);
  const minArea = Math.max(16, Math.round(params.width * params.height * MIN_COMPONENT_AREA_RATIO));
  const cleaned = removeTinyConnectedComponents(despeckled, params.width, minArea);

  return sharp(cleaned, { raw: { width: params.width, height: params.height, channels: 1 } })
    .png()
    .toBuffer();
}
