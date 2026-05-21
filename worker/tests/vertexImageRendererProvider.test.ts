import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";

const mockRequest = jest.fn();
const mockNLog = jest.fn();

jest.mock("../src/providers/vertex/adc", () => ({
  getVertexGenAiClient: jest.fn(() => ({
    apiClient: {
      request: mockRequest,
    },
  })),
  getVertexProjectConfig: jest.fn(() => ({
    project: "test-project",
    location: "us-central1",
  })),
}));

jest.mock("../src/logger", () => ({
  nLog: mockNLog,
}));

import {
  resolveNearestImagenAspectRatio,
  VertexImageRendererProvider,
} from "../src/providers/vertex/imageRendererProvider";

async function makeImageFile(
  name: string,
  options?: {
    width?: number;
    height?: number;
    channels?: 3 | 4;
    background?: { r: number; g: number; b: number; alpha?: number };
  }
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `vertex-renderer-${name}-`));
  const filePath = path.join(tempDir, `${name}.png`);
  await sharp({
    create: {
      width: options?.width ?? 8,
      height: options?.height ?? 8,
      channels: options?.channels ?? 3,
      background: options?.background ?? { r: 100, g: 120, b: 140 },
    },
  }).png().toFile(filePath);

  return {
    filePath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function makePngBuffer(): Promise<Buffer> {
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  }).png().toBuffer();
}

