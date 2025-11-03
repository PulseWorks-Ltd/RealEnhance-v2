import sharp from "sharp";

/**
 * Quick HSV-ish heuristics to decide interior/exterior.
 * - skyPct: % of pixels with bluish hue + high value, low saturation
 * - grassPct: % of pixels with green hue + medium/high saturation
 * - woodDeckPct: % of pixels with "deck red/brown" hue in lower 40% of frame
 *
 * We bias EXTERIOR if any of these cues fire above thresholds.
 */
export async function detectSceneFromImage(buf: Buffer) {
  // Downsample for speed and stable stats
  const W = 224;
  const img = sharp(buf).resize({ width: W, fit: "inside" }).raw().ensureAlpha();
  const { data, info } = await img.toBuffer({ resolveWithObject: true });

  // data is RGBA
  const H = info.height;
  const stride = info.channels; // 4
  let sky = 0, grass = 0, woodDeck = 0, total = 0;

  // Helper: convert to basic HSV-ish components we need
  const toHSV = (r: number, g: number, b: number) => {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const v = max;
    const d = max - min;
    const s = max === 0 ? 0 : d / max;
    let h = 0;
    if (d !== 0) {
      if (max === R) h = ((G - B) / d) % 6;
      else if (max === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s, v };
  };

  const lowerBandStart = Math.floor(H * 0.6); // bottom 40% for deck/concrete detection

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * stride;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const { h, s, v } = toHSV(r, g, b);
      total++;

      // SKY: blue hue (190–240), low–mid saturation, high value
      // Only count clear blue sky to avoid false positives on interior ceilings
      if (v > 0.7 && s < 0.45 && h >= 190 && h <= 240) sky++;

      // GRASS: green hue (75–150), mid–high saturation, mid value
      if (v > 0.35 && s > 0.35 && h >= 75 && h <= 150) grass++;

      // WOOD DECK (bottom band only): red/brown hue windows (10–30 & 330–360),
      // moderate saturation/value (avoid super dark shadows)
      if (y >= lowerBandStart && v > 0.25 && s > 0.15) {
        const isRedBrown = (h >= 10 && h <= 30) || (h >= 330 || h <= 5);
        if (isRedBrown) woodDeck++;
      }
    }
  }

  const skyPct = sky / total;
  const grassPct = grass / total;
  const woodDeckPct = woodDeck / (total * 0.4); // normalized to bottom band only

  const isExterior =
    skyPct >= 0.15 ||                // ~15% blue sky
    grassPct >= 0.12 ||              // ~12% grass  
    woodDeckPct >= 0.20;             // ~20% wood deck

  return {
    decision: isExterior ? "exterior" as const : "interior" as const,
    skyPct: Number(skyPct.toFixed(4)),
    grassPct: Number(grassPct.toFixed(4)),
    woodDeckPct: Number(woodDeckPct.toFixed(4)),
  };
}