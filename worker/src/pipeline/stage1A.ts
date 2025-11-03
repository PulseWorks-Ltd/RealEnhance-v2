import sharp from "sharp";
import { siblingOutPath } from "../utils/images";

// Stage 1A (local): quality enhancement preserving structure using sharp
export async function runStage1A(originalPath: string): Promise<string> {
  try {
    const out = siblingOutPath(originalPath, "-1A", ".webp");
    await sharp(originalPath)
      .rotate()                // auto-orient
      .normalize()             // stretch contrast channels
      .gamma(1.05)             // subtle midtone lift
      .modulate({              // slight saturation/brightness boost
        brightness: 1.03,
        saturation: 1.04
      })
      .sharpen(0.5)            // mild sharpening to recover detail
      .webp({ quality: 90 })
      .toFile(out);
    return out;
  } catch {
    return originalPath; // passthrough on error
  }
}
