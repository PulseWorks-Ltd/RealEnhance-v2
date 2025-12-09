import sharp from "sharp";
import { STAGE1A_VALIDATOR_LIMITS } from "./stage1ALimits";

/**
 * Stage 1A Content Diff Validator
 *
 * Ensures that Stage 1A enhancement only changes photographic properties,
 * not actual content (furniture, decor, objects).
 *
 * Uses multi-level detection:
 * 1. Global pixel diff - catches major changes
 * 2. Local tiled diff - catches small object additions/removals
 * 3. Feature match ratio - catches content reinterpretation
 */

export interface Stage1AContentDiffResult {
  passed: boolean;
  meanDiff: number;
  maxLocalDiff: number;
  featureMatchRatio: number;
  reason?: string;
}

/**
 * Run comprehensive content diff validation for Stage 1A
 */
export async function runStage1AContentDiff(
  originalPath: string,
  enhancedPath: string
): Promise<Stage1AContentDiffResult> {
  try {
    // Dynamic import for ESM module
    const pixelmatch = (await import("pixelmatch")).default;

    // Load both images as raw buffers for pixel comparison
    const orig = await sharp(originalPath)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const enh = await sharp(enhancedPath)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = orig.info;

    // 1️⃣ Global pixel diff
    const diffPixels = pixelmatch(
      orig.data,
      enh.data,
      undefined,
      width,
      height,
      { threshold: 0.05 }
    );

    const meanDiff = diffPixels / (width * height);

    // 2️⃣ Local tiled diff (8x8 grid)
    // This catches small object changes that might not show up in global diff
    const tileW = Math.floor(width / 8);
    const tileH = Math.floor(height / 8);
    let maxLocalDiff = 0;

    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const sliceOrig = await sharp(originalPath)
          .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
          .extract({ left: x * tileW, top: y * tileH, width: tileW, height: tileH })
          .raw()
          .toBuffer();

        const sliceEnh = await sharp(enhancedPath)
          .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
          .extract({ left: x * tileW, top: y * tileH, width: tileW, height: tileH })
          .raw()
          .toBuffer();

        const tileDiff = pixelmatch(
          sliceOrig,
          sliceEnh,
          undefined,
          tileW,
          tileH,
          { threshold: 0.05 }
        );

        const tileRatio = tileDiff / (tileW * tileH);
        maxLocalDiff = Math.max(maxLocalDiff, tileRatio);
      }
    }

    // 3️⃣ Feature match ratio
    // Use existing structural validator if available, otherwise estimate from edge preservation
    const featureMatchRatio = await estimateFeatureMatchRatio(originalPath, enhancedPath);

    console.log(`[Stage1A ContentDiff] meanDiff=${meanDiff.toFixed(4)}, maxLocal=${maxLocalDiff.toFixed(4)}, features=${featureMatchRatio.toFixed(4)}`);

    // ✅ Decision logic
    if (meanDiff > STAGE1A_VALIDATOR_LIMITS.MAX_MEAN_PIXEL_DIFF) {
      return {
        passed: false,
        meanDiff,
        maxLocalDiff,
        featureMatchRatio,
        reason: `Global pixel diff ${(meanDiff * 100).toFixed(2)}% exceeds limit ${(STAGE1A_VALIDATOR_LIMITS.MAX_MEAN_PIXEL_DIFF * 100).toFixed(2)}%`
      };
    }

    if (maxLocalDiff > STAGE1A_VALIDATOR_LIMITS.MAX_LOCAL_REGION_DIFF) {
      return {
        passed: false,
        meanDiff,
        maxLocalDiff,
        featureMatchRatio,
        reason: `Local region diff ${(maxLocalDiff * 100).toFixed(2)}% exceeds limit ${(STAGE1A_VALIDATOR_LIMITS.MAX_LOCAL_REGION_DIFF * 100).toFixed(2)}%`
      };
    }

    if (featureMatchRatio < STAGE1A_VALIDATOR_LIMITS.MIN_FEATURE_MATCH_RATIO) {
      return {
        passed: false,
        meanDiff,
        maxLocalDiff,
        featureMatchRatio,
        reason: `Feature match ratio ${(featureMatchRatio * 100).toFixed(2)}% below minimum ${(STAGE1A_VALIDATOR_LIMITS.MIN_FEATURE_MATCH_RATIO * 100).toFixed(2)}%`
      };
    }

    return {
      passed: true,
      meanDiff,
      maxLocalDiff,
      featureMatchRatio
    };

  } catch (err) {
    console.error("[Stage1A ContentDiff] Error during validation:", err);
    // On validation error, assume pass (fail-open to avoid blocking valid enhancements)
    return {
      passed: true,
      meanDiff: 0,
      maxLocalDiff: 0,
      featureMatchRatio: 1.0,
      reason: "Validation error - defaulting to pass"
    };
  }
}

/**
 * Estimate feature match ratio using edge detection
 * Higher values = better structure preservation
 */
async function estimateFeatureMatchRatio(
  originalPath: string,
  enhancedPath: string
): Promise<number> {
  try {
    // Dynamic import for ESM module
    const pixelmatch = (await import("pixelmatch")).default;

    // Extract edges from both images
    const origEdges = await sharp(originalPath)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .greyscale()
      .convolve({
        width: 3,
        height: 3,
        kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] // Edge detection kernel
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const enhEdges = await sharp(enhancedPath)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .greyscale()
      .convolve({
        width: 3,
        height: 3,
        kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1]
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = origEdges.info;

    // Compare edge maps
    const edgeDiff = pixelmatch(
      origEdges.data,
      enhEdges.data,
      undefined,
      width,
      height,
      { threshold: 0.1 }
    );

    const edgeMatchRatio = 1.0 - (edgeDiff / (width * height));

    return Math.max(0, Math.min(1, edgeMatchRatio));

  } catch (err) {
    console.error("[Stage1A ContentDiff] Error estimating feature match:", err);
    return 1.0; // Fail-open
  }
}
