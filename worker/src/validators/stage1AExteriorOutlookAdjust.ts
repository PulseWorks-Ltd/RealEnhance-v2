// Stage 1A "Enhance Exterior Outlook" — the brighter, sunnier, greener view,
// done in code inside each usable view's box (from the outlook survey), after
// Stage 1A. No AI: nothing can be added, removed or reshaped, and nothing
// outside the boxes changes. Grey sky to blue is the only part left to
// Gemini (sky-only prompt in the Stage 1A call).
//
// Per pixel, inside a softly feathered box:
// - brighten a little and warm the light (sunlit feel);
// - make greens more vibrant (saturation, not hue or shape);
// - leave near-black (window frames, mullions) and blown white alone.
//
// STAGE1A_OUTLOOK_ADJUST=off disables it.
import sharp from "sharp";
import type { OutlookView } from "./stage1AExteriorOutlookSurvey";

export function outlookAdjustEnabled(): boolean {
  return String(process.env.STAGE1A_OUTLOOK_ADJUST || "on").trim().toLowerCase() !== "off";
}

const BRIGHTEN = Number(process.env.STAGE1A_OUTLOOK_BRIGHTEN || 0.08);  // dark tones up to +16%, mid +8%, highlights ~0
const WARM = Number(process.env.STAGE1A_OUTLOOK_WARM || 0.03);          // red +3%, blue -3%
const GREEN_SAT = Number(process.env.STAGE1A_OUTLOOK_GREEN_SAT || 0.25); // greens 25% more saturated
const FEATHER_FRAC = 0.06; // soft edge, as a share of the box's shorter side
const INSET_FRAC = 0.03;   // stay this far inside the box: a box that runs a little past the glass must not light up the wall or floor

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export async function applyOutlookAdjustments(image: Buffer, views: OutlookView[]): Promise<{ image: Buffer; changedPctOfImage: number }> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const out = Buffer.from(data);
  // Strongest weight per pixel, so overlapping boxes don't double up.
  const weight = new Float32Array(W * H);
  for (const v of views) {
    const bw = (v.box[2] - v.box[0]) * W, bh = (v.box[3] - v.box[1]) * H;
    const inset = Math.round(Math.min(bw, bh) * INSET_FRAC);
    const x1 = Math.round(v.box[0] * W) + inset, y1 = Math.round(v.box[1] * H) + inset;
    const x2 = Math.round(v.box[2] * W) - inset, y2 = Math.round(v.box[3] * H) - inset;
    const feather = Math.max(4, Math.round(Math.min(x2 - x1, y2 - y1) * FEATHER_FRAC));
    for (let y = Math.max(0, y1); y < Math.min(H, y2); y++) {
      for (let x = Math.max(0, x1); x < Math.min(W, x2); x++) {
        const d = Math.min(x - x1, x2 - 1 - x, y - y1, y2 - 1 - y);
        const w = smooth(d / feather);
        const i = y * W + x;
        if (w > weight[i]) weight[i] = w;
      }
    }
  }
  let changed = 0;
  for (let i = 0; i < W * H; i++) {
    let w = weight[i];
    if (w <= 0) continue;
    const p = i * 3;
    let r = data[p], g = data[p + 1], b = data[p + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // Frames/mullions (near-black) and blown white stay as they are.
    w *= smooth((lum - 30) / 30);
    if (Math.min(r, g, b) >= 248) w = 0;
    if (w <= 0) continue;
    // Greens: more saturated (only where green clearly leads), and not warmed
    // (warming pushes green toward yellow).
    const greenness = g > r + 6 && g > b + 6 ? smooth((g - Math.max(r, b)) / 30) : 0;
    if (greenness > 0) {
      const s = 1 + GREEN_SAT * greenness;
      r = lum + (r - lum) * s; g = lum + (g - lum) * s; b = lum + (b - lum) * s;
    }
    // Brighter, warmer light: dark and mid tones lift most, highlights hardly
    // at all, so an already bright view isn't washed out.
    const lift = 1 + BRIGHTEN * (1 - lum / 255) * 2;
    const warm = WARM * (1 - greenness);
    r *= lift * (1 + warm); g *= lift; b *= lift * (1 - warm);
    const nr = data[p] + (r - data[p]) * w, ng = data[p + 1] + (g - data[p + 1]) * w, nb = data[p + 2] + (b - data[p + 2]) * w;
    out[p] = Math.max(0, Math.min(255, Math.round(nr)));
    out[p + 1] = Math.max(0, Math.min(255, Math.round(ng)));
    out[p + 2] = Math.max(0, Math.min(255, Math.round(nb)));
    if (Math.abs(out[p] - data[p]) + Math.abs(out[p + 1] - data[p + 1]) + Math.abs(out[p + 2] - data[p + 2]) > 3) changed++;
  }
  const png = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { image: png, changedPctOfImage: +((changed / (W * H)) * 100).toFixed(2) };
}
