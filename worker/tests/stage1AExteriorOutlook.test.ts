jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import sharp from "sharp";
import { evaluateOutlookSurvey } from "../src/validators/stage1AExteriorOutlookSurvey";
import { applyOutlookAdjustments } from "../src/validators/stage1AExteriorOutlookAdjust";

describe("exterior outlook survey decision", () => {
  it("is not eligible when no window shows the outside (rooms that used to get invented windows)", () => {
    expect(evaluateOutlookSurvey({ views: [] }).eligible).toBe(false);
    expect(evaluateOutlookSurvey(null).eligible).toBe(false);
    expect(evaluateOutlookSurvey({ nonsense: true }).eligible).toBe(false);
  });

  it("ignores blown-out glass and tiny views", () => {
    const r = evaluateOutlookSurvey({ views: [
      { box: [0.1, 0.1, 0.4, 0.5], blownOut: "yes", sky: "grey", greenery: "yes" },
      { box: [0.5, 0.5, 0.52, 0.52], blownOut: "no", sky: "grey", greenery: "yes" },
    ] });
    expect(r.eligible).toBe(false);
  });

  it("asks for blue sky only when a usable view has grey sky", () => {
    const grey = evaluateOutlookSurvey({ views: [{ box: [0.3, 0.2, 0.6, 0.5], blownOut: "no", sky: "grey", greenery: "no" }] });
    expect(grey).toMatchObject({ eligible: true, skyToBlue: true });
    const greenOnly = evaluateOutlookSurvey({ views: [{ box: [0.3, 0.2, 0.6, 0.5], blownOut: "no", sky: "none", greenery: "yes" }] });
    expect(greenOnly).toMatchObject({ eligible: true, skyToBlue: false });
  });

  it("accepts boxes given in percent and rejects broken ones", () => {
    const r = evaluateOutlookSurvey({ views: [
      { box: [30, 20, 60, 50], blownOut: "no", sky: "blue", greenery: "yes" },
      { box: [0.6, 0.2, 0.3, 0.5], blownOut: "no", sky: "grey", greenery: "yes" },
    ] });
    expect(r.views).toHaveLength(1);
    expect(r.views[0].box).toEqual([0.3, 0.2, 0.6, 0.5]);
    expect(r.skyToBlue).toBe(false);
  });
});

describe("exterior outlook code adjustments", () => {
  // 200x100: left half grey wall (room), right half a "window" with a green
  // bush, a black frame bar and a blown-white patch.
  async function scene() {
    const w = 200, h = 100, px = Buffer.alloc(w * h * 3);
    const set = (x: number, y: number, c: number[]) => { const i = (y * w + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x < 100) set(x, y, [180, 180, 175]);            // room wall
      else if (x >= 140 && x < 146) set(x, y, [15, 15, 15]); // window mullion
      else if (y < 20) set(x, y, [252, 252, 252]);         // blown white
      else set(x, y, [70, 120, 60]);                       // bush
    }
    return { img: await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), w, h };
  }
  const at = async (buf: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]];
  };

  it("brightens and greens the view, and leaves the room, frame and blown white alone", async () => {
    const s = await scene();
    const r = await applyOutlookAdjustments(s.img, [{ box: [0.5, 0, 1, 1], sky: "none", greenery: true, blownOut: false, description: "" }]);
    const before = await at(s.img, 170, 60), after = await at(r.image, 170, 60);
    expect(after[1]).toBeGreaterThan(before[1]);                          // brighter green
    expect(after[1] - after[0]).toBeGreaterThan(before[1] - before[0]);   // more vibrant
    expect(await at(r.image, 50, 50)).toEqual(await at(s.img, 50, 50));   // room untouched
    expect(await at(r.image, 142, 60)).toEqual(await at(s.img, 142, 60)); // frame untouched
    expect(await at(r.image, 170, 10)).toEqual(await at(s.img, 170, 10)); // blown white stays
  });

  it("only adjusts outdoor pixels: white frames and sills, grey sky and dark blinds stay as they are", async () => {
    const w = 200, h = 100, px = Buffer.alloc(w * h * 3);
    const set = (x: number, y: number, c: number[]) => { const i = (y * w + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x < 40) set(x, y, [36, 40, 82]);         // navy blind
      else if (x < 60) set(x, y, [238, 238, 234]); // white window frame
      else if (y < 40) set(x, y, [204, 207, 212]); // grey sky
      else if (y >= 85) set(x, y, [236, 235, 230]); // white sill
      else set(x, y, [70, 120, 60]);              // bush
    }
    const img = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const r = await applyOutlookAdjustments(img, [{ box: [0, 0, 1, 1], sky: "grey", greenery: true, blownOut: false, description: "" }]);
    for (const [x, y] of [[20, 50], [50, 50], [130, 20], [130, 92]]) {
      expect(await at(r.image, x, y)).toEqual(await at(img, x, y));
    }
    const bush = await at(r.image, 130, 60);
    expect(bush[1]).toBeGreaterThan(120); // the view itself still gets the lift
  });
});
