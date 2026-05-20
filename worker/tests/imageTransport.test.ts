import fs from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import sharp from "sharp";

const mockUpload = jest.fn();
const mockExists = jest.fn();
const mockGetMetadata = jest.fn();
const mockCreateReadStream = jest.fn();
const mockDownload = jest.fn();
const mockFile = {
  exists: mockExists,
  getMetadata: mockGetMetadata,
  createReadStream: mockCreateReadStream,
  download: mockDownload,
};
const mockBucket = {
  upload: mockUpload,
  file: jest.fn(() => mockFile),
};
const mockStorageClient = {
  bucket: jest.fn(() => mockBucket),
};

jest.mock("@google-cloud/storage", () => ({
  Storage: jest.fn(() => mockStorageClient),
  File: class File {},
}));

import { ensureLocalImagePath, loadImageReference, persistRemoteImage } from "../src/providers/imageTransport";

async function makeImageFile(name: string, format: "jpeg" | "png" | "webp" = "png"): Promise<{ filePath: string; sizeBytes: number }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-transport-test-"));
  const filePath = path.join(tempDir, `${name}.${format}`);
  const pipeline = sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 64, g: 128, b: 192 },
    },
  });
  if (format === "png") {
    await pipeline.png().toFile(filePath);
  } else if (format === "jpeg") {
    await pipeline.jpeg().toFile(filePath);
  } else {
    await pipeline.webp().toFile(filePath);
  }
  const stats = await fs.stat(filePath);
  return { filePath, sizeBytes: stats.size };
}

describe("image transport validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VERTEX_GCS_BUCKET = "continuity-test-bucket";
    mockExists.mockResolvedValue([true]);
    mockGetMetadata.mockResolvedValue([{ size: "68", contentType: "image/png" }]);
    mockCreateReadStream.mockImplementation(() => Readable.from(Buffer.from([1])));
    mockDownload.mockResolvedValue(undefined);
    mockUpload.mockResolvedValue(undefined);
  });

  it("rejects empty local artifacts before upload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-transport-empty-"));
    const emptyPath = path.join(tempDir, "empty.png");
    await fs.writeFile(emptyPath, Buffer.alloc(0));

    await expect(
      persistRemoteImage({
        sourceLabel: "secondary-continuity-source",
        localPath: emptyPath,
        artifactName: "empty.png",
        jobId: "job-empty",
        imageId: "image-empty",
      })
    ).rejects.toThrow("local artifact is empty");

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("verifies uploaded GCS artifacts before returning an authoritative manifest", async () => {
    const { filePath, sizeBytes } = await makeImageFile("authoritative", "png");
    mockGetMetadata.mockResolvedValue([{ size: String(sizeBytes), contentType: "image/png" }]);

    const result = await persistRemoteImage({
      sourceLabel: "secondary-continuity-source",
      localPath: filePath,
      artifactName: "authoritative.png",
      jobId: "job-upload",
      imageId: "image-upload",
      continuityGroupId: "group-upload",
    });

    expect(result.kind).toBe("gcs");
    expect(result.uri).toBe("gs://continuity-test-bucket/vertex-secondary-continuity/job-upload/image-upload/group-upload/authoritative.png");
    expect(result.mimeType).toBe("image/png");
    expect(mockUpload).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({
        destination: "vertex-secondary-continuity/job-upload/image-upload/group-upload/authoritative.png",
        contentType: "image/png",
      })
    );
    expect(mockExists).toHaveBeenCalled();
    expect(mockGetMetadata).toHaveBeenCalled();
    expect(mockCreateReadStream).toHaveBeenCalled();
  });

  it("normalizes persisted artifact extensions to the decoded local mime type", async () => {
    const { filePath, sizeBytes } = await makeImageFile("retry-stage1a", "jpeg");
    mockGetMetadata.mockResolvedValue([{ size: String(sizeBytes), contentType: "image/jpeg" }]);

    const result = await persistRemoteImage({
      sourceLabel: "secondary-continuity-source",
      localPath: filePath,
      artifactName: "retry-stage1a.webp",
      jobId: "job-retry",
      imageId: "image-retry",
      continuityGroupId: "group-retry",
    });

    expect(result.uri).toBe("gs://continuity-test-bucket/vertex-secondary-continuity/job-retry/image-retry/group-retry/retry-stage1a.jpg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(mockUpload).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({
        destination: "vertex-secondary-continuity/job-retry/image-retry/group-retry/retry-stage1a.jpg",
        contentType: "image/jpeg",
      })
    );
  });

  it("normalizes stale declared mime types to the decoded local mime type during upload", async () => {
    const { filePath, sizeBytes } = await makeImageFile("mismatch-source", "png");
    mockGetMetadata.mockResolvedValue([{ size: String(sizeBytes), contentType: "image/png" }]);

    const result = await persistRemoteImage({
      sourceLabel: "secondary-continuity-source",
      localPath: filePath,
      uri: undefined,
      artifactName: "mismatch-source.webp",
      jobId: "job-mismatch",
      imageId: "image-mismatch",
      continuityGroupId: "group-mismatch",
    });

    expect(result.mimeType).toBe("image/png");
    expect(result.uri).toBe("gs://continuity-test-bucket/vertex-secondary-continuity/job-mismatch/image-mismatch/group-mismatch/mismatch-source.png");
    expect(mockUpload).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({
        destination: "vertex-secondary-continuity/job-mismatch/image-mismatch/group-mismatch/mismatch-source.png",
        contentType: "image/png",
      })
    );
  });

  it("returns decoded mime type for local references even when the declared mime is stale", async () => {
    const { filePath } = await makeImageFile("local-mismatch", "png");

    const result = await loadImageReference({
      sourceLabel: "secondary-continuity-source",
      localPath: filePath,
      mimeType: "image/webp",
      jobId: "job-local-mismatch",
      imageId: "image-local-mismatch",
      continuityGroupId: "group-local-mismatch",
    });

    expect(result).toMatchObject({
      kind: "local",
      localPath: filePath,
      mimeType: "image/png",
    });
  });

  it("rejects preexisting remote manifests with invalid image metadata", async () => {
    mockGetMetadata.mockResolvedValue([{ size: "68", contentType: "application/octet-stream" }]);

    await expect(
      persistRemoteImage({
        sourceLabel: "secondary-continuity-source",
        uri: "gs://continuity-test-bucket/existing/object.bin",
        artifactName: "object.bin",
        jobId: "job-remote",
        imageId: "image-remote",
      })
    ).rejects.toThrow("unsupported image mime type");
  });

  it("hydrates gs:// references into validated local files", async () => {
    const { sizeBytes } = await makeImageFile("download-source", "png");
    const pngBuffer = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 12, g: 24, b: 36 },
      },
    }).png().toBuffer();

    mockDownload.mockImplementation(async ({ destination }: { destination: string }) => {
      await fs.writeFile(destination, pngBuffer);
    });
    mockGetMetadata.mockResolvedValue([{ size: String(sizeBytes), contentType: "image/png" }]);

    const hydratedPath = await ensureLocalImagePath({
      reference: {
        kind: "gcs",
        uri: "gs://continuity-test-bucket/remote/download-source.png",
        mimeType: "image/png",
        sourceLabel: "continuity-render-output",
      },
      sourceLabel: "continuity-render-output",
      jobId: "job-download",
      imageId: "image-download",
      continuityGroupId: "group-download",
    });

    const stats = await fs.stat(hydratedPath);
    expect(stats.size).toBeGreaterThan(0);
    expect(mockDownload).toHaveBeenCalled();
  });
});