import fs from "fs/promises";
import path from "path";
import { Storage } from "@google-cloud/storage";
import { nLog } from "../logger";
import { toBase64 } from "../utils/images";
import { downloadToTemp } from "../utils/remote";
import type { ImageReference, ResolveImageSourceInput } from "./types";
import { VertexSecondaryContinuityError } from "../continuity/types";

let storageClient: Storage | null = null;

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "artifact";
}

function getGcsBucket(): string {
  return String(process.env.VERTEX_GCS_BUCKET || process.env.VERTEX_CONTINUITY_GCS_BUCKET || "").trim();
}

function getGcsPrefix(): string {
  return String(process.env.VERTEX_CONTINUITY_GCS_PREFIX || "vertex-secondary-continuity").trim().replace(/^\/+|\/+$/g, "");
}

function getStorageClient(): Storage {
  if (storageClient) {
    return storageClient;
  }
  const projectId = String(process.env.GOOGLE_CLOUD_PROJECT || "").trim() || undefined;
  storageClient = new Storage(projectId ? { projectId } : undefined);
  return storageClient;
}

async function getArtifactSizeBytes(filePath: string | undefined): Promise<number | null> {
  if (!filePath) {
    return null;
  }
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return null;
  }
}

export function resolveGcsUri(uri?: string | null): string | undefined {
  const value = String(uri || "").trim();
  if (!value) {
    return undefined;
  }
  if (value.startsWith("gs://")) {
    return value;
  }
  const storageGoogleApis = value.match(/^https:\/\/storage.googleapis.com\/([^/]+)\/(.+)$/i);
  if (storageGoogleApis?.[1] && storageGoogleApis?.[2]) {
    return `gs://${storageGoogleApis[1]}/${storageGoogleApis[2]}`;
  }
  const storageCloudGoogle = value.match(/^https:\/\/storage.cloud.google.com\/([^/]+)\/(.+)$/i);
  if (storageCloudGoogle?.[1] && storageCloudGoogle?.[2]) {
    return `gs://${storageCloudGoogle[1]}/${storageCloudGoogle[2]}`;
  }
  return undefined;
}

async function uploadLocalFileToGcs(params: {
  localPath: string;
  mimeType: string;
  sourceLabel: string;
  artifactName?: string;
  jobId: string;
  imageId: string;
  continuityGroupId?: string | null;
}): Promise<ImageReference> {
  const bucketName = getGcsBucket();
  if (!bucketName) {
    nLog("[CONTINUITY_GCS_UPLOAD]", {
      action: "skip",
      sourceLabel: params.sourceLabel,
      continuityGroupId: params.continuityGroupId || null,
      jobId: params.jobId,
      imageId: params.imageId,
      fallbackTransportUsage: "local",
      reason: "missing_bucket",
    });
    return {
      kind: "local",
      localPath: params.localPath,
      mimeType: params.mimeType,
      sourceLabel: params.sourceLabel,
    };
  }
  const storage = getStorageClient();
  const baseName = sanitizeSegment(params.artifactName || path.basename(params.localPath));
  const continuityGroupId = sanitizeSegment(params.continuityGroupId || "ungrouped");
  const key = [
    getGcsPrefix(),
    sanitizeSegment(params.jobId),
    sanitizeSegment(params.imageId),
    continuityGroupId,
    baseName,
  ].filter(Boolean).join("/");

  const uploadStartedAt = Date.now();
  const artifactSizeBytes = await getArtifactSizeBytes(params.localPath);

  await storage.bucket(bucketName).upload(params.localPath, {
    destination: key,
    contentType: params.mimeType,
    resumable: false,
    metadata: {
      cacheControl: "private, max-age=86400",
    },
  });

  const uri = `gs://${bucketName}/${key}`;
  const uploadLatencyMs = Date.now() - uploadStartedAt;
  nLog("[CONTINUITY_GCS_UPLOAD]", {
    action: "upload",
    sourceLabel: params.sourceLabel,
    continuityGroupId: params.continuityGroupId || null,
    jobId: params.jobId,
    imageId: params.imageId,
    localPath: params.localPath,
    artifactSizeBytes,
    uploadLatencyMs,
    uri,
  });
  nLog("[VERTEX_CONTINUITY_STORAGE]", {
    action: "upload",
    sourceLabel: params.sourceLabel,
    continuityGroupId: params.continuityGroupId || null,
    jobId: params.jobId,
    imageId: params.imageId,
    uri,
  });
  return {
    kind: "gcs",
    localPath: params.localPath,
    uri,
    mimeType: params.mimeType,
    sourceLabel: params.sourceLabel,
  };
}

