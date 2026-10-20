jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import fs from "fs";
import path from "path";
import { checkFraming, checkCameraAlignment, checkFloatingFurniture, planFloorPatches, applyFloorPatches, REFRAMED_MEDIAN_DIFF } from "../src/pipeline/stage2Masked/core";
import sharp from "sharp";

const RUN = path.join(__dirname, "../../Test Images/Stage2_MaskPasteback/2026-10-11T05-21-43-086Z");
const have = fs.existsSync(path.join(RUN, "Bedroom12/2_staged_raw.webp"));
const maybe = have ? it : it.skip;

describe("masked Stage 2 reshape checks", () => {
  maybe("does not flag good results", async () => {
    for (const name of ["Bedroom14", "Living07", "Living10", "Validator_2327860184"]) {
      const o = fs.readFileSync(path.join(RUN, name, "1_original.jpg"));
      const s = fs.readFileSync(path.join(RUN, name, "2_staged_raw.webp"));
      const m = await sharp(o).metadata();
      const r = await checkFraming(o, s, new Uint8Array(m.width! * m.height!), m.width!, m.height!);
      expect({ name, flagged: r.medianDiff > REFRAMED_MEDIAN_DIFF }).toEqual({ name, flagged: false });
    }
  }, 60000);

  maybe("ignores brightness but catches a zoomed or shifted camera", async () => {
    for (const name of ["Bedroom14", "Living07", "Validator_2327860184"]) {
      const o = fs.readFileSync(path.join(RUN, name, "1_original.jpg"));
      const m = await sharp(o).metadata();
      const w = m.width!, h = m.height!;
      const s = await sharp(fs.readFileSync(path.join(RUN, name, "2_staged_raw.webp"))).resize(w, h, { fit: "fill" }).toBuffer();
      const brighter = await sharp(s).linear(1.16, 0).toBuffer();
      const f = await checkFraming(o, brighter, new Uint8Array(w * h), w, h);
      expect({ name, framing: f.framingChanged }).toEqual({ name, framing: false });
      expect({ name, moved: (await checkCameraAlignment(o, brighter)).moved }).toEqual({ name, moved: false });
      expect({ name, moved: (await checkCameraAlignment(o, s)).moved }).toEqual({ name, moved: false });
      const zw = Math.round(w * 0.94), zh = Math.round(h * 0.94);
      const zoomed = await sharp(await sharp(s).resize(zw, zh).toBuffer())
        .extend({ top: Math.floor((h - zh) / 2), bottom: Math.ceil((h - zh) / 2), left: Math.floor((w - zw) / 2), right: Math.ceil((w - zw) / 2), background: { r: 200, g: 200, b: 200 } })
        .toBuffer();
      const z = await checkCameraAlignment(o, zoomed);
      expect({ name, moved: z.moved }).toEqual({ name, moved: true });
      expect(Math.abs(z.scale - 0.94)).toBeLessThan(0.02);
    }
  }, 400000);

  const FIX = path.join(__dirname, "../../Test Images/Floating Check Fixtures");
  const haveFix = fs.existsSync(path.join(FIX, "Bedroom_14/3_mask_traced.png"));
  (haveFix ? it : it.skip)("flags furniture whose legs stop short of the real floor", async () => {
    const expected: Record<string, boolean> = { Kitchen_01_a1: false, Kitchen_01_a2: true, Bedroom_05: true, Bedroom_14: true, Bedroom_07: true, Bedroom_11: false, Bedroom_12: false, Bedroom_OpenDoor_a1: false, Bedroom_OpenDoor_a2: false, Living_SofaUnderWindow: false };
    for (const [name, floats] of Object.entries(expected)) {
      const o = fs.readFileSync(path.join(FIX, name, "1_original.jpg"));
      const m = await sharp(o).metadata();
      const raw = await sharp(path.join(FIX, name, "3_mask_traced.png")).resize(m.width!, m.height!, { fit: "fill" }).greyscale().raw().toBuffer();
      const mask = Uint8Array.from(raw, (v: number) => (v > 127 ? 1 : 0));
      const r = await checkFloatingFurniture(o, mask, m.width!, m.height!);
      expect({ name, floating: r.floating }).toEqual({ name, floating: floats });
    }
  }, 120000);

  // Floor patch: keep Gemini's own floor/skirting under a floating piece when
  // the join can hide behind a piece in front / a wall corner / the photo edge.
  (haveFix ? it : it.skip)("patches the floor under a floating piece only where the join can hide", async () => {
    // Bedroom_05: bedside table between a pillar edge and the bed -> patch.
    // Bedroom_14: chest against open wall; Bedroom_07: chest carries on to the floor -> re-stage.
    const expected: Record<string, boolean> = { Bedroom_05: true, Bedroom_14: false, Bedroom_07: false };
    for (const [name, patchable] of Object.entries(expected)) {
      const o = fs.readFileSync(path.join(FIX, name, "1_original.jpg"));
      const staged = fs.readFileSync(path.join(FIX, name, "2_staged_raw.webp"));
      const maskPng = path.join(FIX, name, "3_mask_traced.png");
      const om = await sharp(o).metadata();
      const w = om.width!, h = om.height!; // the pipeline works at the photo's size
      const raw = await sharp(maskPng).resize(w, h, { fit: "fill" }).extractChannel(0).raw().toBuffer();
      const mask = Uint8Array.from(raw, (v: number) => (v > 127 ? 1 : 0));
      const chk = await checkFloatingFurniture(o, mask, w, h);
      expect({ name, floating: chk.floating }).toEqual({ name, floating: true });
      const plan = await planFloorPatches(o, staged, mask, chk.runs, w, h);
      expect({ name, ok: plan.ok, notes: plan.notes }).toEqual({ name, ok: patchable, notes: plan.notes });
      if (!plan.ok) continue;
      const final = fs.readFileSync(path.join(FIX, name, "11_final_checked_blend.webp"));
      const res = await applyFloorPatches(o, final, staged, mask, plan.patches, w, h);
      expect(res.image).not.toBeNull();
      // only the patch area changed; the rest of the photo is untouched
      const fm = await sharp(final).metadata();
      const [a, b] = await Promise.all([sharp(final).removeAlpha().raw().toBuffer(), sharp(res.image!).removeAlpha().raw().toBuffer()]);
      let changed = 0;
      for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i] - b[i]) > 3) changed++;
      expect(changed / (fm.width! * fm.height!)).toBeLessThan(0.05);
    }
  }, 300000);

  // Gemini's floor must be the same material as the real one: if it laid
  // boards over carpet, patching would bring a strip of boards into the photo.
  (haveFix ? it : it.skip)("refuses the floor patch when Gemini changed the floor material", async () => {
    const dir = path.join(FIX, "Bedroom_05");
    const o = fs.readFileSync(path.join(dir, "1_original.jpg"));
    const staged = fs.readFileSync(path.join(dir, "2_staged_raw.webp"));
    const om = await sharp(o).metadata();
    const w = om.width!, h = om.height!;
    const raw = await sharp(path.join(dir, "3_mask_traced.png")).resize(w, h, { fit: "fill" }).extractChannel(0).raw().toBuffer();
    const mask = Uint8Array.from(raw, (v: number) => (v > 127 ? 1 : 0));
    const chk = await checkFloatingFurniture(o, mask, w, h);
    const sm = await sharp(staged).metadata();
    const H = Math.round(sm.height! * 0.14); // the floor strip only (corner untouched)
    for (const [fill, line] of [["#9a6b43", "#5a3a20"], ["#7d7a74", "#55524d"]]) { // brown boards; grey boards in the carpet's colour
      let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sm.width}" height="${H}"><rect width="100%" height="100%" fill="${fill}"/>`;
      for (let y = 0; y < H; y += Math.round(H / 14)) svg += `<line x1="0" y1="${y}" x2="${sm.width}" y2="${y + H * 0.05}" stroke="${line}" stroke-width="3"/>`;
      svg += "</svg>";
      const boards = await sharp(staged).composite([{ input: await sharp(Buffer.from(svg)).png().toBuffer(), left: 0, top: sm.height! - H }]).png().toBuffer();
      const plan = await planFloorPatches(o, boards, mask, chk.runs, w, h);
      expect({ fill, ok: plan.ok, floorNote: /floor/.test(plan.notes.join(" ")) }).toEqual({ fill, ok: false, floorNote: true });
    }
  }, 300000);
});
