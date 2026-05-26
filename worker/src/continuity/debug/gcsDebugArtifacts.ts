import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { Storage } from "@google-cloud/storage";
import { nLog } from "../../logger";

const DEFAULT_DEBUG_BUCKET = "realenhance-vertex-continuity";
const DEFAULT_DEBUG_BASE_PREFIX = "vertex-secondary-continuity";
const DEBUG_RENDER_ROOT = "debug-renders";
const DEBUG_MASK_EVOLUTION_ROOT = "debug-mask-evolution";

type UploadedArtifact = {
  artifactType: string;
  gcsUri: string;
  signedUrl: string | null;
};

type RenderArtifactMetadata = {
  validationPassed: boolean;
  failureReason: string | null;
  mae: number | null;
  ratio: number | null;
  renderMode: string;
  model: string;
  continuityGroupId: string;
};

let storageClient: Storage | null = null;

function getStorageClient(): Storage {
  if (storageClient) {
    return storageClient;
  }
  const projectId = String(process.env.GOOGLE_CLOUD_PROJECT || "").trim() || undefined;
  storageClient = new Storage(projectId ? { projectId } : undefined);
  return storageClient;
}

function sanitizeSegment(value: string | null | undefined, fallback: string): string {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

function getDebugBucketName(): string {
  const envBucket = String(process.env.VERTEX_CONTINUITY_DEBUG_BUCKET || "").trim();
  return envBucket || DEFAULT_DEBUG_BUCKET;
}

function getDebugBasePrefix(): string {
  const raw = String(process.env.VERTEX_CONTINUITY_DEBUG_BASE_PREFIX || DEFAULT_DEBUG_BASE_PREFIX).trim();
  return raw.replace(/^\/+|\/+$/g, "");
}

function getSignedUrlTtlSeconds(): number {
  const configured = Number(process.env.VERTEX_CONTINUITY_DEBUG_SIGNED_URL_TTL_SECONDS || 86400);
  if (!Number.isFinite(configured)) {
    return 86400;
  }
  return Math.max(60, Math.floor(configured));
}

async function maybeGenerateSignedUrl(bucketName: string, objectPath: string): Promise<string | null> {
  const signedUrlToggle = String(process.env.VERTEX_CONTINUITY_DEBUG_SIGNED_URLS || "true").trim().toLowerCase();
  if (signedUrlToggle === "0" || signedUrlToggle === "false" || signedUrlToggle === "off") {
    return null;
  }
  try {
    const file = getStorageClient().bucket(bucketName).file(objectPath);
    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + (getSignedUrlTtlSeconds() * 1000),
    });
    return signedUrl;
  } catch {
    return null;
  }
}

export async function generateVertexDebugSignedUrl(params: {
  bucketName: string;
  objectPath: string;
}): Promise<string | null> {
  return maybeGenerateSignedUrl(params.bucketName, params.objectPath);
}

async function uploadBuffer(params: {
  bucketName: string;
  objectPath: string;
  data: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
}): Promise<{ gcsUri: string; signedUrl: string | null }> {
  try {
    const bucket = getStorageClient().bucket(params.bucketName);
    const file = bucket.file(params.objectPath);
    await file.save(params.data, {
      resumable: false,
      contentType: params.contentType,
      metadata: {
        cacheControl: "private, max-age=86400",
        metadata: params.metadata,
      },
    });
    const signedUrl = await maybeGenerateSignedUrl(params.bucketName, params.objectPath);
    return {
      gcsUri: `gs://${params.bucketName}/${params.objectPath}`,
      signedUrl,
    };
  } catch (error: any) {
    nLog("[FORENSIC_UPLOAD_ERROR]", {
      bucket: params.bucketName,
      objectPath: params.objectPath,
      contentType: params.contentType,
      error: error?.message || String(error),
      stack: error instanceof Error ? error.stack || null : null,
    });
    throw error;
  }
}

async function uploadJson(params: {
  bucketName: string;
  objectPath: string;
  json: unknown;
  metadata?: Record<string, string>;
}) {
  const payload = Buffer.from(`${JSON.stringify(params.json, null, 2)}\n`, "utf8");
  return uploadBuffer({
    bucketName: params.bucketName,
    objectPath: params.objectPath,
    data: payload,
    contentType: "application/json",
    metadata: params.metadata,
  });
}

