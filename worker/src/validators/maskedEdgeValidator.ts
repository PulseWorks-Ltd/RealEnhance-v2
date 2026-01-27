/**
 * Masked Edge Geometry Validator for Stage-2
 *
 * This validator runs ONLY after Stage-2 virtual staging and detects
 * architectural structural changes using masked edge analysis:
 * - Ignores furniture, curtains, plants, décor
 * - Focuses ONLY on walls, doors, windows, structural openings
 * - Uses Hough line detection to isolate architectural lines
 * - Detects directional opening changes (vertical = doors, horizontal = windows)
 *
 * MODE: LOG-ONLY (non-blocking)
 * This validator never blocks images, only logs violations for analysis.
 *
 * Implementation uses Sharp for image processing with custom edge detection.
 */

import sharp from "sharp";
import { normalizeImagePairForValidator } from "./dimensionUtils";

/**
 * Result from masked edge validation
 */
export interface MaskedEdgeResult {
  createdOpenings: number;
  closedOpenings: number;
  maskedEdgeDrift: number;
}

/**
 * Thresholds for masked edge validation
 */
const MASKED_EDGE_DRIFT_THRESHOLD = 0.18; // 18% drift threshold
const DOOR_CREATION_THRESHOLD = 0.25;     // 25% vertical increase
const WINDOW_CREATION_THRESHOLD = 0.30;   // 30% horizontal increase

/**
 * Build Structural Mask
 *
 * Creates a mask containing ONLY strong vertical and horizontal lines
 * representing architectural features (walls, doors, windows).
 * Filters out furniture, curtains, plants, and other non-structural elements.
 *
 * Uses simplified Hough-like line detection with Sharp.
 */
async function buildStructuralMask(imagePath: string): Promise<{
  mask: Buffer;
  width: number;
  height: number;
}> {
  try {
    // Load and prepare image
    const { data, info } = await sharp(imagePath)
      .resize(512, 512, { fit: "inside" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;

    // Edge detection using Sobel-like gradient
    const edges = Buffer.alloc(width * height);
    const EDGE_THRESHOLD = 80;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;

        // Sobel gradient computation
        const gx =
          -1 * data[(y - 1) * width + (x - 1)] + 1 * data[(y - 1) * width + (x + 1)] +
          -2 * data[y * width + (x - 1)] + 2 * data[y * width + (x + 1)] +
          -1 * data[(y + 1) * width + (x - 1)] + 1 * data[(y + 1) * width + (x + 1)];

        const gy =
          -1 * data[(y - 1) * width + (x - 1)] - 2 * data[(y - 1) * width + x] - 1 * data[(y - 1) * width + (x + 1)] +
          1 * data[(y + 1) * width + (x - 1)] + 2 * data[(y + 1) * width + x] + 1 * data[(y + 1) * width + (x + 1)];

        const magnitude = Math.sqrt(gx * gx + gy * gy);

        edges[idx] = magnitude > EDGE_THRESHOLD ? 255 : 0;
      }
    }

    // Detect strong vertical and horizontal lines
    const mask = Buffer.alloc(width * height);
    const verticalThreshold = height * 0.3; // Line must span 30% of image height
    const horizontalThreshold = width * 0.3; // Line must span 30% of image width

    // Detect vertical lines (walls, doors)
    for (let x = 0; x < width; x++) {
      let verticalStrength = 0;
      for (let y = 0; y < height; y++) {
        if (edges[y * width + x] > 0) {
          verticalStrength++;
        }
      }

      // Strong vertical line detected
      if (verticalStrength > verticalThreshold) {
        for (let y = 0; y < height; y++) {
          if (edges[y * width + x] > 0) {
            mask[y * width + x] = 255;
          }
        }
      }
    }

    // Detect horizontal lines (windows, ceiling/floor transitions)
    for (let y = 0; y < height; y++) {
      let horizontalStrength = 0;
      for (let x = 0; x < width; x++) {
        if (edges[y * width + x] > 0) {
          horizontalStrength++;
        }
      }

      // Strong horizontal line detected
      if (horizontalStrength > horizontalThreshold) {
        for (let x = 0; x < width; x++) {
          if (edges[y * width + x] > 0) {
            mask[y * width + x] = 255;
          }
        }
      }
    }

    return { mask, width, height };
  } catch (err) {
    console.warn("[maskedEdge] Structural mask creation error:", err);
    // Return empty mask on error
    const { width, height } = await sharp(imagePath).metadata();
    return {
      mask: Buffer.alloc((width || 512) * (height || 512)),
      width: width || 512,
      height: height || 512,
    };
  }
}

/**
 * Compute Masked Edge Drift
 *
 * Measures how much the architectural edge structure has changed
 * by comparing masked edges between original and enhanced images.
 */
function computeMaskedEdgeDrift(
  originalMask: Buffer,
  enhancedMask: Buffer,
  width: number,
  height: number
): number {
  try {
    let origCount = 0;
    let enhCount = 0;

    for (let i = 0; i < width * height; i++) {
      if (originalMask[i] > 0) origCount++;
      if (enhancedMask[i] > 0) enhCount++;
    }

    if (origCount === 0 && enhCount === 0) return 0;

    const maxCount = Math.max(origCount, enhCount, 1);
    const drift = Math.abs(enhCount - origCount) / maxCount;

    return drift;
  } catch (err) {
    console.warn("[maskedEdge] Drift computation error:", err);
    return 0;
  }
}

/**
 * Detect Directional Opening Changes
 *
 * Analyzes vertical vs horizontal edge changes to distinguish between:
 * - Vertical changes (doors added/removed)
 * - Horizontal changes (windows added/removed)
 */
