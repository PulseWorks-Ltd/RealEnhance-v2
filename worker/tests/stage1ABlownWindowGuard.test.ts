import fs from "fs";
import path from "path";
import sharp from "sharp";
import { findInventedBlownWindows, repairInventedBlownWindows } from "../src/validators/stage1ABlownWindowGuard";

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
