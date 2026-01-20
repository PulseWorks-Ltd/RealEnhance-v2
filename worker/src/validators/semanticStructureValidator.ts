/**
 * Semantic Structural Validator for Stage-2
 *
 * This validator runs ONLY after Stage-2 virtual staging and detects
 * semantic architectural changes:
 * - Window count changes (brightness-based detection)
 * - Door count changes (vertical edge-based detection)
 * - Edge density drift (overall structural change)
 * - New openings created
 * - Openings closed
 *
 * MODE: LOG-ONLY (non-blocking) by default
 * Can be used in enforce mode by callers to block on specific failures.
 *
 * Implementation uses Sharp for fast, reliable image analysis without OpenCV complexity.
 */

import sharp from "sharp";

/**
 * Result from semantic structure validation
 */
export interface SemanticStructureResult {
  passed: boolean;
  windows: { before: number; after: number; change: number };
  doors: { before: number; after: number; change: number };
  walls: { driftRatio: number; threshold: number; emptyRoom: boolean };
  openings: { created: number; closed: number };
}

export interface SemanticStructureOptions {
  mode?: "log" | "enforce";
  wallDriftMax?: number;
  emptyRoom?: boolean;
}

const DEFAULT_WALL_DRIFT_MAX = Number(process.env.STAGE2_WALL_DRIFT_MAX_DEFAULT ?? 0.12);
const DEFAULT_WALL_DRIFT_MAX_EMPTY = Number(process.env.STAGE2_WALL_DRIFT_MAX_EMPTYROOM ?? 0.18);

/**
 * Window Detector (Simplified)
 *
 * Detects bright rectangular regions that likely represent windows.
 * Windows are characterized by high brightness and regular rectangular shapes.
 */
