import sharp from "sharp";
import { siblingOutPath } from "../utils/images";

// Stage 1B (local): gentle cleanup/denoise to reduce distractions
export async function runStage1B(stage1APath: string): Promise<string> {
  try {
    const out = siblingOutPath(stage1APath, "-1B", ".webp");
    await sharp(stage1APath)
      .rotate()
      .median(3)
      .blur(0.5)
      .sharpen(0.4)
      .webp({ quality: 90 })
      .toFile(out);
    return out;
  } catch {
    return stage1APath;
  }
}
