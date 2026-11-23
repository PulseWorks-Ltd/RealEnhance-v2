// worker/src/ai/exteriorColourFinish.ts
// Exterior colour finish (Nov 2026). Gemini's Stage 1A exterior enhancement is
// deliberately gentle, and owners found the results "fairly similar" to the
// uploads: brighter, but with no richer colour. Asking Gemini for a stronger
// edit was tried and rejected — it changed the property (a white deck railing
// turned to timber, an aerial appeared). This finish is done in code instead,
// so it can only change colour and tone: it never adds, removes or moves
// anything.
//
// What it does, all gently and with highlights protected:
//  1. vibrance — more colour in muted areas, little in already-strong colour,
//     none in near-whites (cladding and trim stay clean white);
//  2. greenery — lawns, hedges and trees a little greener and warmer;
//  3. sky — open blue sky in the upper part of the frame a little deeper;
//  4. depth — brighter tones lifted gently, shadows opened slightly (never darker);
//  5. clarity — wide-radius local contrast, below the level that makes halos.
//
// STAGE1A_EXTERIOR_COLOUR_FINISH=off turns it off.
// STAGE1A_EXTERIOR_COLOUR_FINISH_STRENGTH scales every part together
// (1 = the standard finish, 0 = none, up to 2).

import sharp from "sharp";
import { siblingOutPath } from "../utils/images";

export function exteriorColourFinishEnabled(): boolean {
  return String(process.env.STAGE1A_EXTERIOR_COLOUR_FINISH ?? "on").trim().toLowerCase() !== "off";
}

export function exteriorColourFinishStrength(): number {
  const v = Number(process.env.STAGE1A_EXTERIOR_COLOUR_FINISH_STRENGTH ?? 1);
  return Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The finish on raw RGB pixels (0-255, 3 channels). Returns new pixels. */
export function colourFinishPixels(src: Uint8Array | Buffer, width: number, height: number, channels = 3, strength = 1): Uint8Array {
  const s = Math.max(0, Math.min(2, strength));
  const out = new Uint8Array(width * height * 3);
  const denom = Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    // Sky boost fades out from the top towards the middle of the frame.
    const topWeight = clamp01(1.4 - (2 * y) / denom);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      let r = src[i] / 255, g = src[i + 1] / 255, b = src[i + 2] / 255;

      // 1) Vibrance
      let L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx > 1e-6 ? (mx - mn) / mx : 0;
      const nearWhite = clamp01((L - 0.85) / 0.1);
      const vib = 0.28 * s * Math.pow(1 - sat, 1.5) * (1 - nearWhite);
      r = L + (r - L) * (1 + vib); g = L + (g - L) * (1 + vib); b = L + (b - L) * (1 + vib);

      // 2) Greenery
      const green = clamp01((g - Math.max(r, b)) / 0.08);
      if (green > 0) {
        L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const k = 0.18 * s * green;
        r = r + (r - L) * k + 0.01 * s * green; g = g + (g - L) * k; b = b + (b - L) * k;
      }

      // 3) Open blue sky (upper frame only)
      if (topWeight > 0) {
        L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const sky = L > 0.35 ? clamp01((b - Math.max(r, g)) / 0.12) * topWeight : 0;
        if (sky > 0) {
          const k = 0.2 * s * sky;
          r = r + (r - L) * k - 0.03 * s * sky; g = g + (g - L) * k - 0.03 * s * sky; b = b + (b - L) * k;
        }
      }

      // 4) Depth without darker shadows: brighter tones get a gentle lift
      //    (highlights protected), shadows a small lift too — never darker
      //    than the photo (real-estate shadows stay open).
      const curve = (v: number) => {
        v = clamp01(v);
        if (v < 0.5) return clamp01(v + 0.025 * s * Math.sin(2 * Math.PI * v));
        return clamp01(v + 0.06 * s * Math.sin(Math.PI * v) * (v - 0.5) * 2 * (1 - clamp01((v - 0.9) / 0.1)));
      };
      const o = (y * width + x) * 3;
      out[o] = Math.round(curve(r) * 255);
      out[o + 1] = Math.round(curve(g) * 255);
      out[o + 2] = Math.round(curve(b) * 255);
    }
  }
  return out;
}

/** Wide-radius local contrast ("clarity"): out = img + amount * (img - blur), small differences left alone. */
async function addClarity(pixels: Uint8Array, width: number, height: number, strength = 1): Promise<Uint8Array> {
  const sigma = Math.max(4, 30 * (width / 2400));
  const blurred = await sharp(Buffer.from(pixels), { raw: { width, height, channels: 3 } }).blur(sigma).raw().toBuffer();
  const out = new Uint8Array(pixels.length);
  const amount = 0.18 * Math.max(0, Math.min(2, strength)), threshold = 2;
  for (let i = 0; i < pixels.length; i++) {
    const d = pixels[i] - blurred[i];
    const v = Math.abs(d) < threshold ? pixels[i] : pixels[i] + amount * d;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return out;
}

/** Applies the finish to an exterior Stage 1A image; returns the new path (or the input on failure). */
export async function applyExteriorColourFinish(inputPath: string, strength = exteriorColourFinishStrength()): Promise<string> {
  try {
    if (strength <= 0) return inputPath;
    const { data, info } = await sharp(inputPath).rotate().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const graded = colourFinishPixels(data, info.width, info.height, info.channels, strength);
    const finished = await addClarity(graded, info.width, info.height, strength);
    const outPath = siblingOutPath(inputPath, strength === 1 ? "-colour" : `-colour${strength}`);
    await sharp(Buffer.from(finished), { raw: { width: info.width, height: info.height, channels: 3 } })
      .webp({ quality: 95, effort: 4 })
      .toFile(outPath);
    console.log(`[STAGE1A_EXTERIOR_COLOUR_FINISH] applied strength ${strength} ${info.width}x${info.height} -> ${outPath.split("/").pop()}`);
    return outPath;
  } catch (err: any) {
    // Fail-open: the enhanced photo without the finish is still a good result.
    console.warn("[STAGE1A_EXTERIOR_COLOUR_FINISH] failed — delivering without it:", err?.message || err);
    return inputPath;
  }
}
