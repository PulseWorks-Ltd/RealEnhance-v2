import sharp from "sharp";

/**
 * Vertical Edge Delta Detection
 *
 * Prevents corner flattening and doorway infill by analysing vertical edge
 * density in structural junction regions.
 *
 * 1. Vertical Projection Histogram – computes per-column vertical edge
 *    counts for BEFORE and AFTER, identifies junction columns (local peaks
 *    in the BEFORE histogram) and flags >60 % loss in AFTER.
 *
 * 2. Corner Persistence – detects columns where two wall planes meet at a
 *    vertical line in BEFORE. If the vertical edge concentration collapses
 *    in AFTER (planes merge), triggers a corner-persistence failure.
 */

// ── Tunables ────────────────────────────────────────────────────────────────

/** Fraction of maximum column-edge-count to qualify as a "junction column". */
const JUNCTION_PEAK_RATIO = 0.45;

/** Minimum absolute vertical-edge count in a junction column (avoids noise). */
const JUNCTION_MIN_EDGE_COUNT = 8;

/** Loss threshold: if AFTER retains less than this fraction → flag. */
const VERTICAL_LOSS_THRESHOLD = 0.40; // i.e. >60 % loss

/** How many consecutive junction columns must show loss to trigger a flag. */
const MIN_JUNCTION_COLUMNS_FOR_FLAG = 2;

/** Minimum contiguous vertical run (in rows) to count as a structural edge. */
const MIN_VERTICAL_RUN = 10;

/** Sobel magnitude threshold for binary edge classification. */
const EDGE_THRESHOLD = 30;

/** Internal processing resolution (longest side). */
const ANALYSIS_SIZE = 512;

// ── Types ───────────────────────────────────────────────────────────────────

export interface VerticalEdgeDeltaResult {
  /** True when vertical edge loss is detected at structural junctions. */
  verticalEdgeLossDetected: boolean;

  /** True when a wall-plane corner collapses (two planes merge into one). */
  cornerPersistenceFailure: boolean;

  /** Per-junction detail for diagnostics. */
  junctions: JunctionDetail[];

  /** Global vertical edge counts for BEFORE / AFTER. */
  beforeVerticalEdgeCount: number;
  afterVerticalEdgeCount: number;

  /** Worst-case retention ratio across all junction columns (0-1). */
  worstRetention: number;
}

export interface JunctionDetail {
  /** Column index (in analysis resolution). */
  column: number;
  beforeCount: number;
  afterCount: number;
  retention: number;
  lost: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load image → greyscale → resize → raw buffer.
 */
async function loadGray(imagePath: string): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(imagePath)
    .greyscale()
    .resize(ANALYSIS_SIZE, ANALYSIS_SIZE, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/**
 * Compute the Sobel vertical-gradient magnitude for every pixel.
 * Returns a binary edge mask (1 = edge, 0 = not).
 */
function sobelVerticalBinary(
  gray: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      // Gx kernel – responds to vertical edges (left/right intensity change)
      const gx =
        -gray[i - width - 1] + gray[i - width + 1] +
        -2 * gray[i - 1] + 2 * gray[i + 1] +
        -gray[i + width - 1] + gray[i + width + 1];
      if (Math.abs(gx) > EDGE_THRESHOLD) {
        out[i] = 1;
      }
    }
  }
  return out;
}

/**
 * Build a per-column projection histogram from a binary vertical-edge mask.
 * Each entry = total number of vertical-edge pixels in that column.
 */
function columnProjection(edgeMask: Uint8Array, width: number, height: number): Uint32Array {
  const hist = new Uint32Array(width);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) {
      if (edgeMask[y * width + x]) count++;
    }
    hist[x] = count;
  }
  return hist;
}

/**
 * Identify junction columns: local peaks in the BEFORE histogram that exceed
 * both the relative peak-ratio threshold and the absolute minimum.
 */
function findJunctionColumns(hist: Uint32Array): number[] {
  let maxVal = 0;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] > maxVal) maxVal = hist[i];
  }
  if (maxVal === 0) return [];

  const peakThreshold = maxVal * JUNCTION_PEAK_RATIO;
  const junctions: number[] = [];

  for (let x = 1; x < hist.length - 1; x++) {
    if (
      hist[x] >= peakThreshold &&
      hist[x] >= JUNCTION_MIN_EDGE_COUNT &&
      hist[x] >= hist[x - 1] &&
      hist[x] >= hist[x + 1]
    ) {
      junctions.push(x);
    }
  }
  return junctions;
}

/**
 * Count contiguous vertical edge runs in a single column.
 * Returns the number of runs that are at least `MIN_VERTICAL_RUN` rows long.
 * Two or more long runs in the same column indicate two wall planes meeting.
 */
