import sharp from "sharp";

/**
 * Line-Edge Structural Validator for RealEnhance v2.0
 *
 * Detects structural inconsistencies between original and enhanced images
 * by comparing edge/line maps and geometric features using Sharp.
 *
 * Currently runs in LOG-ONLY mode - computes results but does NOT block images.
 */

export interface LineEdgeValidationResult {
  passed: boolean;        // whether it meets threshold
  score: number;          // structural similarity score (0–1)
  edgeLoss: number;       // % of edges lost
  edgeShift: number;      // average line shift in pixels
  verticalDeviation: number;  // vertical line deviation score
  horizontalDeviation: number; // horizontal line deviation score
  message: string;        // human-readable output
  diffImagePath?: string; // optional debug output
  details?: {
    originalEdgeCount: number;
    enhancedEdgeCount: number;
    edgeOverlap: number;
    linePreservation: number;
  };
}

/**
 * Simple edge detection using Sobel-like gradient computation with Sharp
 */
async function extractEdgeMap(imagePath: string): Promise<{ edgeData: Buffer; width: number; height: number; edgeCount: number }> {
  try {
    // Load image and convert to grayscale
    const { data, info } = await sharp(imagePath)
      .greyscale()
      .resize(512, 512, { fit: 'inside' }) // Normalize size for faster processing
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    const edgeData = Buffer.alloc(width * height);

    // Simple Sobel-like edge detection
    let edgeCount = 0;
    const EDGE_THRESHOLD = 30;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;

        // Horizontal gradient (Gx)
        const gx =
          -1 * data[(y - 1) * width + (x - 1)] + 1 * data[(y - 1) * width + (x + 1)] +
          -2 * data[y * width + (x - 1)] + 2 * data[y * width + (x + 1)] +
          -1 * data[(y + 1) * width + (x - 1)] + 1 * data[(y + 1) * width + (x + 1)];

        // Vertical gradient (Gy)
        const gy =
          -1 * data[(y - 1) * width + (x - 1)] - 2 * data[(y - 1) * width + x] - 1 * data[(y - 1) * width + (x + 1)] +
          1 * data[(y + 1) * width + (x - 1)] + 2 * data[(y + 1) * width + x] + 1 * data[(y + 1) * width + (x + 1)];

        // Gradient magnitude
        const magnitude = Math.sqrt(gx * gx + gy * gy);

        if (magnitude > EDGE_THRESHOLD) {
          edgeData[idx] = 255;
          edgeCount++;
        } else {
          edgeData[idx] = 0;
        }
      }
    }

    return { edgeData, width, height, edgeCount };
  } catch (err) {
    throw new Error(`Edge extraction failed: ${err}`);
  }
}

/**
 * Detect vertical and horizontal lines by analyzing edge gradients
 */
function detectStructuralLines(edgeData: Buffer, width: number, height: number): { vertical: number; horizontal: number } {
  try {
    let verticalStrength = 0;
    let horizontalStrength = 0;

    // Sample key rows and columns to detect structural lines
    const sampleRows = [
      Math.floor(height * 0.25),
      Math.floor(height * 0.5),
      Math.floor(height * 0.75),
    ];
    const sampleCols = [
      Math.floor(width * 0.25),
      Math.floor(width * 0.5),
      Math.floor(width * 0.75),
    ];

    // Check horizontal lines (sample rows)
    for (const row of sampleRows) {
      let edgesInRow = 0;
      for (let x = 0; x < width; x++) {
        if (edgeData[row * width + x] > 0) edgesInRow++;
      }
      if (edgesInRow > width * 0.3) horizontalStrength++;
    }

    // Check vertical lines (sample columns)
    for (const col of sampleCols) {
      let edgesInCol = 0;
      for (let y = 0; y < height; y++) {
        if (edgeData[y * width + col] > 0) edgesInCol++;
      }
      if (edgesInCol > height * 0.3) verticalStrength++;
    }

    return {
      vertical: verticalStrength,
      horizontal: horizontalStrength
    };
  } catch (err) {
    console.warn("[lineEdgeValidator] Line detection failed:", err);
    return { vertical: 0, horizontal: 0 };
  }
}

/**
 * Compute edge overlap ratio between two edge maps (IoU-like metric)
 */
