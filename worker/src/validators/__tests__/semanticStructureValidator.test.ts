import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { evaluateSemanticStructureResult } from "../semanticStructureValidator";
import { isEmptyRoomByEdgeDensity } from "../emptyRoomHeuristic";

describe("semanticStructureValidator", () => {
  test("window count change fails stage2 evaluation", () => {
    const result = evaluateSemanticStructureResult(
      {
        windowsBefore: 2,
        windowsAfter: 3,
        doorsBefore: 1,
        doorsAfter: 1,
        wallDrift: 0.05,
        openingsCreated: 0,
        openingsClosed: 0,
      },
      { wallDriftMax: 0.12, emptyRoom: false }
    );

    expect(result.passed).toBe(false);
    expect(result.windows.change).toBe(1);
  });

  test("empty-room threshold is more permissive for wall drift", () => {
    const strict = evaluateSemanticStructureResult(
      {
        windowsBefore: 1,
        windowsAfter: 1,
        doorsBefore: 1,
        doorsAfter: 1,
        wallDrift: 0.15,
        openingsCreated: 0,
        openingsClosed: 0,
      },
      { wallDriftMax: 0.12, emptyRoom: false }
    );

    const relaxed = evaluateSemanticStructureResult(
      {
        windowsBefore: 1,
        windowsAfter: 1,
        doorsBefore: 1,
        doorsAfter: 1,
        wallDrift: 0.15,
        openingsCreated: 0,
        openingsClosed: 0,
      },
      { wallDriftMax: 0.18, emptyRoom: true }
    );

    expect(strict.passed).toBe(false);
    expect(relaxed.passed).toBe(true);
    expect(relaxed.walls.emptyRoom).toBe(true);
    expect(relaxed.walls.threshold).toBeCloseTo(0.18);
  });
});

describe("isEmptyRoomByEdgeDensity", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sem-heuristic-"));

  const makeImage = async (filePath: string, opts: { busy?: boolean }) => {
    const size = 128;
    const canvas = sharp({ create: { width: size, height: size, channels: 3, background: opts.busy ? { r: 120, g: 120, b: 120 } : { r: 240, g: 240, b: 240 } } });
    if (opts.busy) {
      // Overlay some rectangles to increase edges
      const overlay = Buffer.from(
        `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
          <rect x="10" y="10" width="40" height="20" fill="black" />
          <rect x="60" y="60" width="50" height="30" fill="gray" />
        </svg>`
      );
      await canvas.composite([{ input: overlay }]).toFile(filePath);
    } else {
      await canvas.toFile(filePath);
    }
  };

  test("detects empty vs busy rooms via edge density", async () => {
    const emptyPath = path.join(tmpDir, "empty.png");
    const busyPath = path.join(tmpDir, "busy.png");
    await makeImage(emptyPath, { busy: false });
    await makeImage(busyPath, { busy: true });

    const emptyResult = await isEmptyRoomByEdgeDensity(emptyPath, { edgeDensityMax: 0.05 });
    const busyResult = await isEmptyRoomByEdgeDensity(busyPath, { edgeDensityMax: 0.05 });

    expect(emptyResult.empty).toBe(true);
    expect(busyResult.empty).toBe(false);
  });
});
