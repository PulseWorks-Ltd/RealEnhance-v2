/**
 * Anchor Region Validators
 *
 * Binary flag detectors for high-value structural anchors:
 * - Kitchen island centroid shift
 * - Wall HVAC insert position
 * - Cabinet line continuity
 * - Fixed lighting position
 *
 * These are EVIDENCE GENERATORS — they produce binary flags, never decisions.
 * Sharp-based CV heuristics only, no AI.
 */

import sharp from "sharp";

const ANALYSIS_SIZE = 256;

/**
 * Anchor check results — all binary flags
 */
export interface AnchorCheckResult {
  islandChanged: boolean;
  hvacChanged: boolean;
  cabinetryChanged: boolean;
  lightingChanged: boolean;
  details: {
    islandCentroidShift: number;
    hvacRegionDrift: number;
    cabinetLineDrift: number;
    lightingPositionDrift: number;
  };
}

/**
 * Load greyscale buffer at analysis size
 */
async function loadGrey(imagePath: string): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(imagePath)
    .resize(ANALYSIS_SIZE, ANALYSIS_SIZE, { fit: "inside" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Compute centroid of bright/dark clusters in a region
 */
function regionCentroid(
  data: Buffer,
  width: number,
  height: number,
  regionTop: number,
  regionBottom: number,
  regionLeft: number,
  regionRight: number,
  threshold: number,
  mode: "bright" | "dark"
): { cx: number; cy: number; count: number } {
  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (let y = regionTop; y < regionBottom; y++) {
    for (let x = regionLeft; x < regionRight; x++) {
      const val = data[y * width + x];
      const match = mode === "bright" ? val > threshold : val < threshold;
      if (match) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count === 0) return { cx: 0, cy: 0, count: 0 };
  return { cx: sumX / count, cy: sumY / count, count };
}

/**
 * Compute edge density in a specific region
 */
function regionEdgeDensity(
  data: Buffer,
  width: number,
  height: number,
  regionTop: number,
  regionBottom: number,
  regionLeft: number,
  regionRight: number,
  edgeThreshold: number = 35
): number {
  let edgePixels = 0;
  let totalPixels = 0;

  for (let y = Math.max(1, regionTop); y < Math.min(height - 1, regionBottom); y++) {
    for (let x = Math.max(1, regionLeft); x < Math.min(width - 1, regionRight); x++) {
      const idx = y * width + x;
      const gx = Math.abs(data[idx + 1] - data[idx - 1]);
      const gy = Math.abs(data[idx + width] - data[idx - width]);
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag > edgeThreshold) edgePixels++;
      totalPixels++;
    }
  }

  return totalPixels > 0 ? edgePixels / totalPixels : 0;
}

/**
 * Count strong horizontal lines in a region (for cabinetry)
 */
function horizontalLineCount(
  data: Buffer,
  width: number,
  height: number,
  regionTop: number,
  regionBottom: number,
  regionLeft: number,
  regionRight: number,
  minLineLength: number = 0.3
): number {
  const regionWidth = regionRight - regionLeft;
  const threshold = Math.floor(regionWidth * minLineLength);
  let lineCount = 0;

  for (let y = Math.max(1, regionTop); y < Math.min(height - 1, regionBottom); y++) {
    let streak = 0;
    for (let x = regionLeft; x < regionRight; x++) {
      const idx = y * width + x;
      // Horizontal edge = strong vertical gradient
      const gy = Math.abs(data[idx + width] - data[idx - width]);
      if (gy > 30) {
        streak++;
      } else {
        if (streak >= threshold) lineCount++;
        streak = 0;
      }
    }
    if (streak >= threshold) lineCount++;
  }

  return lineCount;
}

// ─── ISLAND DETECTOR ───
// Kitchen islands create a large dark mass in the lower-center of kitchen images.
// We detect the centroid of dark pixels in the lower half center third and
// compare shift between original and enhanced.

const ISLAND_CENTROID_SHIFT_THRESHOLD = 0.15; // 15% of image dimension

async function detectIslandChange(
  originalData: Buffer, enhancedData: Buffer,
  width: number, height: number
): Promise<{ changed: boolean; shift: number }> {
  // Lower 40% of image, center 60%
  const regionTop = Math.floor(height * 0.6);
  const regionBottom = height;
  const regionLeft = Math.floor(width * 0.2);
  const regionRight = Math.floor(width * 0.8);

  const origCentroid = regionCentroid(
    originalData, width, height,
    regionTop, regionBottom, regionLeft, regionRight,
    80, "dark"
  );

  const enhCentroid = regionCentroid(
    enhancedData, width, height,
    regionTop, regionBottom, regionLeft, regionRight,
    80, "dark"
  );

  // If neither image has a significant dark mass, no island
  if (origCentroid.count < (width * height * 0.01) && enhCentroid.count < (width * height * 0.01)) {
    return { changed: false, shift: 0 };
  }

  // If one image has island and other doesn't → changed
  if (origCentroid.count >= (width * height * 0.01) && enhCentroid.count < (width * height * 0.005)) {
    return { changed: true, shift: 1.0 };
  }
  if (enhCentroid.count >= (width * height * 0.01) && origCentroid.count < (width * height * 0.005)) {
    return { changed: true, shift: 1.0 };
  }

  // Both have mass — compare centroids
  const dx = Math.abs(origCentroid.cx - enhCentroid.cx) / width;
  const dy = Math.abs(origCentroid.cy - enhCentroid.cy) / height;
  const shift = Math.sqrt(dx * dx + dy * dy);

  return {
    changed: shift > ISLAND_CENTROID_SHIFT_THRESHOLD,
    shift,
  };
}

// ─── HVAC DETECTOR ───
// Wall-mounted heat pumps / HVAC units create a distinct rectangular bright region
// near the top of walls. We detect edge density changes in the upper wall zone.

const HVAC_DRIFT_THRESHOLD = 0.25; // 25% edge density change

async function detectHVACChange(
  originalData: Buffer, enhancedData: Buffer,
  width: number, height: number
): Promise<{ changed: boolean; drift: number }> {
  // Upper 30% of image, left/right wall zones (edges of frame)
  const regions = [
    // Left wall upper zone
    { top: Math.floor(height * 0.1), bottom: Math.floor(height * 0.4), left: 0, right: Math.floor(width * 0.25) },
    // Right wall upper zone
    { top: Math.floor(height * 0.1), bottom: Math.floor(height * 0.4), left: Math.floor(width * 0.75), right: width },
    // Center upper zone (above doors/windows, where split systems often go)
    { top: 0, bottom: Math.floor(height * 0.25), left: Math.floor(width * 0.25), right: Math.floor(width * 0.75) },
  ];

  let maxDrift = 0;

  for (const region of regions) {
    const origDensity = regionEdgeDensity(
      originalData, width, height,
      region.top, region.bottom, region.left, region.right
    );

    const enhDensity = regionEdgeDensity(
      enhancedData, width, height,
      region.top, region.bottom, region.left, region.right
    );

    const avgDensity = (origDensity + enhDensity) / 2;
    if (avgDensity > 0.01) {
      const drift = Math.abs(enhDensity - origDensity) / avgDensity;
      maxDrift = Math.max(maxDrift, drift);
    }
  }

  return {
    changed: maxDrift > HVAC_DRIFT_THRESHOLD,
    drift: maxDrift,
  };
}

// ─── CABINETRY DETECTOR ───
// Built-in cabinetry creates strong horizontal lines (shelf edges, counter tops).
// We detect changes in horizontal line count in the mid-height zone.

const CABINET_LINE_DRIFT_THRESHOLD = 0.30; // 30% line count change

async function detectCabinetryChange(
  originalData: Buffer, enhancedData: Buffer,
  width: number, height: number
): Promise<{ changed: boolean; drift: number }> {
  // Full width, middle 60% of height (where cabinets typically are)
  const regionTop = Math.floor(height * 0.2);
  const regionBottom = Math.floor(height * 0.8);

  const origLines = horizontalLineCount(
    originalData, width, height,
    regionTop, regionBottom, 0, width
  );

  const enhLines = horizontalLineCount(
    enhancedData, width, height,
    regionTop, regionBottom, 0, width
  );

  const maxLines = Math.max(origLines, enhLines, 1);
  const drift = Math.abs(enhLines - origLines) / maxLines;

  // Only flag if there were significant lines to begin with
  const hasSignificantLines = origLines >= 3 || enhLines >= 3;

  return {
    changed: hasSignificantLines && drift > CABINET_LINE_DRIFT_THRESHOLD,
    drift,
  };
}

// ─── LIGHTING DETECTOR ───
// Fixed lighting (pendants, downlights) creates bright spots near ceiling.
// We detect centroid shifts of bright pixels in the upper zone.

const LIGHTING_SHIFT_THRESHOLD = 0.12; // 12% of image dimension

async function detectLightingChange(
  originalData: Buffer, enhancedData: Buffer,
  width: number, height: number
): Promise<{ changed: boolean; drift: number }> {
  // Upper 25% of image (ceiling zone)
  const regionTop = 0;
  const regionBottom = Math.floor(height * 0.25);
  const regionLeft = 0;
  const regionRight = width;

  const origCentroid = regionCentroid(
    originalData, width, height,
    regionTop, regionBottom, regionLeft, regionRight,
    220, "bright"
  );

  const enhCentroid = regionCentroid(
    enhancedData, width, height,
    regionTop, regionBottom, regionLeft, regionRight,
    220, "bright"
  );

  // If neither has bright spots in ceiling zone → no fixed lighting
  const minBrightPixels = width * height * 0.002;
  if (origCentroid.count < minBrightPixels && enhCentroid.count < minBrightPixels) {
    return { changed: false, drift: 0 };
  }

  // If one has lighting and other doesn't → changed
  if (origCentroid.count >= minBrightPixels && enhCentroid.count < minBrightPixels * 0.3) {
    return { changed: true, drift: 1.0 };
  }
  if (enhCentroid.count >= minBrightPixels && origCentroid.count < minBrightPixels * 0.3) {
    return { changed: true, drift: 1.0 };
  }

  // Both have lighting — compare positions
  const dx = Math.abs(origCentroid.cx - enhCentroid.cx) / width;
  const dy = Math.abs(origCentroid.cy - enhCentroid.cy) / height;
  const drift = Math.sqrt(dx * dx + dy * dy);

  return {
    changed: drift > LIGHTING_SHIFT_THRESHOLD,
    drift,
  };
}

/**
 * Run all anchor region validators
 *
 * Returns binary flags for each anchor type.
 * These are evidence signals, not decisions.
 */
export async function runAnchorRegionValidators(params: {
  originalImagePath: string;
  enhancedImagePath: string;
  jobId?: string;
}): Promise<AnchorCheckResult> {
  const { originalImagePath, enhancedImagePath, jobId } = params;

  try {
    // Load both images at analysis size
    const [orig, enh] = await Promise.all([
      loadGrey(originalImagePath),
      loadGrey(enhancedImagePath),
    ]);

    // Run all detectors in parallel
    const [island, hvac, cabinetry, lighting] = await Promise.all([
      detectIslandChange(orig.data, enh.data, orig.width, orig.height),
      detectHVACChange(orig.data, enh.data, orig.width, orig.height),
      detectCabinetryChange(orig.data, enh.data, orig.width, orig.height),
      detectLightingChange(orig.data, enh.data, orig.width, orig.height),
    ]);

    const result: AnchorCheckResult = {
      islandChanged: island.changed,
      hvacChanged: hvac.changed,
      cabinetryChanged: cabinetry.changed,
      lightingChanged: lighting.changed,
      details: {
        islandCentroidShift: island.shift,
        hvacRegionDrift: hvac.drift,
        cabinetLineDrift: cabinetry.drift,
        lightingPositionDrift: lighting.drift,
      },
    };

    return result;
  } catch (err) {
    console.warn(`[ANCHOR] Anchor region validation error (fail-open):`, err);
    // Fail-open: assume no changes
    return {
      islandChanged: false,
      hvacChanged: false,
      cabinetryChanged: false,
      lightingChanged: false,
      details: {
        islandCentroidShift: 0,
        hvacRegionDrift: 0,
        cabinetLineDrift: 0,
        lightingPositionDrift: 0,
      },
    };
  }
}
