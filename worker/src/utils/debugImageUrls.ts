import fs from "fs/promises";
import path from "path";
import type { PipelineContext } from "../types/pipelineContext";
import { logEvent } from "../ai/usageTelemetry";

type StageLabel = "1A" | "1B" | "2";

type DebugSignedUrlResult = {
  signedUrl: string | null;
  key: string | null;
};

const DEBUG_SIGNED_URL_TTL_SECONDS = Math.max(
  1,
  Number(process.env.STAGE_OUTPUT_SIGNED_URL_TTL_SECONDS || 86400)
);

function sanitizeRegion(input?: string | null): string {
  const raw = (input || "").trim();
  if (!raw) return "us-east-1";
  const match = raw.match(/([a-z]{2}-[a-z0-9-]+-\d)/i);
  return (match?.[1] || raw).toLowerCase();
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

export function isDebugImageUrlLoggingEnabled(): boolean {
  return process.env.ENABLE_DEBUG_IMAGE_URLS === "1" || process.env.SIGN_ALL_STAGE_OUTPUTS === "1";
}

export async function createDebugSignedUrl(
  localPath: string,
  jobId: string,
  // force: upload even when debug URL logging is off (masked Stage 2's own
  // STAGE2_MASKED_DEBUG_UPLOAD switch). keyName: object name, default the
  // file's basename.
  // sign: false = upload only, no link (the admin review page opens it).
  options?: { force?: boolean; keyName?: string; body?: Buffer; sign?: boolean }
): Promise<DebugSignedUrlResult> {
  if (!options?.force && !isDebugImageUrlLoggingEnabled()) {
    return { signedUrl: null, key: null };
  }

  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    return { signedUrl: null, key: null };
  }

  const region = sanitizeRegion(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1");
  const importer: any = new Function("p", "return import(p)");
  const s3Mod: any = await importer("@aws-sdk/client-s3");
  const presignMod: any = await importer("@aws-sdk/s3-request-presigner");
  const { S3Client, PutObjectCommand, GetObjectCommand } = s3Mod;
  const { getSignedUrl } = presignMod;

  const clientConfig: any = { region };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    clientConfig.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }

  const body = options?.body ?? (await fs.readFile(localPath));
  const fileName = options?.keyName || path.basename(localPath);
  const key = `debug-attempts/${jobId}/${fileName}`;
  const contentType = mimeFromExt(localPath);

  const s3 = new S3Client(clientConfig);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  if (options?.sign === false) return { signedUrl: null, key };
  const signedUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: DEBUG_SIGNED_URL_TTL_SECONDS }
  );

  return { signedUrl, key };
}

/**
 * Masked Stage 2's work images, saved for the admin review page (Nov 2026).
 * Files go to debug-attempts/<job>/masked/attempt<N>/<name>; only their names
 * are kept on the job — no links in the logs. Opened through the admin page,
 * which checks the session and makes a 5-minute link.
 */
export function maskedDebugSaver(jobId: string) {
  const files: Record<string, string[]> = {};
  const prefix = `debug-attempts/${jobId}/masked`;
  const onAttemptFiles = async (attempt: number, dir: string, names: string[]) => {
    const saved: string[] = [];
    await Promise.all(names.map(async (name) => {
      try {
        const res = await createDebugSignedUrl(path.join(dir, name), jobId, { force: true, sign: false, keyName: `masked/attempt${attempt}/${name}` });
        if (res.key) saved.push(name);
      } catch (err: any) {
        console.warn("[STAGE2_MASKED_DEBUG_UPLOAD_FAILED]", { jobId, file: name, error: err?.message || String(err) });
      }
    }));
    const k = `attempt${attempt}`;
    files[k] = [...new Set([...(files[k] || []), ...saved])].sort();
    console.log(`[STAGE2_MASKED_DEBUG_SAVED] job=${jobId} attempt=${attempt} files=${saved.length}/${names.length} (open from Admin > Review)`);
  };
  return { files, prefix, onAttemptFiles };
}

// Debug uploads run in the background: the image is read into memory now (so
// a later temp-file cleanup can't race it), the upload and log line follow
// without holding up the job (production Oct 2026: 5-10 s per job waited on
// these). pendingDebugUploads lets a caller wait for them if it ever needs to.
const pendingDebugUploads = new Set<Promise<unknown>>();
export function flushDebugUploads(): Promise<unknown> {
  return Promise.allSettled([...pendingDebugUploads]);
}
export function trackDebugUpload<T>(p: Promise<T>): Promise<T> {
  pendingDebugUploads.add(p);
  p.finally(() => pendingDebugUploads.delete(p)).catch(() => {});
  return p;
}

async function uploadInBackground(params: { ctx: PipelineContext; localPath: string }, extra: Record<string, unknown>) {
  const fileName = path.basename(params.localPath);
  let body: Buffer;
  try {
    body = await fs.readFile(params.localPath);
  } catch (error: any) {
    logEvent(params.ctx, "IMAGE_OUTPUT", { signedUrl: null, fileName, ...extra, reason: `ERROR:${error?.message || String(error)}` });
    return;
  }
  trackDebugUpload(
    createDebugSignedUrl(params.localPath, params.ctx.jobId, { body })
      .then((signed) => logEvent(params.ctx, "IMAGE_OUTPUT", { signedUrl: signed.signedUrl || null, fileName, ...extra }))
      .catch((error: any) => logEvent(params.ctx, "IMAGE_OUTPUT", { signedUrl: null, fileName, ...extra, reason: `ERROR:${error?.message || String(error)}` }))
  );
}

// Returns at once; the link is logged when the background upload finishes.
export async function logImageAttemptUrl(params: {
  ctx: PipelineContext;
  localPath: string;
}): Promise<DebugSignedUrlResult> {
  if (!isDebugImageUrlLoggingEnabled()) {
    return { signedUrl: null, key: null };
  }
  await uploadInBackground(params, {});
  return { signedUrl: null, key: null };
}

// Returns at once; the link is logged when the background upload finishes.
export async function logBaselineImageUrl(params: {
  ctx: PipelineContext;
  localPath: string;
}): Promise<DebugSignedUrlResult> {
  if (!isDebugImageUrlLoggingEnabled()) {
    return { signedUrl: null, key: null };
  }
  await uploadInBackground(params, { baseline: true });
  return { signedUrl: null, key: null };
}
