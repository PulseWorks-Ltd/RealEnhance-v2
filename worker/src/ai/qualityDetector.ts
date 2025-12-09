import sharp from "sharp";

/**
 * Low Quality Detector for Stage 1A
 *
 * Analyzes image quality metrics to determine if Gemini should be used
 * instead of Stability for primary enhancement.
 *
 * Metrics:
 * - Mean brightness: Detects dark/underexposed images
 * - Noise std dev: Detects high-noise images (poor lighting, high ISO)
 * - Dynamic range: Detects flat/low-contrast images
 * - Laplacian estimate: Detects blur/soft focus
 */

export interface QualityMetrics {
  meanBrightness: number;
  noiseStdDev: number;
  dynamicRange: number;
  laplacianEstimate: number;
}

export async function runLowQualityDetector(imagePath: string): Promise<QualityMetrics> {
  const img = sharp(imagePath).greyscale();
  const data = await img.raw().toBuffer();

  const pixels = data;
  const total = pixels.length;

  // Mean brightness
  let sum = 0;
  for (let i = 0; i < total; i++) sum += pixels[i];
  const meanBrightness = sum / total;

  // Noise proxy (standard deviation)
  let variance = 0;
  for (let i = 0; i < total; i++) {
    variance += (pixels[i] - meanBrightness) ** 2;
  }
  variance /= total;
  const noiseStdDev = Math.sqrt(variance);

  // Dynamic range proxy
  const sorted = Array.from(pixels).sort((a, b) => a - b);
  const p5 = sorted[Math.floor(total * 0.05)];
  const p95 = sorted[Math.floor(total * 0.95)];
  const dynamicRange = p95 - p5;

  // Blur proxy
  const laplacianEstimate = noiseStdDev / (dynamicRange + 1);

  return {
    meanBrightness,
    noiseStdDev,
    dynamicRange,
    laplacianEstimate
  };
}