function computeEdgeOverlap(
  edges1: Buffer,
  edges2: Buffer,
  width: number,
  height: number
): number {
  try {
    let intersection = 0;
    let union = 0;

    for (let i = 0; i < width * height; i++) {
      const e1 = edges1[i] > 0 ? 1 : 0;
      const e2 = edges2[i] > 0 ? 1 : 0;

      if (e1 === 1 && e2 === 1) intersection++;
      if (e1 === 1 || e2 === 1) union++;
    }

    return union > 0 ? intersection / union : 0;
  } catch (err) {
    console.warn("[lineEdgeValidator] Edge overlap computation failed:", err);
    return 0;
  }
}

/**
 * Main validator function - analyzes structural line/edge preservation
 */
export async function validateLineStructure(options: {
  originalPath: string;
  enhancedPath: string;
  sensitivity?: number;
}): Promise<LineEdgeValidationResult> {
  const { originalPath, enhancedPath, sensitivity = 0.75 } = options;

  const startTime = Date.now();

  try {
    // Extract edge maps from both images
    const originalEdges = await extractEdgeMap(originalPath);
    const enhancedEdges = await extractEdgeMap(enhancedPath);

    // Detect structural lines
    const originalLines = detectStructuralLines(
      originalEdges.edgeData,
      originalEdges.width,
      originalEdges.height
    );
    const enhancedLines = detectStructuralLines(
      enhancedEdges.edgeData,
      enhancedEdges.width,
      enhancedEdges.height
    );

    // Compute edge overlap (IoU-like metric)
    const edgeOverlap = computeEdgeOverlap(
      originalEdges.edgeData,
      enhancedEdges.edgeData,
      Math.min(originalEdges.width, enhancedEdges.width),
      Math.min(originalEdges.height, enhancedEdges.height)
    );

    // Calculate metrics
    const edgeLoss = originalEdges.edgeCount > 0
      ? Math.max(0, 1 - enhancedEdges.edgeCount / originalEdges.edgeCount)
      : 0;

    const linePreservation = originalLines.vertical + originalLines.horizontal > 0
      ? (enhancedLines.vertical + enhancedLines.horizontal) /
        (originalLines.vertical + originalLines.horizontal)
      : 1.0;

    const verticalDeviation = originalLines.vertical > 0
      ? Math.abs(1 - enhancedLines.vertical / originalLines.vertical)
      : 0;

    const horizontalDeviation = originalLines.horizontal > 0
      ? Math.abs(1 - enhancedLines.horizontal / originalLines.horizontal)
      : 0;

    // Compute overall structural similarity score
    const score = (
      edgeOverlap * 0.4 +
      (1 - edgeLoss) * 0.3 +
      Math.min(1.0, linePreservation) * 0.2 +
      (1 - Math.min(1, (verticalDeviation + horizontalDeviation) / 2)) * 0.1
    );

    // Determine pass/fail based on sensitivity threshold
    const passed = score >= sensitivity;

    const elapsed = Date.now() - startTime;

    return {
      passed,
      score: Math.round(score * 1000) / 1000,
      edgeLoss: Math.round(edgeLoss * 1000) / 1000,
      edgeShift: Math.round((1 - edgeOverlap) * 10) / 10, // Simplified shift metric in pixels
      verticalDeviation: Math.round(verticalDeviation * 1000) / 1000,
      horizontalDeviation: Math.round(horizontalDeviation * 1000) / 1000,
      message: passed
        ? `✓ Structural validation passed (score: ${score.toFixed(3)}, elapsed: ${elapsed}ms)`
        : `✗ Structural issues detected (score: ${score.toFixed(3)}, edgeLoss: ${(edgeLoss * 100).toFixed(1)}%, elapsed: ${elapsed}ms)`,
      details: {
        originalEdgeCount: originalEdges.edgeCount,
        enhancedEdgeCount: enhancedEdges.edgeCount,
        edgeOverlap: Math.round(edgeOverlap * 1000) / 1000,
        linePreservation: Math.round(linePreservation * 1000) / 1000,
      },
    };
  } catch (err) {
    // Validator must be fault-tolerant - never throw
    console.error("[lineEdgeValidator] Validation error:", err);
    return {
      passed: true, // Don't block on errors in log-only mode
      score: 0,
      edgeLoss: 0,
      edgeShift: 0,
      verticalDeviation: 0,
      horizontalDeviation: 0,
      message: `⚠ Validator error: ${err} (allowing image to proceed)`,
    };
  }
}