function countVerticalRuns(
  edgeMask: Uint8Array,
  width: number,
  height: number,
  column: number,
): number {
  let runs = 0;
  let runLength = 0;
  for (let y = 0; y < height; y++) {
    if (edgeMask[y * width + column]) {
      runLength++;
    } else {
      if (runLength >= MIN_VERTICAL_RUN) runs++;
      runLength = 0;
    }
  }
  if (runLength >= MIN_VERTICAL_RUN) runs++;
  return runs;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run vertical edge delta detection between two images.
 *
 * @param beforePath  File path (local or tmp) to BEFORE image.
 * @param afterPath   File path (local or tmp) to AFTER image.
 */
export async function computeVerticalEdgeDelta(
  beforePath: string,
  afterPath: string,
): Promise<VerticalEdgeDeltaResult> {
  // Load & normalise
  const [before, after] = await Promise.all([
    loadGray(beforePath),
    loadGray(afterPath),
  ]);

  // Resize AFTER to match BEFORE dimensions if they differ
  let afterData = after.data;
  let afterW = after.width;
  let afterH = after.height;
  if (before.width !== after.width || before.height !== after.height) {
    const resized = await sharp(Buffer.from(after.data))
      .greyscale()
      .resize(before.width, before.height, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    afterData = new Uint8Array(resized.data.buffer, resized.data.byteOffset, resized.data.byteLength);
    afterW = resized.info.width;
    afterH = resized.info.height;
  }

  const width = before.width;
  const height = before.height;

  // Vertical Sobel edge masks
  const beforeEdge = sobelVerticalBinary(before.data, width, height);
  const afterEdge = sobelVerticalBinary(afterData, afterW, afterH);

  // Column projection histograms
  const beforeHist = columnProjection(beforeEdge, width, height);
  const afterHist = columnProjection(afterEdge, width, height);

  // Global vertical edge totals
  let beforeTotal = 0;
  let afterTotal = 0;
  for (let i = 0; i < width; i++) {
    beforeTotal += beforeHist[i];
    afterTotal += afterHist[i];
  }

  // Junction columns (peaks in BEFORE)
  const junctionCols = findJunctionColumns(beforeHist);

  // Per-junction analysis
  const junctions: JunctionDetail[] = [];
  let worstRetention = 1;
  let lostConsecutive = 0;
  let verticalEdgeLossDetected = false;

  for (const col of junctionCols) {
    const bCount = beforeHist[col];
    const aCount = afterHist[col];
    const retention = bCount > 0 ? aCount / bCount : 1;
    const lost = retention < VERTICAL_LOSS_THRESHOLD;

    junctions.push({ column: col, beforeCount: bCount, afterCount: aCount, retention, lost });

    if (retention < worstRetention) worstRetention = retention;

    if (lost) {
      lostConsecutive++;
      if (lostConsecutive >= MIN_JUNCTION_COLUMNS_FOR_FLAG) {
        verticalEdgeLossDetected = true;
      }
    } else {
      lostConsecutive = 0;
    }
  }

  // If no consecutive block triggered, still flag if any single junction lost >60 %
  // AND the junction had high structural significance (multiple long runs).
  if (!verticalEdgeLossDetected) {
    for (const j of junctions) {
      if (j.lost) {
        const runsInBefore = countVerticalRuns(beforeEdge, width, height, j.column);
        if (runsInBefore >= 2) {
          verticalEdgeLossDetected = true;
          break;
        }
      }
    }
  }

  // ── Corner Persistence ────────────────────────────────────────────────
  // A corner = a junction column where BEFORE has ≥ 2 long vertical runs
  // (two wall planes meeting). If AFTER has ≤ 1 run, the planes merged.
  let cornerPersistenceFailure = false;

  for (const col of junctionCols) {
    const beforeRuns = countVerticalRuns(beforeEdge, width, height, col);
    if (beforeRuns < 2) continue; // not a corner in BEFORE

    const afterRuns = countVerticalRuns(afterEdge, width, height, col);
    if (afterRuns < beforeRuns) {
      // Check the neighbouring columns (±2) to tolerate sub-pixel shift
      let neighbourPreserved = false;
      for (let dx = -2; dx <= 2; dx++) {
        const nc = col + dx;
        if (nc < 0 || nc >= width || nc === col) continue;
        const nRuns = countVerticalRuns(afterEdge, width, height, nc);
        if (nRuns >= beforeRuns) {
          neighbourPreserved = true;
          break;
        }
      }
      if (!neighbourPreserved) {
        cornerPersistenceFailure = true;
        break;
      }
    }
  }

  return {
    verticalEdgeLossDetected,
    cornerPersistenceFailure,
    junctions,
    beforeVerticalEdgeCount: beforeTotal,
    afterVerticalEdgeCount: afterTotal,
    worstRetention,
  };
}