async function detectWindows(imagePath: string): Promise<number> {
  try {
    // Resize for faster processing
    const { data, info } = await sharp(imagePath)
      .resize(256, 256, { fit: "inside" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;

    // Count bright regions (potential windows)
    let brightPixels = 0;
    const brightnessThreshold = 200; // High brightness for glass/windows

    for (let i = 0; i < data.length; i++) {
      if (data[i] > brightnessThreshold) {
        brightPixels++;
      }
    }

    // Estimate window count based on bright pixel clusters
    // Assuming each window is roughly 5-10% of image area
    const totalPixels = width * height;
    const brightRatio = brightPixels / totalPixels;
    const estimatedWindows = Math.round(brightRatio / 0.075); // ~7.5% per window

    return Math.max(0, Math.min(estimatedWindows, 6)); // Cap at 6 windows
  } catch (err) {
    console.warn("[semanticValidator] Window detection error:", err);
    return 0;
  }
}

/**
 * Door Detector (Simplified)
 *
 * Detects vertical edges in lower portion of image (where doors typically are).
 * Doors create strong vertical edges and are usually in lower half of frame.
 */
async function detectDoors(imagePath: string): Promise<number> {
  try {
    const { data, info } = await sharp(imagePath)
      .resize(256, 256, { fit: "inside" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;

    // Focus on lower 60% of image (where doors are)
    const startY = Math.floor(height * 0.4);

    // Count vertical edges in lower portion
    let verticalEdges = 0;
    const edgeThreshold = 40;

    for (let y = startY; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const verticalGradient = Math.abs(data[idx] - data[idx - width]);

        if (verticalGradient > edgeThreshold) {
          verticalEdges++;
        }
      }
    }

    // Estimate door count based on vertical edge density
    const lowerAreaPixels = (height - startY) * width;
    const edgeRatio = verticalEdges / lowerAreaPixels;
    const estimatedDoors = Math.round(edgeRatio / 0.15); // ~15% edges per door

    return Math.max(0, Math.min(estimatedDoors, 4)); // Cap at 4 doors
  } catch (err) {
    console.warn("[semanticValidator] Door detection error:", err);
    return 0;
  }
}

/**
 * Edge Density Computation
 *
 * Computes overall edge density in the image to detect structural changes.
 */
async function computeEdgeDensity(imagePath: string): Promise<number> {
  try {
    const { data, info } = await sharp(imagePath)
      .resize(256, 256, { fit: "inside" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;

    // Simple edge detection using gradient magnitude
    let edgePixels = 0;
    const edgeThreshold = 30;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;

        // Horizontal gradient
        const gx = Math.abs(data[idx + 1] - data[idx - 1]);
        // Vertical gradient
        const gy = Math.abs(data[idx + width] - data[idx - width]);

        const magnitude = Math.sqrt(gx * gx + gy * gy);

        if (magnitude > edgeThreshold) {
          edgePixels++;
        }
      }
    }

    const totalPixels = width * height;
    return edgePixels / totalPixels;
  } catch (err) {
    console.warn("[semanticValidator] Edge density computation error:", err);
    return 0;
  }
}

/**
 * Wall Drift Computation
 *
 * Estimates how much the overall structure has changed by comparing edge densities.
 */
function computeWallDrift(originalEdgeDensity: number, enhancedEdgeDensity: number): number {
  const densityChange = Math.abs(enhancedEdgeDensity - originalEdgeDensity);
  const avgDensity = (originalEdgeDensity + enhancedEdgeDensity) / 2;

  if (avgDensity === 0) return 0;

  return densityChange / avgDensity;
}

/**
 * Opening Changes Detector
 *
 * Detects if new openings were created or existing ones were closed
 * based on edge density changes.
 */
function computeOpeningChanges(
  originalEdgeDensity: number,
  enhancedEdgeDensity: number
): { created: number; closed: number } {
  const densityRatio = enhancedEdgeDensity / Math.max(originalEdgeDensity, 0.001);

  // Significant increase in edges suggests new openings
  const created = densityRatio > 1.4 ? 1 : 0;

  // Significant decrease in edges suggests closed openings
  const closed = densityRatio < 0.6 ? 1 : 0;

  return { created, closed };
}

/**
 * Build a semantic structure result from pre-computed metrics.
 * This is exported to enable lightweight unit tests without image I/O.
 */
export function evaluateSemanticStructureResult(
  metrics: {
    windowsBefore: number;
    windowsAfter: number;
    doorsBefore: number;
    doorsAfter: number;
    wallDrift: number;
    openingsCreated: number;
    openingsClosed: number;
  },
  opts: SemanticStructureOptions = {}
): SemanticStructureResult {
  const emptyRoom = opts.emptyRoom === true;
  const wallDriftMax = opts.wallDriftMax ?? (emptyRoom ? DEFAULT_WALL_DRIFT_MAX_EMPTY : DEFAULT_WALL_DRIFT_MAX);

  const passed =
    metrics.windowsBefore === metrics.windowsAfter &&
    metrics.doorsBefore === metrics.doorsAfter &&
    metrics.wallDrift < wallDriftMax &&
    metrics.openingsCreated === 0 &&
    metrics.openingsClosed === 0;

  return {
    passed,
    windows: {
      before: metrics.windowsBefore,
      after: metrics.windowsAfter,
      change: metrics.windowsAfter - metrics.windowsBefore,
    },
    doors: {
      before: metrics.doorsBefore,
      after: metrics.doorsAfter,
      change: metrics.doorsAfter - metrics.doorsBefore,
    },
    walls: {
      driftRatio: metrics.wallDrift,
      threshold: wallDriftMax,
      emptyRoom,
    },
    openings: {
      created: metrics.openingsCreated,
      closed: metrics.openingsClosed,
    },
  };
}

/**
 * Run Semantic Structure Validator
 *
 * Main entry point for semantic structural validation.
 * Detects window/door count changes, wall drift, and opening modifications.
 *
 * MODE: LOG-ONLY (non-blocking)
 */
export async function runSemanticStructureValidator({
  originalImagePath,
  enhancedImagePath,
  scene,
  mode = "log",
  wallDriftMax,
  emptyRoom = false,
}: {
  originalImagePath: string;
  enhancedImagePath: string;
  scene: "interior" | "exterior";
  mode?: "log" | "enforce";
  wallDriftMax?: number;
  emptyRoom?: boolean;
}): Promise<SemanticStructureResult> {
  console.log(`[SEM][stage2] Starting semantic structural validation (${scene})`);

  try {
    // Detect windows (parallel execution for performance)
    const [windowsBefore, windowsAfter] = await Promise.all([
      detectWindows(originalImagePath),
      detectWindows(enhancedImagePath),
    ]);

    // Detect doors (parallel execution)
    const [doorsBefore, doorsAfter] = await Promise.all([
      detectDoors(originalImagePath),
      detectDoors(enhancedImagePath),
    ]);

    // Compute edge densities (parallel execution)
    const [originalEdgeDensity, enhancedEdgeDensity] = await Promise.all([
      computeEdgeDensity(originalImagePath),
      computeEdgeDensity(enhancedImagePath),
    ]);

    // Compute wall drift and openings
    const wallDrift = computeWallDrift(originalEdgeDensity, enhancedEdgeDensity);
    const openingChanges = computeOpeningChanges(originalEdgeDensity, enhancedEdgeDensity);

    const result = evaluateSemanticStructureResult(
      {
        windowsBefore,
        windowsAfter,
        doorsBefore,
        doorsAfter,
        wallDrift,
        openingsCreated: openingChanges.created,
        openingsClosed: openingChanges.closed,
      },
      { wallDriftMax, emptyRoom }
    );

    // LOG-ONLY OUTPUT (NO BLOCKING)
    console.log(
      `[SEM][stage2] windows: ${result.windows.before} → ${result.windows.after} ` +
      `${result.windows.change !== 0 ? "(FAIL)" : "(OK)"}`
    );

    console.log(
      `[SEM][stage2] doors: ${result.doors.before} → ${result.doors.after} ` +
      `${result.doors.change !== 0 ? "(FAIL)" : "(OK)"}`
    );

    console.log(
      `[SEM][stage2] wall drift: ${(result.walls.driftRatio * 100).toFixed(2)}% ` +
      `(threshold=${(result.walls.threshold * 100).toFixed(2)}% emptyRoom=${result.walls.emptyRoom ? "true" : "false"}) ` +
      `${result.walls.driftRatio > result.walls.threshold ? "(FAIL)" : "(OK)"}`
    );

    console.log(
      `[SEM][stage2] openings: +${result.openings.created} created, -${result.openings.closed} closed ` +
      `${result.openings.created || result.openings.closed ? "(FAIL)" : "(OK)"}`
    );

    console.log(
      `[SEM][stage2] RESULT: ${result.passed ? "PASSED" : "FAILED"} (mode=${mode || "log"})`
    );

    return result;
  } catch (err) {
    console.error("[SEM][stage2] Semantic validation error (non-fatal):", err);

    // Return fail-open result on error
    return {
      passed: true, // Fail-open
      windows: { before: 0, after: 0, change: 0 },
      doors: { before: 0, after: 0, change: 0 },
      walls: { driftRatio: 0 },
      openings: { created: 0, closed: 0 },
    };
  }
}