function detectDirectionalOpeningChange(
  originalMask: Buffer,
  enhancedMask: Buffer,
  width: number,
  height: number
): { verticalDelta: number; horizontalDelta: number } {
  try {
    let origVertical = 0;
    let enhVertical = 0;
    let origHorizontal = 0;
    let enhHorizontal = 0;

    // Count vertical edges (columns with strong presence)
    for (let x = 0; x < width; x++) {
      let origVertStrength = 0;
      let enhVertStrength = 0;

      for (let y = 0; y < height; y++) {
        const idx = y * width + x;
        if (originalMask[idx] > 0) origVertStrength++;
        if (enhancedMask[idx] > 0) enhVertStrength++;
      }

      if (origVertStrength > height * 0.2) origVertical++;
      if (enhVertStrength > height * 0.2) enhVertical++;
    }

    // Count horizontal edges (rows with strong presence)
    for (let y = 0; y < height; y++) {
      let origHorizStrength = 0;
      let enhHorizStrength = 0;

      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (originalMask[idx] > 0) origHorizStrength++;
        if (enhancedMask[idx] > 0) enhHorizStrength++;
      }

      if (origHorizStrength > width * 0.2) origHorizontal++;
      if (enhHorizStrength > width * 0.2) enhHorizontal++;
    }

    const verticalDelta = (enhVertical - origVertical) / Math.max(origVertical, 1);
    const horizontalDelta = (enhHorizontal - origHorizontal) / Math.max(origHorizontal, 1);

    return { verticalDelta, horizontalDelta };
  } catch (err) {
    console.warn("[maskedEdge] Directional detection error:", err);
    return { verticalDelta: 0, horizontalDelta: 0 };
  }
}

/**
 * Run Masked Edge Validator
 *
 * Main entry point for masked edge geometry validation.
 * Detects architectural changes while ignoring furniture and décor.
 *
 * MODE: LOG-ONLY (non-blocking)
 */
export async function runMaskedEdgeValidator({
  originalImagePath,
  enhancedImagePath,
  scene,
  mode = "log",
  jobId,
}: {
  originalImagePath: string;
  enhancedImagePath: string;
  scene: "interior" | "exterior";
  mode?: "log";
  jobId?: string;
}): Promise<MaskedEdgeResult> {
  console.log(`[MASK][stage2] Starting masked edge geometry validation (${scene})`);

  try {
    const normalized = await normalizeImagePairForValidator({
      basePath: originalImagePath,
      candidatePath: enhancedImagePath,
      jobId,
    });

    if (normalized.normalized) {
      const logFn = normalized.severity === "warn" ? console.warn : console.log;
      logFn(
        `[VALIDATOR][DIM_NORMALIZE] stage=stage2 job=${jobId || "unknown"} baseline=${normalized.baseOrig?.width || "?"}x${normalized.baseOrig?.height || "?"} candidate=${normalized.candidateOrig?.width || "?"}x${normalized.candidateOrig?.height || "?"} normalized=${normalized.width}x${normalized.height} method=${normalized.method} severity=${normalized.severity}`
      );
    }

    // Build structural masks for both images (parallel execution)
    const [originalStructure, enhancedStructure] = await Promise.all([
      buildStructuralMask(normalized.basePath),
      buildStructuralMask(normalized.candidatePath),
    ]);

    const width = normalized.width;
    const height = normalized.height;

    // Compute masked edge drift
    const maskedDrift = computeMaskedEdgeDrift(
      originalStructure.mask,
      enhancedStructure.mask,
      width,
      height
    );

    // Detect directional changes (vertical = doors, horizontal = windows)
    const directionChange = detectDirectionalOpeningChange(
      originalStructure.mask,
      enhancedStructure.mask,
      width,
      height
    );

    // Determine created/closed openings
    let createdOpenings = 0;
    let closedOpenings = 0;

    if (maskedDrift > MASKED_EDGE_DRIFT_THRESHOLD) {
      // Vertical increase suggests door creation
      if (
        directionChange.verticalDelta > DOOR_CREATION_THRESHOLD &&
        directionChange.verticalDelta > Math.abs(directionChange.horizontalDelta)
      ) {
        createdOpenings = 1;
      }
      // Horizontal increase suggests window creation
      else if (directionChange.horizontalDelta > WINDOW_CREATION_THRESHOLD) {
        createdOpenings = 1;
      }

      // Negative deltas suggest closed openings
      if (directionChange.verticalDelta < -DOOR_CREATION_THRESHOLD) {
        closedOpenings = 1;
      } else if (directionChange.horizontalDelta < -WINDOW_CREATION_THRESHOLD) {
        closedOpenings = 1;
      }
    }

    const result: MaskedEdgeResult = {
      createdOpenings,
      closedOpenings,
      maskedEdgeDrift: maskedDrift,
    };

    // LOG-ONLY OUTPUT (NO BLOCKING)
    console.log(
      `[MASK][stage2] masked drift: ${(maskedDrift * 100).toFixed(2)}% ` +
        (maskedDrift > MASKED_EDGE_DRIFT_THRESHOLD ? "(FAIL)" : "(OK)")
    );

    console.log(
      `[MASK][stage2] openings created: +${createdOpenings}, closed: -${closedOpenings} ` +
        (createdOpenings || closedOpenings ? "(FAIL)" : "(OK)")
    );

    console.log(
      `[MASK][stage2] RESULT: ${
        createdOpenings || closedOpenings || maskedDrift > MASKED_EDGE_DRIFT_THRESHOLD
          ? "FAILED"
          : "PASSED"
      } (log-only)`
    );

    return result;
  } catch (err) {
    console.error("[MASK][stage2] Masked edge validation error (non-fatal):", err);

    // Return fail-open result on error
    return {
      createdOpenings: 0,
      closedOpenings: 0,
      maskedEdgeDrift: 0,
    };
  }
}
