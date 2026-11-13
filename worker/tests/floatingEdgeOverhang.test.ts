jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import sharp from "sharp";
import { checkFloatingFurniture } from "../src/pipeline/stage2Masked/core";

// 800x600 empty room: light wall above y=420 (70%), darker floor below.
// A chair cut off by the left photo edge: its side (x 0-48) ends at y=396,
// 4% above the floor line; its seat base further in (x 48-96) stands on the
// floor at y=450 (Nov 2026, job_37bb979a attempt 1).
const W = 800, H = 600;
async function room() {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.fill(y < 420 ? 215 : 95, (y * W + x) * 3, (y * W + x) * 3 + 3);
  return sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
function chair(groundedBase: boolean) {
  const m = new Uint8Array(W * H);
  for (let y = 300; y <= 396; y++) for (let x = 0; x < 48; x++) m[y * W + x] = 1;
  const baseBottom = groundedBase ? 450 : 396;
  for (let y = 300; y <= baseBottom; y++) for (let x = 48; x < 96; x++) m[y * W + x] = 1;
  return m;
}

describe("overhang at the photo edge is not floating furniture", () => {
  it("a piece cut off by the photo edge, standing on the floor further in, passes", async () => {
    const r = await checkFloatingFurniture(await room(), chair(true), W, H);
    expect(r.floating).toBe(false);
    expect((r as any).edgeOverhang?.length).toBe(1);
  });
  it("the same piece hovering everywhere is still floating", async () => {
    const r = await checkFloatingFurniture(await room(), chair(false), W, H);
    expect(r.floating).toBe(true);
  });
});