describe("vertex image renderer preflight", () => {
  const originalFlatSchemaEnv = process.env.VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA;
  const originalAspectRatioNormalizationEnv = process.env.VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    if (originalFlatSchemaEnv === undefined) {
      delete process.env.VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA;
    } else {
      process.env.VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA = originalFlatSchemaEnv;
    }
    if (originalAspectRatioNormalizationEnv === undefined) {
      delete process.env.VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION;
    } else {
      process.env.VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION = originalAspectRatioNormalizationEnv;
    }
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it("resolves 3:2 landscape dimensions to the nearest supported 4:3 canvas", () => {
    expect(resolveNearestImagenAspectRatio(2048, 1365)).toEqual({
      originalWidth: 2048,
      originalHeight: 1365,
      originalRatio: 2048 / 1365,
      targetWidth: 2048,
      targetHeight: 1536,
      paddedWidth: 2048,
      paddedHeight: 1536,
      targetRatio: 4 / 3,
      targetAspectRatio: "4:3",
      padLeft: 0,
      padRight: 0,
      padTop: 85,
      padBottom: 86,
      normalizationApplied: true,
    });
  });

  it("resolves portrait dimensions to the nearest supported 3:4 canvas", () => {
    expect(resolveNearestImagenAspectRatio(1365, 2048)).toEqual({
      originalWidth: 1365,
      originalHeight: 2048,
      originalRatio: 1365 / 2048,
      targetWidth: 1536,
      targetHeight: 2048,
      paddedWidth: 1536,
      paddedHeight: 2048,
      targetRatio: 3 / 4,
      targetAspectRatio: "3:4",
      padLeft: 85,
      padRight: 86,
      padTop: 0,
      padBottom: 0,
      normalizationApplied: true,
    });
  });

  it("fails before Vertex request when the source image file is empty", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-renderer-empty-"));
    const emptySourcePath = path.join(tempDir, "source.png");
    await fs.writeFile(emptySourcePath, Buffer.alloc(0));
    const mask = await makeImageFile("mask");

    const provider = new VertexImageRendererProvider();

    await expect(provider.render({
      sourceImage: {
        kind: "local",
        localPath: emptySourcePath,
        mimeType: "image/png",
        sourceLabel: "secondary-continuity-source",
      },
      maskImage: {
        kind: "local",
        localPath: mask.filePath,
        mimeType: "image/png",
        sourceLabel: "continuity-mask",
      },
      outputPath: path.join(tempDir, "out.webp"),
      prompt: "test prompt",
      jobId: "job-render-preflight",
      imageId: "img-render-preflight",
      renderMode: "full_secondary_continuity",
    })).rejects.toMatchObject({
      name: "VertexSecondaryContinuityError",
      code: "imagen_source_image_empty_local_file",
    });

    expect(mockRequest).not.toHaveBeenCalled();

    await mask.cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("serializes referenceImages with proto image fields and decoder-verified mime", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-renderer-mime-"));
    const sourcePath = path.join(tempDir, "source-misleading.jpg");
    await fs.writeFile(sourcePath, await makePngBuffer());
    const mask = await makeImageFile("mask-mime");
    const generated = await makePngBuffer();

    mockRequest.mockImplementation(async (request: { body: string }) => ({
      json: async () => ({
        predictions: [
          {
            bytesBase64Encoded: generated.toString("base64"),
            mimeType: "image/png",
          },
        ],
      }),
    }));

    const provider = new VertexImageRendererProvider();
    const outputPath = path.join(tempDir, "out.webp");

    await provider.render({
      sourceImage: {
        kind: "local",
        localPath: sourcePath,
        mimeType: "image/jpeg",
        sourceLabel: "secondary-continuity-source",
      },
      maskImage: {
        kind: "local",
        localPath: mask.filePath,
        mimeType: "image/png",
        sourceLabel: "continuity-mask",
      },
      outputPath,
      prompt: "test prompt",
      jobId: "job-render-mime",
      imageId: "img-render-mime",
      renderMode: "full_secondary_continuity",
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockRequest.mock.calls[0][0].body);
    expect(body.instances[0].prompt).toContain("test prompt");
    expect(Array.isArray(body.instances[0].referenceImages)).toBe(true);
    expect(body.instances[0].referenceImages).toHaveLength(2);

    expect(body.instances[0].referenceImages[0].referenceType).toBe("REFERENCE_TYPE_RAW");
    expect(body.instances[0].referenceImages[0].referenceImage.mimeType).toBe("image/png");
    expect(typeof body.instances[0].referenceImages[0].referenceImage.bytesBase64Encoded).toBe("string");
    expect(body.instances[0].referenceImages[0].referenceImage.bytesBase64Encoded.length).toBeGreaterThan(0);
    expect(body.instances[0].referenceImages[0].image).toBeUndefined();
    expect(body.instances[0].referenceImages[0].rawReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[0].maskReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[0].config).toBeUndefined();

    expect(body.instances[0].referenceImages[1].referenceType).toBe("REFERENCE_TYPE_MASK");
    expect(body.instances[0].referenceImages[1].referenceImage.mimeType).toBe("image/png");
    expect(typeof body.instances[0].referenceImages[1].referenceImage.bytesBase64Encoded).toBe("string");
    expect(body.instances[0].referenceImages[1].referenceImage.bytesBase64Encoded.length).toBeGreaterThan(0);
    expect(body.instances[0].referenceImages[1].maskImageConfig.maskMode).toBe("MASK_MODE_USER_PROVIDED");
    expect(body.instances[0].referenceImages[1].image).toBeUndefined();
    expect(body.instances[0].referenceImages[1].rawReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[1].maskReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[1].config).toBeUndefined();

    expect(body.parameters.editMode).toBe("EDIT_MODE_DEFAULT");
    expect(body.parameters.numberOfImages).toBe(1);
    expect(body.parameters.maskMode).toBeUndefined();
    expect(body.parameters.outputOptions).toBeUndefined();

    const sdkRequestLogCall = mockNLog.mock.calls.find((call) => call[0] === "[VERTEX_CONTINUITY_RENDER_SDK_REQUEST]");
    expect(sdkRequestLogCall).toBeDefined();

    const sdkRequestLogPayload = sdkRequestLogCall?.[1];
    expect(sdkRequestLogPayload.payloadSchemaMode).toBe("flat");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"bytesBase64Encoded\":\"<base64:");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"payloadSchemaMode\":\"flat\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"referenceImage\":{\"mimeType\":\"image/png\",\"bytesBase64Encoded\":\"<base64:");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"maskImageConfig\":{\"maskMode\":\"MASK_MODE_USER_PROVIDED\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).not.toContain("\"rawReferenceImage\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).not.toContain("\"maskReferenceImage\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"referenceType\":\"REFERENCE_TYPE_RAW\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"referenceType\":\"REFERENCE_TYPE_MASK\"");

    const finalPayloadLogCall = consoleLogSpy.mock.calls.find((call) => call[0] === "[IMAGEN_FINAL_PAYLOAD]");
    expect(finalPayloadLogCall).toBeDefined();
    expect(finalPayloadLogCall?.[1]).toContain('"model": "imagen-3.0-capability-001"');
    expect(finalPayloadLogCall?.[1]).toContain('"referenceImage": {');
    expect(finalPayloadLogCall?.[1]).toContain('"maskImageConfig": {');
    expect(finalPayloadLogCall?.[1]).not.toContain('"rawReferenceImage": {');

    const referenceSchemaLogCall = consoleLogSpy.mock.calls.find((call) => call[0] === "[REFERENCE_SCHEMA_DEBUG]");
    expect(referenceSchemaLogCall?.[1]).toMatchObject({
      flatSchemaEnabled: undefined,
      hasReferenceImages: true,
      referenceImagesCount: 2,
      firstReferenceKeys: ["referenceId", "referenceType", "referenceImage"],
    });
    expect(referenceSchemaLogCall?.[1].nestedImageKeys).toEqual(expect.arrayContaining(["bytesBase64Encoded", "mimeType"]));

    const referenceValidationLogCall = consoleLogSpy.mock.calls.find((call) => call[0] === "[REFERENCE_IMAGE_VALIDATION]");
    expect(referenceValidationLogCall?.[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        index: 0,
        referenceType: "REFERENCE_TYPE_RAW",
        hasBytesBase64Encoded: true,
      }),
      expect.objectContaining({
        index: 1,
        referenceType: "REFERENCE_TYPE_MASK",
        hasBytesBase64Encoded: true,
      }),
    ]));

    const payloadFingerprintLogCall = consoleLogSpy.mock.calls.find((call) => call[0] === "[IMAGEN_PAYLOAD_FINGERPRINT]");
    expect(payloadFingerprintLogCall?.[1]).toMatchObject({
      hasInstances: true,
      hasParameters: true,
      hasReferenceImages: true,
      topLevelKeys: ["instances", "parameters"],
    });

    await mask.cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps the verified referenceImage schema when the probe flag is enabled", async () => {
    process.env.VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA = "true";

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-renderer-flat-"));
    const sourcePath = path.join(tempDir, "source-flat.jpg");
    await fs.writeFile(sourcePath, await makePngBuffer());
    const mask = await makeImageFile("mask-flat");
    const generated = await makePngBuffer();

    mockRequest.mockImplementation(async () => ({
      json: async () => ({
        predictions: [
          {
            bytesBase64Encoded: generated.toString("base64"),
            mimeType: "image/png",
          },
        ],
      }),
    }));

    const provider = new VertexImageRendererProvider();
    const outputPath = path.join(tempDir, "out.webp");

    await provider.render({
      sourceImage: {
        kind: "local",
        localPath: sourcePath,
        mimeType: "image/jpeg",
        sourceLabel: "secondary-continuity-source",
      },
      maskImage: {
        kind: "local",
        localPath: mask.filePath,
        mimeType: "image/png",
        sourceLabel: "continuity-mask",
      },
      outputPath,
      prompt: "test prompt",
      jobId: "job-render-flat",
      imageId: "img-render-flat",
      renderMode: "full_secondary_continuity",
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockRequest.mock.calls[0][0].body);
    expect(body.instances[0].referenceImages).toHaveLength(2);

    expect(body.instances[0].referenceImages[0].referenceType).toBe("REFERENCE_TYPE_RAW");
    expect(body.instances[0].referenceImages[0].referenceImage.mimeType).toBe("image/png");
    expect(typeof body.instances[0].referenceImages[0].referenceImage.bytesBase64Encoded).toBe("string");
    expect(body.instances[0].referenceImages[0].image).toBeUndefined();
    expect(body.instances[0].referenceImages[0].rawReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[0].maskReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[0].config).toBeUndefined();

    expect(body.instances[0].referenceImages[1].referenceType).toBe("REFERENCE_TYPE_MASK");
    expect(body.instances[0].referenceImages[1].referenceImage.mimeType).toBe("image/png");
    expect(typeof body.instances[0].referenceImages[1].referenceImage.bytesBase64Encoded).toBe("string");
    expect(body.instances[0].referenceImages[1].maskImageConfig.maskMode).toBe("MASK_MODE_USER_PROVIDED");
    expect(body.instances[0].referenceImages[1].image).toBeUndefined();
    expect(body.instances[0].referenceImages[1].rawReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[1].maskReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[1].config).toBeUndefined();

    expect(body.parameters.editMode).toBe("EDIT_MODE_DEFAULT");
    expect(body.parameters.numberOfImages).toBe(1);
    expect(body.parameters.maskMode).toBeUndefined();
    expect(body.parameters.outputOptions).toBeUndefined();

    const sdkRequestLogCall = mockNLog.mock.calls.find((call) => call[0] === "[VERTEX_CONTINUITY_RENDER_SDK_REQUEST]");
    expect(sdkRequestLogCall).toBeDefined();

    const sdkRequestLogPayload = sdkRequestLogCall?.[1];
    expect(sdkRequestLogPayload.payloadSchemaMode).toBe("flat");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"payloadSchemaMode\":\"flat\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"referenceImage\":{\"mimeType\":\"image/png\",\"bytesBase64Encoded\":\"<base64:");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"maskImageConfig\":{\"maskMode\":\"MASK_MODE_USER_PROVIDED\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).not.toContain("\"rawReferenceImage\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).not.toContain("\"maskReferenceImage\"");

    const finalPayloadLogCall = consoleLogSpy.mock.calls.find((call) => call[0] === "[IMAGEN_FINAL_PAYLOAD]");
    expect(finalPayloadLogCall).toBeDefined();
    expect(finalPayloadLogCall?.[1]).toContain('"referenceImage": {');
    expect(finalPayloadLogCall?.[1]).toContain('"maskImageConfig": {');
    expect(finalPayloadLogCall?.[1]).not.toContain('"rawReferenceImage": {');

    const referenceSchemaLogCall = consoleLogSpy.mock.calls.find((call) => call[0] === "[REFERENCE_SCHEMA_DEBUG]");
    expect(referenceSchemaLogCall?.[1]).toMatchObject({
      flatSchemaEnabled: "true",
      hasReferenceImages: true,
      referenceImagesCount: 2,
      firstReferenceKeys: ["referenceId", "referenceType", "referenceImage"],
    });
    expect(referenceSchemaLogCall?.[1].nestedImageKeys).toEqual(expect.arrayContaining(["bytesBase64Encoded", "mimeType"]));

    const referenceValidationLogCall = consoleLogSpy.mock.calls.find((call) => call[0] === "[REFERENCE_IMAGE_VALIDATION]");
    expect(referenceValidationLogCall?.[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        index: 0,
        imageKeys: ["bytesBase64Encoded", "mimeType"],
        referenceType: "REFERENCE_TYPE_RAW",
        hasBytesBase64Encoded: true,
      }),
      expect.objectContaining({
        index: 1,
        imageKeys: ["bytesBase64Encoded", "mimeType"],
        referenceType: "REFERENCE_TYPE_MASK",
        hasBytesBase64Encoded: true,
      }),
    ]));

    await mask.cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("pads unsupported source and mask identically and restores the original crop after render", async () => {
    process.env.VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION = "true";

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-renderer-aspect-"));
    const source = await makeImageFile("source-aspect", {
      width: 6,
      height: 4,
      background: { r: 20, g: 40, b: 200 },
    });
    const mask = await makeImageFile("mask-aspect", {
      width: 6,
      height: 4,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
    const generated = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 6,
              height: 4,
              channels: 4,
              background: { r: 0, g: 255, b: 0, alpha: 1 },
            },
          }).png().toBuffer(),
          left: 1,
          top: 1,
        },
      ])
      .png()
      .toBuffer();

    mockRequest.mockImplementation(async (request: { body: string }) => ({
      json: async () => ({
        predictions: [
          {
            bytesBase64Encoded: generated.toString("base64"),
            mimeType: "image/png",
          },
        ],
      }),
    }));

    const provider = new VertexImageRendererProvider();
    const outputPath = path.join(tempDir, "out.webp");

    await provider.render({
      sourceImage: {
        kind: "local",
        localPath: source.filePath,
        mimeType: "image/png",
        sourceLabel: "secondary-continuity-source",
      },
      maskImage: {
        kind: "local",
        localPath: mask.filePath,
        mimeType: "image/png",
        sourceLabel: "continuity-mask",
      },
      outputPath,
      prompt: "test prompt",
      jobId: "job-render-aspect",
      imageId: "img-render-aspect",
      renderMode: "full_secondary_continuity",
    });

    const body = JSON.parse(mockRequest.mock.calls[0][0].body);
    const sourceBytes = body.instances[0].referenceImages[0].referenceImage.bytesBase64Encoded;
    const maskBytes = body.instances[0].referenceImages[1].referenceImage.bytesBase64Encoded;
    const sourceMetadata = await sharp(Buffer.from(sourceBytes, "base64")).metadata();
    const maskMetadata = await sharp(Buffer.from(maskBytes, "base64")).metadata();

    expect(sourceMetadata.width).toBe(8);
    expect(sourceMetadata.height).toBe(6);
    expect(maskMetadata.width).toBe(8);
    expect(maskMetadata.height).toBe(6);

    const normalizationLogCall = mockNLog.mock.calls.find((call) => call[0] === "[VERTEX_ASPECT_RATIO_NORMALIZATION]");
    expect(normalizationLogCall).toBeDefined();
    expect(normalizationLogCall?.[1]).toMatchObject({
      featureEnabled: true,
      normalizationApplied: true,
      originalDimensions: { width: 6, height: 4 },
      paddedDimensions: { width: 8, height: 6 },
      paddingApplied: { left: 1, right: 1, top: 1, bottom: 1 },
      targetRatio: "4:3",
    });

    const restorationLogCall = mockNLog.mock.calls.find((call) => call[0] === "[VERTEX_ASPECT_RATIO_RESTORATION]");
    expect(restorationLogCall).toBeDefined();
    expect(restorationLogCall?.[1]).toMatchObject({
      normalizationApplied: true,
      originalDimensions: { width: 6, height: 4 },
      paddedDimensions: { width: 8, height: 6 },
      crop: { left: 1, top: 1, width: 6, height: 4 },
      targetRatio: "4:3",
    });

    const outputMetadata = await sharp(outputPath).metadata();
    expect(outputMetadata.width).toBe(6);
    expect(outputMetadata.height).toBe(4);

    const outputPixels = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
    expect(outputPixels.info.width).toBe(6);
    expect(outputPixels.info.height).toBe(4);
    expect(outputPixels.data[1]).toBeGreaterThan(outputPixels.data[0]);
    expect(outputPixels.data[1]).toBeGreaterThan(outputPixels.data[2]);

    await source.cleanup();
    await mask.cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not pad already supported aspect ratios", async () => {
    process.env.VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION = "true";

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-renderer-supported-"));
    const source = await makeImageFile("source-supported", {
      width: 8,
      height: 6,
      background: { r: 20, g: 40, b: 200 },
    });
    const mask = await makeImageFile("mask-supported", {
      width: 8,
      height: 6,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
    const generated = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    }).png().toBuffer();

    mockRequest.mockImplementation(async () => ({
      json: async () => ({
        predictions: [
          {
            bytesBase64Encoded: generated.toString("base64"),
            mimeType: "image/png",
          },
        ],
      }),
    }));

    const provider = new VertexImageRendererProvider();
    const outputPath = path.join(tempDir, "out.webp");

    await provider.render({
      sourceImage: {
        kind: "local",
        localPath: source.filePath,
        mimeType: "image/png",
        sourceLabel: "secondary-continuity-source",
      },
      maskImage: {
        kind: "local",
        localPath: mask.filePath,
        mimeType: "image/png",
        sourceLabel: "continuity-mask",
      },
      outputPath,
      prompt: "test prompt",
      jobId: "job-render-supported",
      imageId: "img-render-supported",
      renderMode: "full_secondary_continuity",
    });

    const normalizationLogCall = mockNLog.mock.calls.find((call) => call[0] === "[VERTEX_ASPECT_RATIO_NORMALIZATION]");
    expect(normalizationLogCall).toBeDefined();
    expect(normalizationLogCall?.[1]).toMatchObject({
      featureEnabled: true,
      normalizationApplied: false,
      originalDimensions: { width: 8, height: 6 },
      paddedDimensions: { width: 8, height: 6 },
      paddingApplied: { left: 0, right: 0, top: 0, bottom: 0 },
      targetRatio: "4:3",
    });

    const outputMetadata = await sharp(outputPath).metadata();
    expect(outputMetadata.width).toBe(8);
    expect(outputMetadata.height).toBe(6);

    await source.cleanup();
    await mask.cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});