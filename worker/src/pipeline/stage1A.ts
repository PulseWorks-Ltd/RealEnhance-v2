import sharp from "sharp";

/**
 * Stage 1A: Advanced enhancement for real estate photography
 * - Automatic exposure and color correction
 * - Adaptive sharpening with noise reduction
 * - Professional-grade output quality
 */
export async function runStage1A(inputPath: string): Promise<string> {
  const outPath = inputPath.replace(/\.(jpg|jpeg|png|webp)$/i, "-1A.webp");
  
  let img = sharp(inputPath);
  
  // 1. Auto-rotate based on EXIF orientation
  img = img.rotate();
  
  // 2. Normalize histogram (automatic exposure correction)
  // Stretches the tonal range to use full dynamic range
  img = img.normalize();
  
  // 3. Adaptive brightness and saturation boost
  // Warmer, more inviting colors for real estate
  img = img.modulate({
    brightness: 1.10,  // +10% brightness (noticeable but natural)
    saturation: 1.15,  // +15% saturation (more vivid colors)
  });
  
  // 4. Gamma correction for better midtone detail
  // Lifts shadows without blowing out highlights
  img = img.gamma(1.12);
  
  // 5. Advanced sharpening with noise reduction
  img = img.sharpen({
    sigma: 1.5,     // Pre-blur to reduce noise amplification
    m1: 1.8,        // Strong sharpening amount
    m2: 0.7,        // Lower threshold = sharpen more areas
  });
  
  // 6. Subtle contrast boost (S-curve effect)
  // Makes the image "pop" without looking fake
  img = img.linear(1.08, -(128 * 0.08));
  
  // 7. Export with professional WebP settings
  await img
    .webp({ 
      quality: 95,           // Very high quality (was 90)
      effort: 6,             // Maximum compression efficiency
      smartSubsample: true,  // Better color preservation
    })
    .toFile(outPath);
  
  console.log(`[stage1A] Enhanced: ${inputPath} → ${outPath}`);
  return outPath;
}
