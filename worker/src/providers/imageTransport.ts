import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { File, Storage } from "@google-cloud/storage";
import { nLog } from "../logger";
import { toBase64 } from "../utils/images";
import { downloadToTemp } from "../utils/remote";
import type { ImageReference, ResolveImageSourceInput } from "./types";
import { VertexSecondaryContinuityError } from "../continuity/types";

let storageClient: Storage | null = null;

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function normalizeMimeType(mimeType?: string | null): string {
  const value = String(mimeType || "").trim().toLowerCase();
  if (value === "image/jpg") {
    return "image/jpeg";
  }
  return value;
}

function assertValidImageMimeType(mimeType: string, sourceLabel: string): string {
  const normalized = normalizeMimeType(mimeType);
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) {
    throw new VertexSecondaryContinuityError(
      `${sourceLabel} resolved to unsupported image mime type: ${mimeType || "missing"}`,
      "image_reference_invalid_mime"
    );
  }
  return normalized;
}

function mimeFromSharpFormat(format?: string): string | null {
  const normalized = String(format || "").trim().toLowerCase();
  if (normalized === "jpeg" || normalized === "jpg") {
    return "image/jpeg";
  }
  if (normalized === "png") {
    return "image/png";
  }
  if (normalized === "webp") {
    return "image/webp";
  }
  return null;
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

function parseGcsUri(uri: string): { bucket: string; objectPath: string } {
  const normalized = resolveGcsUri(uri);
  const match = normalized?.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  if (!match?.[1] || !match?.[2]) {
    throw new VertexSecondaryContinuityError(
      `remote artifact URI is not a valid gs:// location: ${uri}`,
      "image_reference_invalid_gcs_uri"
    );
  }
  return {
    bucket: match[1],
    objectPath: match[2],
  };
}

async function validateLocalImageArtifact(params: {
  filePath: string;
  sourceLabel: string;
  expectedMimeType?: string | null;
}): Promise<{ sizeBytes: number; mimeType: string }> {
  let stats;
  try {
    stats = await fs.stat(params.filePath);
  } catch {
    throw new VertexSecondaryContinuityError(
      `${params.sourceLabel} local artifact does not exist: ${params.filePath}`,
      "image_reference_missing_local_path"
    );
  }

  if (stats.size <= 0) {
    throw new VertexSecondaryContinuityError(
      `${params.sourceLabel} local artifact is empty: ${params.filePath}`,
      "image_reference_empty_local_file"
    );
  }

  const normalizedExpectedMimeType = assertValidImageMimeType(
    params.expectedMimeType || mimeFromPath(params.filePath),
    params.sourceLabel
  );
  const metadata = await sharp(params.filePath).metadata();
  const decodedMimeType = mimeFromSharpFormat(metadata.format);

  if (!decodedMimeType) {
    throw new VertexSecondaryContinuityError(
      `${params.sourceLabel} decoded to unsupported image format: ${metadata.format || "unknown"}`,
      "image_reference_unsupported_format"
    );
  }

  if (decodedMimeType !== normalizedExpectedMimeType) {
    throw new VertexSecondaryContinuityError(
      `${params.sourceLabel} mime mismatch: expected ${normalizedExpectedMimeType} but decoded ${decodedMimeType}`,
      "image_reference_mime_mismatch"
    );
  }

  return {
    sizeBytes: stats.size,
    mimeType: decodedMimeType,
  };
}

async function ensureRemoteObjectReadable(file: File): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const stream = file.createReadStream({ start: 0, end: 0 });
    const finalize = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    stream.once("data", () => finalize());
    stream.once("end", () => finalize());
    stream.once("error", (error) => finalize(error));
  });
}