async function uploadLocalImageAsPng(params: {
  bucketName: string;
  objectPath: string;
  localPath: string;
  metadata?: Record<string, string>;
}) {
  const png = await sharp(params.localPath).png().toBuffer();
  return uploadBuffer({
    bucketName: params.bucketName,
    objectPath: params.objectPath,
    data: png,
    contentType: "image/png",
    metadata: params.metadata,
  });
}

async function uploadLocalImageAsJpeg(params: {
  bucketName: string;
  objectPath: string;
  localPath: string;
  metadata?: Record<string, string>;
}) {
  const jpg = await sharp(params.localPath).jpeg({ quality: 92 }).toBuffer();
  return uploadBuffer({
    bucketName: params.bucketName,
    objectPath: params.objectPath,
    data: jpg,
    contentType: "image/jpeg",
    metadata: params.metadata,
  });
}

function buildRenderArtifactPath(params: {
  jobId: string;
  imageId: string;
  attempt: number;
  fileName: string;
}): string {
  const basePrefix = getDebugBasePrefix();
  return [
    basePrefix,
    DEBUG_RENDER_ROOT,
    sanitizeSegment(params.jobId, "unknown-job"),
    sanitizeSegment(params.imageId, "unknown-image"),
    `attempt-${Math.max(1, params.attempt)}`,
    params.fileName,
  ].filter(Boolean).join("/");
}

function buildMaskEvolutionArtifactPath(params: {
  jobId: string;
  imageId: string;
  fileName: string;
}): string {
  const basePrefix = getDebugBasePrefix();
  return [
    basePrefix,
    DEBUG_MASK_EVOLUTION_ROOT,
    sanitizeSegment(params.jobId, "unknown-job"),
    sanitizeSegment(params.imageId, "unknown-image"),
    params.fileName,
  ].filter(Boolean).join("/");
}

async function uploadAndLogRenderArtifact(params: {
  artifactType: string;
  validationPassed: boolean;
  upload: Promise<{ gcsUri: string; signedUrl: string | null }>;
}): Promise<UploadedArtifact> {
  const uploaded = await params.upload;
  nLog("[VERTEX_RENDER_ARTIFACT_PERSISTED]", {
    artifactType: params.artifactType,
    gcsUri: uploaded.gcsUri,
    signedUrl: uploaded.signedUrl,
    validationPassed: params.validationPassed,
  });
  return {
    artifactType: params.artifactType,
    gcsUri: uploaded.gcsUri,
    signedUrl: uploaded.signedUrl,
  };
}

