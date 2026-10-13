import fs from "fs";
import path from "path";
import sharp from "sharp";
import { findInventedBlownWindows, repairInventedBlownWindows, repairInventedSky } from "../src/validators/stage1ABlownWindowGuard";

const FIX = path.join(__dirname, "../../Test Images/Blown Window Fixtures");
const have = fs.existsSync(path.join(FIX, "Bedroom_14_invented/before_gemini.webp"));
const maybe = have ? it : it.skip;
const load = (name: string) => [
  fs.readFileSync(path.join(FIX, name, "before_gemini.webp")),
  fs.readFileSync(path.join(FIX, name, "gemini_output.webp")),
];

describe("Stage 1A blown-out window guard", () => {
  maybe("catches scenery invented in blown-out windows and leaves real views alone", async () => {
    const expected: Record<string, boolean> = {
      Bedroom_14_invented: true,
      Bedroom_14_invented_oldprompt: true,
      Bedroom_05_real_view: false,
      Living_07_real_view: false,
      Bedroom_11_real_view: false,
    };
    for (const [name, invented] of Object.entries(expected)) {
      const [before, after] = load(name);
      const r = await findInventedBlownWindows(before, after);
      expect({ name, invented: r.regions.some((x) => x.invented) }).toEqual({ name, invented });
    }
  }, 120000);

  maybe("repairs only the windows: the rest of the image is untouched", async () => {
    const [before, after] = load("Bedroom_14_invented");
    const r = await repairInventedBlownWindows(before, after);
    expect(r.image).not.toBeNull();
    const m = await sharp(after).metadata();
    const [a, b] = await Promise.all([sharp(after).removeAlpha().raw().toBuffer(), sharp(r.image!).removeAlpha().raw().toBuffer()]);
    let changed = 0;
    for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i] - b[i]) > 3) changed++;
    const pct = (changed / (m.width! * m.height!)) * 100;
    expect(pct).toBeGreaterThan(2);  // both windows put back
    expect(pct).toBeLessThan(12);    // nothing else
  }, 120000);
});

describe("Stage 1A invented-sky guard (plants turned into sky)", () => {
  const haveSky = fs.existsSync(path.join(FIX, "Living_trimmed_hedge/before_gemini.webp"));
  const maybeSky = haveSky ? it : it.skip;

  maybeSky("catches trimmed shrubs replaced by sky and leaves real views alone", async () => {
    const expected: Record<string, boolean> = {
      Living_trimmed_hedge: true,
      Bedroom_14_invented: false, // blown-out panes: the blown-window guard's job
      Bedroom_05_real_view: false,
      Living_07_real_view: false,
      Bedroom_11_real_view: false,
    };
    for (const [name, invented] of Object.entries(expected)) {
      const [before, after] = load(name);
      const r = await repairInventedSky(before, after);
      expect({ name, invented: !!r.image }).toEqual({ name, invented });
    }
  }, 120000);

  maybeSky("puts the shrubs back in the window only, and no sky remains there", async () => {
    const [before, after] = load("Living_trimmed_hedge");
    const r = await repairInventedSky(before, after);
    expect(r.image).not.toBeNull();
    const m = await sharp(after).metadata();
    const W = m.width!, H = m.height!;
    const [a, b] = await Promise.all([sharp(after).removeAlpha().raw().toBuffer(), sharp(r.image!).removeAlpha().raw().toBuffer()]);
    let changed = 0, skyBefore = 0, skyAfter = 0;
    // top of the big window (right side of the photo)
    const x1 = Math.round(W * 0.74), x2 = Math.round(W * 0.95), y1 = Math.round(H * 0.3), y2 = Math.round(H * 0.38);
    for (let i = 0; i < W * H; i++) {
      if (Math.abs(a[i * 3] - b[i * 3]) > 3) changed++;
      const x = i % W, y = (i / W) | 0;
      if (x < x1 || x > x2 || y < y1 || y > y2) continue;
      const blue = (p: Buffer) => p[i * 3 + 2] > p[i * 3] + 15 && p[i * 3 + 2] > 110;
      if (blue(a)) skyBefore++;
      if (blue(b)) skyAfter++;
    }
    const pct = (changed / (W * H)) * 100;
    expect(pct).toBeGreaterThan(0.3);
    expect(pct).toBeLessThan(5);
    expect(skyAfter).toBeLessThan(skyBefore * 0.15);
  }, 120000);
});
