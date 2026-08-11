import {
  binarizeGrayscale,
  countConnectedComponents,
  countWhitePixels,
  findMaskBoundingBox,
  isBinaryMask,
  removeIsolatedSpecks,
  removeTinyConnectedComponents,
} from "../src/providers/vertexInpaint/maskUtils";

describe("vertexInpaint maskUtils", () => {
  it("binarizeGrayscale thresholds at the given cutoff", () => {
    const raw = Buffer.from([0, 50, 127, 128, 200, 255]);
    expect(Array.from(binarizeGrayscale(raw, 128))).toEqual([0, 0, 0, 255, 255, 255]);
  });

  it("isBinaryMask detects strictly-binary vs mixed buffers", () => {
    expect(isBinaryMask(Buffer.from([0, 255, 0, 255]))).toBe(true);
    expect(isBinaryMask(Buffer.from([0, 128, 255]))).toBe(false);
  });

  it("countWhitePixels counts any nonzero value", () => {
    expect(countWhitePixels(Buffer.from([0, 0, 255, 255, 255]))).toBe(3);
  });

  it("findMaskBoundingBox returns null for an all-black mask", () => {
    const width = 4;
    const height = 4;
    const mask = Buffer.alloc(width * height, 0);
    expect(findMaskBoundingBox(mask, width, height)).toBeNull();
  });

  it("findMaskBoundingBox finds the tight bounds of a white region", () => {
    const width = 5;
    const height = 5;
    const mask = Buffer.alloc(width * height, 0);
    // Set a 2x2 white block at (1,1)-(2,2)
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
      mask[y * width + x] = 255;
    }
    expect(findMaskBoundingBox(mask, width, height)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });

  it("countConnectedComponents counts disjoint white regions", () => {
    const width = 5;
    const height = 1;
    // W . W . W -> 3 separate single-pixel components
    const mask = Buffer.from([255, 0, 255, 0, 255]);
    expect(countConnectedComponents(mask, width)).toBe(3);
  });

  it("countConnectedComponents merges 4-connected neighbors into one component", () => {
    const width = 3;
    const height = 1;
    const mask = Buffer.from([255, 255, 255]);
    expect(countConnectedComponents(mask, width)).toBe(1);
  });

  it("removeTinyConnectedComponents drops components under minArea, keeps larger ones", () => {
    const width = 5;
    const height = 1;
    // single pixel at index 0 (component size 1), 3-pixel run at 2-4 (component size 3)
    const mask = Buffer.from([255, 0, 255, 255, 255]);
    const filtered = removeTinyConnectedComponents(mask, width, 2);
    expect(Array.from(filtered)).toEqual([0, 0, 255, 255, 255]);
  });

  it("removeIsolatedSpecks only shrinks, never grows the mask", () => {
    const width = 5;
    const height = 5;
    const mask = Buffer.alloc(width * height, 0);
    // isolated single white pixel with no white neighbors
    mask[2 * width + 2] = 255;
    const cleaned = removeIsolatedSpecks(mask, width, height);
    expect(countWhitePixels(cleaned)).toBe(0);

    // solid 3x3 block should survive (each interior pixel has >=2 active neighbors)
    const solidMask = Buffer.alloc(width * height, 0);
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) {
        solidMask[y * width + x] = 255;
      }
    }
    const solidCleaned = removeIsolatedSpecks(solidMask, width, height);
    expect(countWhitePixels(solidCleaned)).toBeGreaterThan(0);
    expect(countWhitePixels(solidCleaned)).toBeLessThanOrEqual(countWhitePixels(solidMask));
  });
});