export async function resolveImageSource(input: ResolveImageSourceInput): Promise<ImageReference> {
  const gcsUri = resolveGcsUri(input.uri);
  const mimeType = input.mimeType || (input.localPath ? mimeFromPath(input.localPath) : "application/octet-stream");
  nLog("[CONTINUITY_URI_REFERENCE]", {
    sourceLabel: input.sourceLabel,
    continuityGroupId: input.continuityGroupId || null,
    jobId: input.jobId,
    imageId: input.imageId,
    inputUri: input.uri || null,
    normalizedUri: gcsUri || null,
    normalizationApplied: Boolean(input.uri && gcsUri && input.uri !== gcsUri),
  });
  if (gcsUri) {
    nLog("[CONTINUITY_TRANSPORT_RESOLUTION]", {
      sourceLabel: input.sourceLabel,
      continuityGroupId: input.continuityGroupId || null,
      jobId: input.jobId,
      imageId: input.imageId,
      resolution: "gcs-uri",
      localPath: input.localPath || null,
      uri: gcsUri,
      preferGcs: Boolean(input.preferGcs),
      fallbackTransportUsage: false,
    });
    return {
      kind: "gcs",
      uri: gcsUri,
      localPath: input.localPath,
      mimeType,
      sourceLabel: input.sourceLabel,
    };
  }
  if (!input.localPath) {
    throw new VertexSecondaryContinuityError(
      `${input.sourceLabel} is missing a resolvable local path or gs:// URI`,
      "image_source_unresolved"
    );
  }
  if (input.preferGcs) {
    const resolved = await uploadLocalFileToGcs({
      localPath: input.localPath,
      mimeType,
      sourceLabel: input.sourceLabel,
      artifactName: input.artifactName,
      jobId: input.jobId,
      imageId: input.imageId,
      continuityGroupId: input.continuityGroupId,
    });
    nLog("[CONTINUITY_TRANSPORT_RESOLUTION]", {
      sourceLabel: input.sourceLabel,
      continuityGroupId: input.continuityGroupId || null,
      jobId: input.jobId,
      imageId: input.imageId,
      resolution: resolved.kind === "gcs" ? "local-upload" : "local-fallback",
      localPath: input.localPath,
      uri: resolved.uri || null,
      preferGcs: true,
      fallbackTransportUsage: resolved.kind !== "gcs",
    });
    return resolved;
  }
  nLog("[CONTINUITY_TRANSPORT_RESOLUTION]", {
    sourceLabel: input.sourceLabel,
    continuityGroupId: input.continuityGroupId || null,
    jobId: input.jobId,
    imageId: input.imageId,
    resolution: "local-only",
    localPath: input.localPath,
    uri: null,
    preferGcs: false,
    fallbackTransportUsage: false,
  });
  return {
    kind: "local",
    localPath: input.localPath,
    mimeType,
    sourceLabel: input.sourceLabel,
  };
}

export async function persistMaskArtifact(params: {
  maskPath: string;
  jobId: string;
  imageId: string;
  continuityGroupId?: string | null;
}): Promise<ImageReference> {
  return resolveImageSource({
    sourceLabel: "continuity-mask",
    localPath: params.maskPath,
    preferGcs: true,
    artifactName: path.basename(params.maskPath),
    jobId: params.jobId,
    imageId: params.imageId,
    continuityGroupId: params.continuityGroupId,
  });
}

