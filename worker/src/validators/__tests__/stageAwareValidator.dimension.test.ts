import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { validateStructureStageAware } from "../structural/stageAwareValidator";

const envBackup = { ...process.env };

const resetEnv = () => {
  process.env = { ...envBackup };
};

const makePatternImage = async (filePath: string, w: number, h: number) => {
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">`
    + `<rect x="4" y="4" width="${w - 8}" height="${h - 8}" fill="white" stroke="black" stroke-width="2"/>`
    + `<line x1="0" y1="0" x2="${w}" y2="${h}" stroke="black" stroke-width="2"/>`
    + `<line x1="0" y1="${h}" x2="${w}" y2="0" stroke="black" stroke-width="2"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
};

const primeStageAwareEnv = () => {
  process.env.STRUCT_VALIDATION_STAGE_AWARE = "1";
  process.env.STRUCT_VALIDATION_LOWEDGE_ENABLE = "0";
  process.env.STRUCT_VALIDATION_PAINTOVER_ENABLE = "0";
  process.env.STRUCT_VALIDATION_STAGE2_LINEEDGE_MIN = "0";
  process.env.STRUCT_VALIDATION_STAGE2_UNIFIED_MIN = "0";
};

const makeTempPaths = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    basePath: path.join(dir, "base.png"),
    candPath: path.join(dir, "cand.png"),
  };
};

describe("stageAwareValidator dimension policy", () => {
  afterEach(() => {
    resetEnv();
  });

  test("small resize with preserved AR is benign (non-fatal) and normalized for IoU", async () => {
    primeStageAwareEnv();
    process.env.STRUCT_VALIDATION_STAGE2_EDGE_IOU_MIN = "0";
    process.env.STRUCT_VALIDATION_STAGE2_STRUCT_IOU_MIN = "0";

    const { basePath, candPath } = makeTempPaths("stageaware-dim-small-");
    await makePatternImage(basePath, 120, 80);
    await sharp(basePath).resize(122, 82).toFile(candPath);

    const summary = await validateStructureStageAware({
      stage: "stage2",
      baselinePath: basePath,
      candidatePath: candPath,
      sceneType: "interior",
      mode: "block",
    });

    const dimTrigger = summary.triggers.find(t => t.id.startsWith("dimension"));
    expect(dimTrigger?.fatal).toBe(false);
    expect(dimTrigger?.nonBlocking).toBe(true);
    expect(summary.debug.structuralIoUSkipped).not.toBe(true);
    expect(summary.debug.structuralIoUSkipReason).not.toBe("dimension_alignment_blocked");
  });

  test("stride-aligned resize is treated as benign risk only", async () => {
    primeStageAwareEnv();
    process.env.STRUCT_VALIDATION_DIM_STRIDE_MULTIPLE = "32";
    process.env.STRUCT_VALIDATION_STAGE2_EDGE_IOU_MIN = "0";
    process.env.STRUCT_VALIDATION_STAGE2_STRUCT_IOU_MIN = "0";

    const { basePath, candPath } = makeTempPaths("stageaware-dim-stride-");
    await makePatternImage(basePath, 512, 512);
    await sharp(basePath).resize(544, 544).toFile(candPath);

    const summary = await validateStructureStageAware({
      stage: "stage2",
      baselinePath: basePath,
      candidatePath: candPath,
      mode: "block",
      sceneType: "interior",
    });

    const dimTrigger = summary.triggers.find(t => t.id.startsWith("dimension"));
    expect(dimTrigger?.fatal).toBe(false);
    expect(dimTrigger?.nonBlocking).toBe(true);
    expect(summary.passed).toBe(true);
  });

  test("aspect ratio change beyond tolerance is fatal", async () => {
    primeStageAwareEnv();

    const { basePath, candPath } = makeTempPaths("stageaware-dim-ar-");
    await makePatternImage(basePath, 100, 100);
    await makePatternImage(candPath, 110, 90);

    const summary = await validateStructureStageAware({
      stage: "stage2",
      baselinePath: basePath,
      candidatePath: candPath,
      mode: "block",
      sceneType: "interior",
    });

    const dimTrigger = summary.triggers.find(t => t.id.startsWith("dimension"));
    expect(dimTrigger?.fatal).toBe(true);
    expect(summary.risk).toBe(true);
    expect(summary.passed).toBe(false);
  });

  test("large delta with preserved AR is fatal", async () => {
    primeStageAwareEnv();

    const { basePath, candPath } = makeTempPaths("stageaware-dim-large-");
    await makePatternImage(basePath, 100, 100);
    await sharp(basePath).resize(115, 115).toFile(candPath);

    const summary = await validateStructureStageAware({
      stage: "stage2",
      baselinePath: basePath,
      candidatePath: candPath,
      mode: "block",
      sceneType: "interior",
    });

    const dimTrigger = summary.triggers.find(t => t.id.startsWith("dimension"));
    expect(dimTrigger?.fatal).toBe(true);
    expect(summary.passed).toBe(false);
  });

  test("dimension mismatch normalization feeds IoU instead of skipping", async () => {
    primeStageAwareEnv();
    process.env.STRUCT_VALIDATION_STAGE2_EDGE_IOU_MIN = "0";
    process.env.STRUCT_VALIDATION_STAGE2_STRUCT_IOU_MIN = "0";

    const { basePath, candPath } = makeTempPaths("stageaware-dim-norm-");
    await makePatternImage(basePath, 160, 120);
    await sharp(basePath).resize(164, 123).toFile(candPath);

    const summary = await validateStructureStageAware({
      stage: "stage2",
      baselinePath: basePath,
      candidatePath: candPath,
      mode: "block",
      sceneType: "interior",
    });

    expect(summary.debug.structuralIoUSkipped).not.toBe(true);
    expect(summary.metrics.structuralIoU).toBeDefined();
  });
});
