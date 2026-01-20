import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { validateStructureStageAware } from "../structural/stageAwareValidator";

const makeImage = async (filePath: string, w: number, h: number) => {
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 200, b: 200 } } })
    .png()
    .toFile(filePath);
};

describe("stageAwareValidator dimension mismatch blocking", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stageaware-dim-"));
  const basePath = path.join(tmpDir, "base.png");
  const candPath = path.join(tmpDir, "cand.png");
  const envBackup = { ...process.env };

  beforeAll(async () => {
    await makeImage(basePath, 32, 24);
    await makeImage(candPath, 30, 20); // different dimensions
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  test("dimension mismatch is fatal when env default/on", async () => {
    delete process.env.STRUCT_VALIDATION_BLOCK_ON_DIMENSION_MISMATCH; // default = on
    process.env.STRUCT_VALIDATION_STAGE_AWARE = "1";
    const summary = await validateStructureStageAware({
      stage: "stage2",
      baselinePath: basePath,
      candidatePath: candPath,
      sceneType: "interior",
      mode: "block",
    });

    expect(summary.risk).toBe(true);
    expect(summary.passed).toBe(false);
    const dimTrigger = summary.triggers.find(t => t.id === "dimension_mismatch");
    expect(dimTrigger?.fatal).toBe(true);
  });

  test("dimension mismatch non-fatal when override is disabled", async () => {
    process.env.STRUCT_VALIDATION_BLOCK_ON_DIMENSION_MISMATCH = "0";
    process.env.STRUCT_VALIDATION_STAGE_AWARE = "1";
    const summary = await validateStructureStageAware({
      stage: "stage2",
      baselinePath: basePath,
      candidatePath: candPath,
      sceneType: "interior",
      mode: "block",
    });

    expect(summary.risk).toBe(false); // gateMinSignals=2 and no fatal
    const dimTrigger = summary.triggers.find(t => t.id === "dimension_mismatch");
    expect(dimTrigger?.fatal).toBeFalsy();
  });
});