export async function loadImageReference(input: ResolveImageSourceInput): Promise<ImageReference> {
  return resolveImageSource(input);
}

export function toGenAiPart(reference: ImageReference): { fileData?: { fileUri: string; mimeType: string }; inlineData?: { mimeType: string; data: string } } {
  if (reference.kind === "gcs" && reference.uri) {
    return {
      fileData: {
        fileUri: reference.uri,
        mimeType: reference.mimeType,
      },
    };
  }
  if (!reference.localPath) {
    throw new VertexSecondaryContinuityError(
      `${reference.sourceLabel} is missing local data for inline transport`,
      "image_reference_missing_local_path"
    );
  }
  const encoded = toBase64(reference.localPath);
  return {
    inlineData: {
      mimeType: encoded.mime,
      data: encoded.data,
    },
  };
}

export function toVertexImagePayload(reference: ImageReference): Record<string, unknown> {
  if (reference.kind === "gcs" && reference.uri) {
    return {
      gcsUri: reference.uri,
      mimeType: reference.mimeType,
    };
  }
  if (!reference.localPath) {
    throw new VertexSecondaryContinuityError(
      `${reference.sourceLabel} is missing local data for Vertex image payload`,
      "image_reference_missing_local_path"
    );
  }
  const encoded = toBase64(reference.localPath);
  return {
    bytesBase64Encoded: encoded.data,
    mimeType: encoded.mime,
  };
}

export async function ensureLocalFileExists(reference: ImageReference): Promise<void> {
  if (!reference.localPath) {
    return;
  }
  await fs.access(reference.localPath);
}

export async function ensureLocalImagePath(params: {
  reference: ImageReference;
  sourceLabel: string;
  jobId: string;
  imageId: string;
  continuityGroupId?: string | null;
}): Promise<string> {
  if (params.reference.localPath) {
    try {
      await fs.access(params.reference.localPath);
      nLog("[CONTINUITY_INPUT_FILE_CHECK]", {
        sourceLabel: params.sourceLabel,
        continuityGroupId: params.continuityGroupId || null,
        jobId: params.jobId,
        imageId: params.imageId,
        stage: "consumer-local-check",
        resolvedInputType: params.reference.kind === "gcs" ? "REMOTE_GCS" : "LOCAL_TMP",
        path: params.reference.localPath,
        exists: true,
        uri: params.reference.uri || null,
      });
      return params.reference.localPath;
    } catch {
      nLog("[CONTINUITY_INPUT_FILE_CHECK]", {
        sourceLabel: params.sourceLabel,
        continuityGroupId: params.continuityGroupId || null,
        jobId: params.jobId,
        imageId: params.imageId,
        stage: "consumer-local-check",
        resolvedInputType: params.reference.kind === "gcs" ? "REMOTE_GCS" : "LOCAL_TMP",
        path: params.reference.localPath,
        exists: false,
        uri: params.reference.uri || null,
      });
    }
  }

  if (params.reference.uri) {
    const hydratedPath = await downloadToTemp(params.reference.uri, `${params.jobId}-${params.sourceLabel}`);
    nLog("[CONTINUITY_INPUT_FILE_CHECK]", {
      sourceLabel: params.sourceLabel,
      continuityGroupId: params.continuityGroupId || null,
      jobId: params.jobId,
      imageId: params.imageId,
      stage: "consumer-hydrate",
      resolvedInputType: params.reference.kind === "gcs" ? "REMOTE_GCS" : "REMOTE_URI",
      path: hydratedPath,
      exists: true,
      uri: params.reference.uri,
    });
    return hydratedPath;
  }

  throw new VertexSecondaryContinuityError(
    `${params.sourceLabel} is missing a consumer-accessible local file and remote URI`,
    "image_reference_missing_local_path"
  );
}