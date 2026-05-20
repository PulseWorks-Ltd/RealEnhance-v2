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

import { VertexImageRendererProvider } from "../src/providers/vertex/imageRendererProvider";

async function makeImageFile(name: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `vertex-renderer-${name}-`));
  const filePath = path.join(tempDir, `${name}.png`);
  await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 100, g: 120, b: 140 },
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

  beforeEach(() => {
    jest.clearAllMocks();
    if (originalFlatSchemaEnv === undefined) {
      delete process.env.VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA;
    } else {
      process.env.VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA = originalFlatSchemaEnv;
    }
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

    expect(body.instances[0].referenceImages[0].config).toBeUndefined();
    expect(body.instances[0].referenceImages[0].referenceType).toBe("REFERENCE_TYPE_RAW");
    expect(body.instances[0].referenceImages[0].referenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[0].rawReferenceImage.image.mimeType).toBe("image/png");
    expect(typeof body.instances[0].referenceImages[0].rawReferenceImage.image.bytesBase64Encoded).toBe("string");
    expect(body.instances[0].referenceImages[0].rawReferenceImage.image.bytesBase64Encoded.length).toBeGreaterThan(0);

    expect(body.instances[0].referenceImages[1].referenceType).toBe("REFERENCE_TYPE_MASK");
    expect(body.instances[0].referenceImages[1].config).toBeUndefined();
    expect(body.instances[0].referenceImages[1].maskReferenceImage.maskMode).toBe("MASK_MODE_USER_PROVIDED");
    expect(body.instances[0].referenceImages[1].maskReferenceImage.image.mimeType).toBe("image/png");
    expect(typeof body.instances[0].referenceImages[1].maskReferenceImage.image.bytesBase64Encoded).toBe("string");
    expect(body.instances[0].referenceImages[1].maskReferenceImage.image.bytesBase64Encoded.length).toBeGreaterThan(0);
    expect(body.instances[0].referenceImages[1].maskReferenceImage.referenceImage).toBeUndefined();

    expect(body.parameters.editMode).toBe("EDIT_MODE_INPAINT_INSERTION");
    expect(body.parameters.maskMode).toBeUndefined();
    expect(body.parameters.outputOptions.mimeType).toBe("image/png");

    const sdkRequestLogCall = mockNLog.mock.calls.find((call) => call[0] === "[VERTEX_CONTINUITY_RENDER_SDK_REQUEST]");
    expect(sdkRequestLogCall).toBeDefined();

    const sdkRequestLogPayload = sdkRequestLogCall?.[1];
    expect(sdkRequestLogPayload.payloadSchemaMode).toBe("wrapper");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"bytesBase64Encoded\":\"<base64:");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"payloadSchemaMode\":\"wrapper\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"rawReferenceImage\":{\"image\":");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"maskReferenceImage\":{\"maskMode\":\"MASK_MODE_USER_PROVIDED\",\"image\":");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).not.toContain("\"referenceImage\":{\"mimeType\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"referenceType\":\"REFERENCE_TYPE_RAW\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"referenceType\":\"REFERENCE_TYPE_MASK\"");

    await mask.cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("switches to flat referenceImages schema when the probe flag is enabled", async () => {
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
    expect(body.instances[0].referenceImages[0].rawReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[0].maskReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[0].config).toBeUndefined();

    expect(body.instances[0].referenceImages[1].referenceType).toBe("REFERENCE_TYPE_MASK");
    expect(body.instances[0].referenceImages[1].referenceImage.mimeType).toBe("image/png");
    expect(typeof body.instances[0].referenceImages[1].referenceImage.bytesBase64Encoded).toBe("string");
    expect(body.instances[0].referenceImages[1].config.maskMode).toBe("MASK_MODE_USER_PROVIDED");
    expect(body.instances[0].referenceImages[1].rawReferenceImage).toBeUndefined();
    expect(body.instances[0].referenceImages[1].maskReferenceImage).toBeUndefined();

    expect(body.parameters.editMode).toBe("EDIT_MODE_INPAINT_INSERTION");
    expect(body.parameters.maskMode).toBeUndefined();
    expect(body.parameters.outputOptions.mimeType).toBe("image/png");

    const sdkRequestLogCall = mockNLog.mock.calls.find((call) => call[0] === "[VERTEX_CONTINUITY_RENDER_SDK_REQUEST]");
    expect(sdkRequestLogCall).toBeDefined();

    const sdkRequestLogPayload = sdkRequestLogCall?.[1];
    expect(sdkRequestLogPayload.payloadSchemaMode).toBe("flat");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"payloadSchemaMode\":\"flat\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"referenceImage\":{\"mimeType\":\"image/png\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).toContain("\"config\":{\"maskMode\":\"MASK_MODE_USER_PROVIDED\"}");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).not.toContain("\"rawReferenceImage\"");
    expect(sdkRequestLogPayload.sdkRequest.bodyJsonRedacted).not.toContain("\"maskReferenceImage\"");

    await mask.cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});