export async function persistVertexRenderArtifacts(params: {
  jobId: string;
  imageId: string;
  attempt: number;
  continuityGroupId?: string | null;
  renderMode: string;
  model: string;
  validationPassed: boolean;
  failureReason: string | null;
  mae: number | null;
  ratio: number | null;
  sourceImagePath?: string | null;
  rawRenderPath: string;
  occupancyMaskPath?: string | null;
  exclusionMaskPath?: string | null;
  finalMaskPath?: string | null;
  outsideMaskDiffPng?: Buffer | null;
  outsideMaskHeatmapPng?: Buffer | null;
  overlayDebugPng?: Buffer | null;
  validatorMetrics?: Record<string, unknown>;
}): Promise<{ rootGcsUri: string; artifacts: UploadedArtifact[] }> {
  const bucketName = getDebugBucketName();
  const basePrefix = getDebugBasePrefix();
  const targetRootGcsPath = [
    `gs://${bucketName}`,
    basePrefix,
    DEBUG_RENDER_ROOT,
    sanitizeSegment(params.jobId, "unknown-job"),
    sanitizeSegment(params.imageId, "unknown-image"),
    `attempt-${Math.max(1, params.attempt)}`,
  ].filter(Boolean).join("/");
  nLog("[FORENSIC_ARTIFACT_PIPELINE_ACTIVE]", {
    pipeline: "render-artifacts",
    sourceFile: "worker/src/continuity/debug/gcsDebugArtifacts.ts",
    jobId: params.jobId,
    imageId: params.imageId,
    targetGcsPath: targetRootGcsPath,
  });
  nLog("[FORENSIC_RENDER_UPLOAD_BEGIN]", {
    jobId: params.jobId,
    imageId: params.imageId,
    targetGcsPath: targetRootGcsPath,
    validationPassed: params.validationPassed,
  });

  try {
  const metadata: RenderArtifactMetadata = {
    validationPassed: params.validationPassed,
    failureReason: params.failureReason,
    mae: params.mae,
    ratio: params.ratio,
    renderMode: params.renderMode,
    model: params.model,
    continuityGroupId: String(params.continuityGroupId || ""),
  };
  const encodedMetadata: Record<string, string> = {
    validationPassed: String(metadata.validationPassed),
    failureReason: metadata.failureReason || "",
    mae: metadata.mae == null ? "" : String(metadata.mae),
    ratio: metadata.ratio == null ? "" : String(metadata.ratio),
    renderMode: metadata.renderMode,
    model: metadata.model,
    continuityGroupId: metadata.continuityGroupId,
  };

  const uploads: UploadedArtifact[] = [];
  uploads.push(await uploadAndLogRenderArtifact({
    artifactType: "raw-render",
    validationPassed: params.validationPassed,
    upload: uploadLocalImageAsPng({
      bucketName,
      objectPath: buildRenderArtifactPath({
        jobId: params.jobId,
        imageId: params.imageId,
        attempt: params.attempt,
        fileName: "raw-render.png",
      }),
      localPath: params.rawRenderPath,
      metadata: encodedMetadata,
    }),
  }));

  if (params.sourceImagePath) {
    uploads.push(await uploadAndLogRenderArtifact({
      artifactType: "source-image",
      validationPassed: params.validationPassed,
      upload: uploadLocalImageAsJpeg({
        bucketName,
        objectPath: buildRenderArtifactPath({
          jobId: params.jobId,
          imageId: params.imageId,
          attempt: params.attempt,
          fileName: "source-image.jpg",
        }),
        localPath: params.sourceImagePath,
        metadata: encodedMetadata,
      }),
    }));
  }

  if (params.occupancyMaskPath) {
    uploads.push(await uploadAndLogRenderArtifact({
      artifactType: "occupancy-mask",
      validationPassed: params.validationPassed,
      upload: uploadLocalImageAsPng({
        bucketName,
        objectPath: buildRenderArtifactPath({
          jobId: params.jobId,
          imageId: params.imageId,
          attempt: params.attempt,
          fileName: "occupancy-mask.png",
        }),
        localPath: params.occupancyMaskPath,
        metadata: encodedMetadata,
      }),
    }));
  }

  if (params.exclusionMaskPath) {
    uploads.push(await uploadAndLogRenderArtifact({
      artifactType: "exclusion-mask",
      validationPassed: params.validationPassed,
      upload: uploadLocalImageAsPng({
        bucketName,
        objectPath: buildRenderArtifactPath({
          jobId: params.jobId,
          imageId: params.imageId,
          attempt: params.attempt,
          fileName: "exclusion-mask.png",
        }),
        localPath: params.exclusionMaskPath,
        metadata: encodedMetadata,
      }),
    }));
  }

  if (params.finalMaskPath) {
    uploads.push(await uploadAndLogRenderArtifact({
      artifactType: "final-mask",
      validationPassed: params.validationPassed,
      upload: uploadLocalImageAsPng({
        bucketName,
        objectPath: buildRenderArtifactPath({
          jobId: params.jobId,
          imageId: params.imageId,
          attempt: params.attempt,
          fileName: "final-mask.png",
        }),
        localPath: params.finalMaskPath,
        metadata: encodedMetadata,
      }),
    }));
  }

  if (params.outsideMaskDiffPng) {
    uploads.push(await uploadAndLogRenderArtifact({
      artifactType: "outside-mask-diff",
      validationPassed: params.validationPassed,
      upload: uploadBuffer({
        bucketName,
        objectPath: buildRenderArtifactPath({
          jobId: params.jobId,
          imageId: params.imageId,
          attempt: params.attempt,
          fileName: "outside-mask-diff.png",
        }),
        data: params.outsideMaskDiffPng,
        contentType: "image/png",
        metadata: encodedMetadata,
      }),
    }));
  }

  if (params.outsideMaskHeatmapPng) {
    uploads.push(await uploadAndLogRenderArtifact({
      artifactType: "outside-mask-heatmap",
      validationPassed: params.validationPassed,
      upload: uploadBuffer({
        bucketName,
        objectPath: buildRenderArtifactPath({
          jobId: params.jobId,
          imageId: params.imageId,
          attempt: params.attempt,
          fileName: "outside-mask-heatmap.png",
        }),
        data: params.outsideMaskHeatmapPng,
        contentType: "image/png",
        metadata: encodedMetadata,
      }),
    }));
  }

  if (params.overlayDebugPng) {
    uploads.push(await uploadAndLogRenderArtifact({
      artifactType: "overlay-debug",
      validationPassed: params.validationPassed,
      upload: uploadBuffer({
        bucketName,
        objectPath: buildRenderArtifactPath({
          jobId: params.jobId,
          imageId: params.imageId,
          attempt: params.attempt,
          fileName: "overlay-debug.png",
        }),
        data: params.overlayDebugPng,
        contentType: "image/png",
        metadata: encodedMetadata,
      }),
    }));
  }

  uploads.push(await uploadAndLogRenderArtifact({
    artifactType: "validator-metrics",
    validationPassed: params.validationPassed,
    upload: uploadJson({
      bucketName,
      objectPath: buildRenderArtifactPath({
        jobId: params.jobId,
        imageId: params.imageId,
        attempt: params.attempt,
        fileName: "validator-metrics.json",
      }),
      json: {
        metadata,
        validatorMetrics: params.validatorMetrics || null,
      },
      metadata: encodedMetadata,
    }),
  }));

  const rootGcsUriWithPrefix = [
    `gs://${bucketName}`,
    basePrefix,
    DEBUG_RENDER_ROOT,
    sanitizeSegment(params.jobId, "unknown-job"),
    sanitizeSegment(params.imageId, "unknown-image"),
    `attempt-${Math.max(1, params.attempt)}`,
  ].filter(Boolean).join("/");

  if (!params.validationPassed) {
    nLog("[VERTEX_RENDER_VALIDATION_FAILURE_ARTIFACTS]", {
      gcsUri: rootGcsUriWithPrefix,
      signedUrl: uploads.find((entry) => entry.artifactType === "raw-render")?.signedUrl || null,
      validationPassed: false,
      artifactType: "attempt-root",
      failureReason: params.failureReason,
      mae: params.mae,
      ratio: params.ratio,
    });
  }

  nLog("[FORENSIC_RENDER_UPLOAD_COMPLETE]", {
    jobId: params.jobId,
    imageId: params.imageId,
    artifactCount: uploads.length,
    targetGcsPath: rootGcsUriWithPrefix,
    validationPassed: params.validationPassed,
  });

  return {
    rootGcsUri: rootGcsUriWithPrefix,
    artifacts: uploads,
  };
  } catch (error: any) {
    nLog("[FORENSIC_UPLOAD_ERROR]", {
      pipeline: "render-artifacts",
      jobId: params.jobId,
      imageId: params.imageId,
      targetGcsPath: targetRootGcsPath,
      error: error?.message || String(error),
      stack: error instanceof Error ? error.stack || null : null,
    });
    throw error;
  }
}

