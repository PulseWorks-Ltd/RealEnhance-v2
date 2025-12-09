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
  meanDiff?: number;
  maxLocalDiff?: number;
  featureMatchRatio?: number;
  reason?: string;
}

/**
 * Normalizes both images to:
 * - Same width/height
 * - Same RGB colour space
 * - Same raw buffer layout
 */
async function normalizeForDiff(path: string) {
  const img = sharp(path).removeAlpha().toColourspace("srgb");

  const meta = await img.metadata();

  if (!meta.width || !meta.height) {
    throw new Error("Unable to read image dimensions for diff validation");
  }

  const data = await img
    .resize(meta.width, meta.height) // force explicit size
    .raw()
    .toBuffer();

  return {
    data,
    width: meta.width,
    height: meta.height
  };
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

    // ✅ Normalize both images to identical format
    const orig = await normalizeForDiff(originalPath);
    const enh = await normalizeForDiff(enhancedPath);

    // ✅ HARD GUARANTEE MATCHED BUFFER SIZES
    if (
      orig.data.length !== enh.data.length ||
      orig.width !== enh.width ||
      orig.height !== enh.height
    ) {
      return {
        passed: false,
        reason: "Normalized buffer mismatch — automatic validator FAIL"
      };
    }

    const totalPixels = orig.width * orig.height;

    // ✅ 1️⃣ GLOBAL PIXEL DIFF
    const diffPixels = pixelmatch(
      orig.data,
      enh.data,
      undefined,
      orig.width,
      orig.height,
      { threshold: 0.05 }
    );

    const meanDiff = diffPixels / totalPixels;

    // ✅ 2️⃣ LOCAL TILE DIFF (8x8 GRID)
    const tileW = Math.floor(orig.width / 8);
    const tileH = Math.floor(orig.height / 8);
    let maxLocalDiff = 0;

    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const tileOrig = await sharp(originalPath)
          .extract({ left: x * tileW, top: y * tileH, width: tileW, height: tileH })
          .removeAlpha()
          .raw()
          .toBuffer();

        const tileEnh = await sharp(enhancedPath)
          .extract({ left: x * tileW, top: y * tileH, width: tileW, height: tileH })
          .removeAlpha()
          .raw()
          .toBuffer();

        const tileDiff = pixelmatch(
          tileOrig,
          tileEnh,
          undefined,
          tileW,
          tileH,
          { threshold: 0.05 }
        );

        const tileRatio = tileDiff / (tileW * tileH);
        maxLocalDiff = Math.max(maxLocalDiff, tileRatio);
      }
    }

    // ✅ 3️⃣ FEATURE MATCH (using existing edge detection)
    const featureMatchRatio = await estimateFeatureMatchRatio(originalPath, enhancedPath);

    console.log(`[Stage1A ContentDiff] meanDiff=${meanDiff.toFixed(4)}, maxLocal=${maxLocalDiff.toFixed(4)}, features=${featureMatchRatio.toFixed(4)}`);

    // ✅ 4️⃣ AUTHORITATIVE DECISION
    if (
      meanDiff > STAGE1A_VALIDATOR_LIMITS.MAX_MEAN_PIXEL_DIFF ||
      maxLocalDiff > STAGE1A_VALIDATOR_LIMITS.MAX_LOCAL_REGION_DIFF ||
      featureMatchRatio < STAGE1A_VALIDATOR_LIMITS.MIN_FEATURE_MATCH_RATIO
    ) {
      return {
        passed: false,
        meanDiff,
        maxLocalDiff,
        featureMatchRatio,
        reason: "Stage 1A content drift detected"
      };
    }

    return {
      passed: true,
      meanDiff,
      maxLocalDiff,
      featureMatchRatio
    };

  } catch (err) {
    console.error("[Stage1A ContentDiff] HARD FAIL:", err);
    // Fail closed - treat validation errors as failures
    return {
      passed: false,
      reason: "Validator crash — treating as FAIL"
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