async function validateRemoteGcsImage(params: {
  uri: string;
  sourceLabel: string;
  expectedSizeBytes?: number | null;
  expectedMimeType?: string | null;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
}): Promise<{ sizeBytes: number; mimeType: string }> {
  const { bucket, objectPath } = parseGcsUri(params.uri);
  const storage = getStorageClient();
  const file = storage.bucket(bucket).file(objectPath);
  const [exists] = await file.exists();

  if (!exists) {
    throw new VertexSecondaryContinuityError(
      `${params.sourceLabel} remote artifact is missing: ${params.uri}`,
      "image_reference_missing_remote_object"
    );
  }

  const [metadata] = await file.getMetadata();
  const sizeBytes = Number(metadata.size || 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new VertexSecondaryContinuityError(
      `${params.sourceLabel} remote artifact is empty: ${params.uri}`,
      "image_reference_empty_remote_object"
    );
  }

  const mimeType = assertValidImageMimeType(metadata.contentType || params.expectedMimeType || "", params.sourceLabel);
  if (params.expectedSizeBytes != null && sizeBytes !== params.expectedSizeBytes) {
    throw new VertexSecondaryContinuityError(
      `${params.sourceLabel} remote artifact size mismatch: expected ${params.expectedSizeBytes} got ${sizeBytes}`,
      "image_reference_remote_size_mismatch"
    );
  }

  if (params.expectedMimeType && mimeType !== normalizeMimeType(params.expectedMimeType)) {
    throw new VertexSecondaryContinuityError(
      `${params.sourceLabel} remote artifact mime mismatch: expected ${normalizeMimeType(params.expectedMimeType)} got ${mimeType}`,
      "image_reference_remote_mime_mismatch"
    );
  }

  await ensureRemoteObjectReadable(file);

  nLog("[CONTINUITY_REMOTE_REFERENCE_VALIDATION]", {
    sourceLabel: params.sourceLabel,
    continuityGroupId: params.continuityGroupId || null,
    jobId: params.jobId,
    imageId: params.imageId,
    uri: params.uri,
    sizeBytes,
    mimeType,
    reachable: true,
  });

  return {
    sizeBytes,
    mimeType,
  };
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
  const localValidation = await validateLocalImageArtifact({
    filePath: params.localPath,
    sourceLabel: params.sourceLabel,
    expectedMimeType: params.mimeType,
  });
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
      mimeType: localValidation.mimeType,
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
  const artifactSizeBytes = localValidation.sizeBytes;

  await storage.bucket(bucketName).upload(params.localPath, {
    destination: key,
    contentType: localValidation.mimeType,
    resumable: false,
    metadata: {
      cacheControl: "private, max-age=86400",
    },
  });

  const uri = `gs://${bucketName}/${key}`;
  const remoteValidation = await validateRemoteGcsImage({
    uri,
    sourceLabel: params.sourceLabel,
    expectedSizeBytes: localValidation.sizeBytes,
    expectedMimeType: localValidation.mimeType,
    continuityGroupId: params.continuityGroupId,
    jobId: params.jobId,
    imageId: params.imageId,
  });
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
    mimeType: remoteValidation.mimeType,
    sourceLabel: params.sourceLabel,
    artifactName: baseName,
  };
}

async function validateHydratedImage(filePath: string, sourceLabel: string): Promise<void> {
  await validateLocalImageArtifact({
    filePath,
    sourceLabel,
  });
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
      artifactName: input.artifactName,
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
    artifactName: input.artifactName,
  };
}

export async function persistRemoteImage(params: {
  sourceLabel: string;
  localPath?: string;
  uri?: string | null;
  artifactName: string;
  jobId: string;
  imageId: string;
  continuityGroupId?: string | null;
}): Promise<ImageReference> {
  const resolved = await resolveImageSource({
    sourceLabel: params.sourceLabel,
    localPath: params.localPath,
    uri: params.uri,
    preferGcs: true,
    artifactName: params.artifactName,
    jobId: params.jobId,
    imageId: params.imageId,
    continuityGroupId: params.continuityGroupId,
  });

  if (resolved.kind !== "gcs" || !resolved.uri) {
    throw new VertexSecondaryContinuityError(
      `${params.sourceLabel} must resolve to a persisted gs:// URI`,
      "continuity_remote_uri_required"
    );
  }

  const localSizeBytes = resolved.localPath ? await getArtifactSizeBytes(resolved.localPath) : null;
  const remoteValidation = await validateRemoteGcsImage({
    uri: resolved.uri,
    sourceLabel: params.sourceLabel,
    expectedSizeBytes: localSizeBytes,
    expectedMimeType: resolved.mimeType,
    continuityGroupId: params.continuityGroupId,
    jobId: params.jobId,
    imageId: params.imageId,
  });

  return {
    ...resolved,
    mimeType: remoteValidation.mimeType,
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
      await validateLocalImageArtifact({
        filePath: params.reference.localPath,
        sourceLabel: params.sourceLabel,
        expectedMimeType: params.reference.mimeType,
      });
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
    await validateHydratedImage(hydratedPath, params.sourceLabel);
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