import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";

import { buildArchitecturalExclusionMask } from "../src/continuity/exclusionMask";

async function makeSolidImage(width: number, height: number): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-exclusion-mask-"));
  const filePath = path.join(tempDir, "source.png");
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 160, g: 160, b: 160 },
    },
  }).png().toFile(filePath);

  return {
    filePath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe("architectural exclusion mask", () => {
  it("does not mark a flat image as fully protected", async () => {
    const fixture = await makeSolidImage(320, 240);
    const exclusionMaskPath = path.join(os.tmpdir(), `exclusion-mask-${Date.now()}.png`);

    try {
      const result = await buildArchitecturalExclusionMask({
        secondaryImagePath: fixture.filePath,
        exclusionMaskPath,
        jobId: "job-exclusion-flat",
        imageId: "img-exclusion-flat",
        continuityGroupId: "group-exclusion-flat",
      });

      expect(result.width * result.height).toBe(320 * 240);
      expect(result.protectedPixelCount).toBeGreaterThan(0);
      expect(result.protectedPixelCount).toBeLessThan(result.width * result.height);
    } finally {
      await fixture.cleanup();
      await fs.rm(exclusionMaskPath, { force: true });
    }
  });
});