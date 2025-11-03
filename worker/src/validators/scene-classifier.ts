import sharp from "sharp";

export type SceneLabel =
  | "exterior"
  | "living_room"
  | "kitchen"
  | "bathroom"
  | "bedroom"
  | "dining"
  | "twilight"
  | "floorplan"
  | "hallway"
  | "garage"
  | "balcony"
  | "other";

export async function classifyScene(inputPath: string): Promise<{ label: SceneLabel; confidence: number }>{
  // Heuristic, cheap classifier to wire end-to-end. Replace with ONNX later.
  // Strategy: downsample to 64x64, compute mean RGB and simple ratios.
  try {
    const img = sharp(inputPath).rotate();
    const { width, height } = await img.metadata();
    const stat = await img
      .resize(64, 64, { fit: "inside" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buf = stat.data as Buffer;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < buf.length; i += 3) {
      r += buf[i]; g += buf[i+1]; b += buf[i+2];
    }
    const n = buf.length / 3 || 1;
    r /= n; g /= n; b /= n;

    const brightness = (r + g + b) / 3;
    const blueRatio = b / (r + g + b);
    const redRatio = r / (r + g + b);
    const greenRatio = g / (r + g + b);
    const aspect = (width || 1) / (height || 1);

    // Naive rules
    if (blueRatio > 0.40 && brightness > 80) {
      // Sky heavy
      return { label: "exterior", confidence: Math.min(0.5 + blueRatio, 0.95) };
    }
    if (brightness > 200 && greenRatio < 0.35) {
      // white/bright interiors -> bathroom/kitchen
      return { label: "bathroom", confidence: 0.6 };
    }
    if (redRatio > 0.36 && brightness > 120) {
      return { label: "kitchen", confidence: 0.55 };
    }
    if (aspect > 1.7) {
      return { label: "living_room", confidence: 0.55 };
    }
    if (brightness < 70 && blueRatio > 0.33) {
      return { label: "twilight", confidence: 0.6 };
    }

    return { label: "other", confidence: 0.4 };
  } catch (e) {
    return { label: "other", confidence: 0.0 };
  }
}
