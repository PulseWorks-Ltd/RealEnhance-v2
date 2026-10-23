// Stage 1A "Enhance Exterior Outlook" — the brighter, sunnier, greener view,
// done in code inside each usable view's box (from the outlook survey), after
// Stage 1A. No AI: nothing can be added, removed or reshaped, and nothing
// outside the boxes changes. Grey sky to blue is the only part left to
// Gemini (sky-only prompt in the Stage 1A call).
//
// Per pixel, inside a softly feathered box, outdoor pixels only:
// - brighten a little (darker tones most);
// - make greens more vibrant (saturation, not hue or shape);
// - leave alone anything that is probably not the view: near-black and dark
//   tones (window frames, mullions, blinds, curtains), bright neutral
//   white/grey (white frames, sills, the sky itself, which is Gemini's job),
//   blown white, and anything the colour of the wall around the box. Boxes
//   often run past the glass, and walls lit by warm light are slightly tinted,
//   so a fixed "white/grey" test alone let a peach glow onto the wall
//   (Oct 2026). The wall colour is sampled from a band just outside each box.
// No warming by default: on hazy or yellowish views it turned them orange.
//
// STAGE1A_OUTLOOK_ADJUST=off disables it.
import sharp from "sharp";
import type { OutlookView } from "./stage1AExteriorOutlookSurvey";

export function outlookAdjustEnabled(): boolean {
  return String(process.env.STAGE1A_OUTLOOK_ADJUST || "on").trim().toLowerCase() !== "off";
}

const BRIGHTEN = Number(process.env.STAGE1A_OUTLOOK_BRIGHTEN || 0.08);  // dark tones up to +16%, mid +8%, highlights ~0
const WARM = Number(process.env.STAGE1A_OUTLOOK_WARM || 0);             // e.g. 0.03 = red +3%, blue -3% (off by default)
const GREEN_SAT = Number(process.env.STAGE1A_OUTLOOK_GREEN_SAT || 0.25); // greens 25% more saturated
const NEUTRAL_MAX_CHROMA = 22; // below this colour spread (0-255) a bright pixel counts as white/grey
const NEUTRAL_MIN_LUM = 150;   // ...from this brightness up
const FEATHER_FRAC = 0.06; // soft edge, as a share of the box's shorter side
const INSET_FRAC = 0.03;   // stay this far inside the box: a box that runs a little past the glass must not light up the wall or floor
const WALL_BAND_FRAC = 0.04;   // wall sample band just outside each box, as a share of the box's shorter side
const WALL_MIN_SHARE = 0.08;   // a colour must cover this share of the band to count as wall
const WALL_CHROMA_MATCH = 0.02; // chromaticity distance up to which a pixel counts as wall colour (fades out by twice this)

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

type WallColour = { rc: number; gc: number; lum: number };
const chromaticity = (r: number, g: number, b: number) => { const t = r + g + b || 1; return { rc: r / t, gc: g / t }; };

/** The main colours of the wall in a band just outside the box (shading varies, so brightness is kept loose). */
export function sampleWallColours(data: Buffer, W: number, H: number, box: [number, number, number, number]): WallColour[] {
  const bx1 = Math.round(box[0] * W), by1 = Math.round(box[1] * H), bx2 = Math.round(box[2] * W), by2 = Math.round(box[3] * H);
  const band = Math.max(6, Math.round(Math.min(bx2 - bx1, by2 - by1) * WALL_BAND_FRAC));
  const gap = 2;
  const bins = new Map<string, { n: number; rc: number; gc: number; lum: number }>();
  let total = 0;
  for (let y = Math.max(0, by1 - gap - band); y < Math.min(H, by2 + gap + band); y++) {
    for (let x = Math.max(0, bx1 - gap - band); x < Math.min(W, bx2 + gap + band); x++) {
      if (x >= bx1 - gap && x < bx2 + gap && y >= by1 - gap && y < by2 + gap) continue; // inside the box (plus gap)
      const p = (y * W + x) * 3;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 60) continue; // shadows, frames, dark furniture: not a useful wall sample
      const c = chromaticity(r, g, b);
      const key = `${Math.round(c.rc * 100)},${Math.round(c.gc * 100)}`;
      const e = bins.get(key) || { n: 0, rc: 0, gc: 0, lum: 0 };
      e.n++; e.rc += c.rc; e.gc += c.gc; e.lum += lum;
      bins.set(key, e);
      total++;
    }
  }
  if (!total) return [];
  return [...bins.values()]
    .filter((e) => e.n / total >= WALL_MIN_SHARE)
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((e) => ({ rc: e.rc / e.n, gc: e.gc / e.n, lum: e.lum / e.n }));
}

/** 1 = this pixel is the wall colour, 0 = clearly not. */
function wallMatch(r: number, g: number, b: number, lum: number, walls: WallColour[]): number {
  let best = 0;
  const c = chromaticity(r, g, b);
  for (const wc of walls) {
    const dist = Math.max(Math.abs(c.rc - wc.rc), Math.abs(c.gc - wc.gc));
    const colour = smooth((2 * WALL_CHROMA_MATCH - dist) / WALL_CHROMA_MATCH);
    const light = smooth((0.5 - Math.abs(lum / Math.max(1, wc.lum) - 1)) / 0.2); // same wall in lighter or darker shade
    best = Math.max(best, colour * light);
  }
  return best;
}

export async function applyOutlookAdjustments(image: Buffer, views: OutlookView[]): Promise<{ image: Buffer; changedPctOfImage: number }> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const out = Buffer.from(data);
  // Strongest weight per pixel, so overlapping boxes don't double up.
  const weight = new Float32Array(W * H);
  const walls: WallColour[] = [];
  for (const v of views) {
    walls.push(...sampleWallColours(data, W, H, v.box));
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
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (Math.min(r, g, b) >= 248) continue; // blown white stays
    // Bright, colourless pixels (white frames and sills, wall, sky) are not
    // the view we want to lift: leave them alone.
    w *= 1 - smooth((NEUTRAL_MAX_CHROMA - chroma) / 10) * smooth((lum - NEUTRAL_MIN_LUM) / 40);
    if (w <= 0) continue;
    // The wall around the window (a box that runs past the glass).
    if (walls.length) w *= 1 - wallMatch(r, g, b, lum, walls);
    if (w <= 0) continue;
    // Greens: more saturated (only where green clearly leads), and not warmed
    // (warming pushes green toward yellow). Dark greens (tree shade) still count.
    const greenness = g > r + 6 && g > b + 6 ? smooth((g - Math.max(r, b)) / 30) * smooth((lum - 25) / 30) : 0;
    // Everything else needs to be out of the dark tones (frames, blinds, curtains).
    w *= Math.max(greenness, smooth((lum - 45) / 45));
    if (w <= 0) continue;
    if (greenness > 0) {
      const s = 1 + GREEN_SAT * greenness;
      r = lum + (r - lum) * s; g = lum + (g - lum) * s; b = lum + (b - lum) * s;
    }
    // Brighter light: dark and mid tones lift most, highlights hardly at all,
    // so an already bright view isn't washed out. Optional warmth (WARM).
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