async function uploadMaskEvolutionArtifact(params: {
  bucketName: string;
  jobId: string;
  imageId: string;
  fileName: string;
  sourcePath: string;
}): Promise<UploadedArtifact> {
  const uploaded = await uploadLocalImageAsPng({
    bucketName: params.bucketName,
    objectPath: buildMaskEvolutionArtifactPath({
      jobId: params.jobId,
      imageId: params.imageId,
      fileName: params.fileName,
    }),
    localPath: params.sourcePath,
  });
  nLog("[VERTEX_RENDER_ARTIFACT_PERSISTED]", {
    artifactType: `mask-evolution:${params.fileName}`,
    gcsUri: uploaded.gcsUri,
    signedUrl: uploaded.signedUrl,
    validationPassed: true,
  });
  return {
    artifactType: params.fileName,
    gcsUri: uploaded.gcsUri,
    signedUrl: uploaded.signedUrl,
  };
}

async function normalizeMaskStageAsPng(params: {
  stagePath: string;
  outputPath: string;
  width: number;
  height: number;
}): Promise<void> {
  await sharp(params.stagePath)
    .removeAlpha()
    .grayscale()
    .resize(params.width, params.height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(1, { grayscale: true })
    .png()
    .toFile(params.outputPath);
}

async function buildMaskEvolutionStrip(params: {
  timelinePaths: string[];
  outputPath: string;
  width: number;
  height: number;
}): Promise<void> {
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let index = 0; index < params.timelinePaths.length; index += 1) {
    const resized = await sharp(params.timelinePaths[index])
      .removeAlpha()
      .grayscale()
      .resize(params.width, params.height, { fit: "fill", kernel: sharp.kernel.nearest })
      .png()
      .toBuffer();
    composites.push({
      input: resized,
      left: index * params.width,
      top: 0,
    });
  }

  await sharp({
    create: {
      width: Math.max(1, params.width * Math.max(1, params.timelinePaths.length)),
      height: params.height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(composites)
    .png()
    .toFile(params.outputPath);
}

async function firstExistingPath(candidates: Array<string | null | undefined>): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function persistMaskEvolutionArtifacts(params: {
  jobId: string;
  imageId: string;
  continuityGroupId?: string | null;
  attempt: number;
  width: number;
  height: number;
  rawGeminiMaskPath?: string | null;
  alphaNormalizedMaskPath?: string | null;
  morphologyCleanedMaskPath?: string | null;
  componentFilteredMaskPath?: string | null;
  floorContactVisualizationPath?: string | null;
  acceptedClusterMaskPath?: string | null;
  occupancyConstraintMaskPath?: string | null;
  occupancyMaskPath: string;
  finalMaskPath: string;
}): Promise<{ rootGcsUri: string; artifacts: UploadedArtifact[]; maskEvolutionStripPath: string | null }> {
  const bucketName = getDebugBucketName();
  const basePrefix = getDebugBasePrefix();
  const targetRootGcsPath = [
    `gs://${bucketName}`,
    basePrefix,
    DEBUG_MASK_EVOLUTION_ROOT,
    sanitizeSegment(params.jobId, "unknown-job"),
    sanitizeSegment(params.imageId, "unknown-image"),
  ].filter(Boolean).join("/");
  nLog("[FORENSIC_ARTIFACT_PIPELINE_ACTIVE]", {
    pipeline: "mask-evolution",
    sourceFile: "worker/src/continuity/debug/gcsDebugArtifacts.ts",
    jobId: params.jobId,
    imageId: params.imageId,
    targetGcsPath: targetRootGcsPath,
  });
  nLog("[FORENSIC_MASK_EVOLUTION_UPLOAD_BEGIN]", {
    jobId: params.jobId,
    imageId: params.imageId,
    targetGcsPath: targetRootGcsPath,
  });

  try {
  const tmpDir = path.join(
    "/tmp",
    "vertex-mask-evolution",
    sanitizeSegment(params.jobId, "unknown-job"),
    sanitizeSegment(params.imageId, "unknown-image"),
    `attempt-${Math.max(1, params.attempt)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });

  const stageMap: Array<{ fileName: string; sourcePath: string | null }> = [
    {
      fileName: "raw-gemini-mask.png",
      sourcePath: await firstExistingPath([params.rawGeminiMaskPath, params.occupancyMaskPath]),
    },
    {
      fileName: "resized-source-mask.png",
      sourcePath: await firstExistingPath([params.alphaNormalizedMaskPath, params.rawGeminiMaskPath, params.occupancyMaskPath]),
    },
    {
      fileName: "topology-cleanup-mask.png",
      sourcePath: await firstExistingPath([params.morphologyCleanedMaskPath, params.occupancyMaskPath]),
    },
    {
      fileName: "morphology-close-mask.png",
      sourcePath: await firstExistingPath([params.morphologyCleanedMaskPath, params.occupancyMaskPath]),
    },
    {
      fileName: "morphology-open-mask.png",
      sourcePath: await firstExistingPath([params.componentFilteredMaskPath, params.occupancyMaskPath]),
    },
    {
      fileName: "floor-contact-projected-mask.png",
      sourcePath: await firstExistingPath([params.floorContactVisualizationPath, params.componentFilteredMaskPath, params.occupancyMaskPath]),
    },
    {
      fileName: "support-surface-mask.png",
      sourcePath: await firstExistingPath([params.acceptedClusterMaskPath, params.componentFilteredMaskPath, params.occupancyMaskPath]),
    },
    {
      fileName: "component-filtered-mask.png",
      sourcePath: await firstExistingPath([params.componentFilteredMaskPath, params.occupancyMaskPath]),
    },
    {
      fileName: "constraint-mask.png",
      sourcePath: await firstExistingPath([params.occupancyConstraintMaskPath, params.occupancyMaskPath]),
    },
    {
      fileName: "constraint-intersection-mask.png",
      sourcePath: await firstExistingPath([params.occupancyMaskPath]),
    },
    {
      fileName: "final-occupancy-mask.png",
      sourcePath: await firstExistingPath([params.occupancyMaskPath]),
    },
    {
      fileName: "final-render-mask.png",
      sourcePath: await firstExistingPath([params.finalMaskPath]),
    },
  ];

  const normalizedStagePaths: Array<{ fileName: string; normalizedPath: string }> = [];
  for (const stage of stageMap) {
    if (!stage.sourcePath) {
      continue;
    }
    const normalizedPath = path.join(tmpDir, stage.fileName);
    await normalizeMaskStageAsPng({
      stagePath: stage.sourcePath,
      outputPath: normalizedPath,
      width: params.width,
      height: params.height,
    });
    normalizedStagePaths.push({ fileName: stage.fileName, normalizedPath });
  }

  const stripTimelineCandidates = [
    "raw-gemini-mask.png",
    "topology-cleanup-mask.png",
    "component-filtered-mask.png",
    "support-surface-mask.png",
    "constraint-intersection-mask.png",
    "final-render-mask.png",
  ];
  const stripTimelinePaths = stripTimelineCandidates
    .map((fileName) => normalizedStagePaths.find((stage) => stage.fileName === fileName)?.normalizedPath)
    .filter((value): value is string => Boolean(value));

  let stripPath: string | null = null;
  if (stripTimelinePaths.length > 0) {
    stripPath = path.join(tmpDir, "mask-evolution-strip.png");
    await buildMaskEvolutionStrip({
      timelinePaths: stripTimelinePaths,
      outputPath: stripPath,
      width: params.width,
      height: params.height,
    });
    normalizedStagePaths.push({ fileName: "mask-evolution-strip.png", normalizedPath: stripPath });
  }

  const uploads: UploadedArtifact[] = [];
  for (const stage of normalizedStagePaths) {
    uploads.push(await uploadMaskEvolutionArtifact({
      bucketName,
      jobId: params.jobId,
      imageId: params.imageId,
      fileName: stage.fileName,
      sourcePath: stage.normalizedPath,
    }));
  }

  const manifestUpload = await uploadJson({
    bucketName,
    objectPath: buildMaskEvolutionArtifactPath({
      jobId: params.jobId,
      imageId: params.imageId,
      fileName: "mask-evolution-metadata.json",
    }),
    json: {
      continuityGroupId: params.continuityGroupId || null,
      attempt: params.attempt,
      width: params.width,
      height: params.height,
      stages: normalizedStagePaths.map((stage) => stage.fileName),
    },
  });
  uploads.push({
    artifactType: "mask-evolution-metadata.json",
    gcsUri: manifestUpload.gcsUri,
    signedUrl: manifestUpload.signedUrl,
  });

  const rootGcsUri = [
    `gs://${bucketName}`,
    basePrefix,
    DEBUG_MASK_EVOLUTION_ROOT,
    sanitizeSegment(params.jobId, "unknown-job"),
    sanitizeSegment(params.imageId, "unknown-image"),
  ].filter(Boolean).join("/");
  nLog("[FORENSIC_MASK_EVOLUTION_UPLOAD_COMPLETE]", {
    jobId: params.jobId,
    imageId: params.imageId,
    artifactCount: uploads.length,
    targetGcsPath: rootGcsUri,
  });
  return {
    rootGcsUri,
    artifacts: uploads,
    maskEvolutionStripPath: stripPath,
  };
  } catch (error: any) {
    nLog("[FORENSIC_UPLOAD_ERROR]", {
      pipeline: "mask-evolution",
      jobId: params.jobId,
      imageId: params.imageId,
      targetGcsPath: targetRootGcsPath,
      error: error?.message || String(error),
      stack: error instanceof Error ? error.stack || null : null,
    });
    throw error;
  }
}
