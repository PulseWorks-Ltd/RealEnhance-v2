import {
  PutObjectCommand,
  CopyObjectCommand,
  S3Client,
  HeadBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "fs";
import path from "path";

export interface S3UploadResult {
  key: string;
  url: string;
  bucket: string;
  size: number;
  contentType: string;
}

function sanitizeRegion(input?: string | null): string {
  const raw = (input || "").trim();
  if (!raw) return "us-east-1";
  // Extract codes like ap-southeast-2 from human-readable strings like
  // "Asia Pacific (Sydney) ap-southeast-2"
  const m = raw.match(/([a-z]{2}-[a-z0-9-]+-\d)/i);
  if (m && m[1]) return m[1].toLowerCase();
  return raw.toLowerCase();
}

function getClient() {
  const region = sanitizeRegion(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1");
  const cfg: any = { region };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    cfg.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }
  return new S3Client(cfg);
}

// Exposed for callers that need direct S3 access (e.g., server-side copy for retries)
export function getS3Client(): S3Client {
  return getClient();
}

function guessMime(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

export async function uploadOriginalToS3(localPath: string): Promise<S3UploadResult> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET not configured");

  const prefix = (process.env.S3_PREFIX || "realenhance/originals").replace(/\/+$/, "");
  const key = `${prefix}/${Date.now()}-${path.basename(localPath)}`.replace(/^\//, "");
  const buf = fs.readFileSync(localPath);
  const contentType = guessMime(localPath);
  const size = buf.length;

  const client = getClient();

  // Many modern buckets enforce BucketOwnerEnforced and do not allow ACLs.
  // Default to NO ACL unless explicitly requested and not disabled.
  const envNoAcl = process.env.S3_NO_ACL === '1' || process.env.S3_NO_ACL === 'true';
  const wantAcl = !!process.env.S3_ACL && !envNoAcl;
  const acl = (process.env.S3_ACL as any) || undefined;

  const putParamsBase: any = {
    Bucket: bucket,
    Key: key,
    Body: buf,
    ContentType: contentType,
  };

  let uploaded = false;
  let lastErr: any = null;
  if (wantAcl && acl) {
    try {
      await client.send(new PutObjectCommand({ ...putParamsBase, ACL: acl }));
      uploaded = true;
    } catch (e: any) {
      lastErr = e;
      const msg = e?.message || String(e);
      const code = e?.Code || e?.code || e?.name;
      const aclNotAllowed = /does not allow ACLs|AccessControlListNotSupported|InvalidRequest/i.test(msg) || /AccessControlListNotSupported|InvalidRequest/i.test(String(code || ''));
      if (aclNotAllowed) {
        console.warn(`[S3] Bucket does not allow ACLs; retrying without ACL (code=${code || 'n/a'})`);
      } else {
        // rethrow non-ACL errors
        throw e;
      }
    }
  }
  if (!uploaded) {
    await client.send(new PutObjectCommand(putParamsBase));
  }

  const base = (process.env.S3_PUBLIC_BASEURL || '').replace(/\/+$/, '');
  const region = sanitizeRegion(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1");
  const url = base ? `${base}/${key}` : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  return { key, url, bucket, size, contentType };
}

export interface S3CopyResult {
  key: string;
  url: string;
  bucket: string;
}

export function extractKeyFromS3Url(url: string): string | null {
  if (!url) return null;
  try {
    const bucket = process.env.S3_BUCKET;
    const region = sanitizeRegion(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1");
    const base = (process.env.S3_PUBLIC_BASEURL || "").replace(/\/+$/, "");
    if (base && url.startsWith(base + "/")) {
      return url.slice(base.length + 1).replace(/^\/+/, "");
    }
    const u = new URL(url);
    const host = u.host.toLowerCase();
    if (bucket) {
      const s3HostA = `${bucket}.s3.${region}.amazonaws.com`.toLowerCase();
      const s3HostB = `${bucket}.s3.amazonaws.com`.toLowerCase();
      if (host === s3HostA || host === s3HostB) {
        return u.pathname.replace(/^\/+/, "");
      }
    }
    // Fallback for virtual-host or path-style variants
    if (bucket && host.startsWith(`${bucket}.s3`)) {
      return u.pathname.replace(/^\/+/, "");
    }
  } catch (e) {
    console.warn(`[S3] Failed to parse key from URL: ${e}`);
  }
  return null;
}

export async function copyS3Object(sourceKey: string, targetKey: string): Promise<S3CopyResult> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET not configured");

  const client = getClient();
  await client.send(new CopyObjectCommand({
    Bucket: bucket,
    Key: targetKey,
    CopySource: `${bucket}/${sourceKey}`,
  }));

  const base = (process.env.S3_PUBLIC_BASEURL || '').replace(/\/+$/, '');
  const region = sanitizeRegion(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1");
  const url = base ? `${base}/${targetKey}` : `https://${bucket}.s3.${region}.amazonaws.com/${targetKey}`;
  return { key: targetKey, url, bucket };
}

export interface S3Status {
  ok: boolean;
  bucket?: string;
  region?: string;
  reason?: string;
}

export async function ensureS3Ready(): Promise<S3Status> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return { ok: false, reason: "S3_BUCKET not set" };
  const region = sanitizeRegion(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1");
  try {
    const client = getClient();
    // HeadBucket validates auth + existence
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { ok: true, bucket, region };
  } catch (e: any) {
    return { ok: false, bucket, region, reason: e?.message || String(e) };
  }
}

export async function requireS3OrExit() {
  const strict = process.env.REQUIRE_S3 === '1' || process.env.S3_STRICT === '1' || process.env.NODE_ENV === 'production';
  const status = await ensureS3Ready();
  if (!status.ok) {
    const msg = `[S3] Unavailable${status.bucket ? ` (bucket=${status.bucket})` : ''}: ${status.reason}`;
    if (strict) {
      console.error(msg + " - exiting because strict S3 mode is enabled (production or REQUIRE_S3=1)");
      process.exit(1);
    } else {
      console.warn(msg + " - continuing (strict mode off)");
    }
  } else {
    console.log(`[S3] Ready: bucket=${status.bucket} region=${status.region}`);
  }
  return status;
}

/**
 * Generate a pre-signed URL for S3 object access
 * @param key S3 object key
 * @param expiresIn Expiration time in seconds (default: 3600 = 1 hour)
 * @returns Pre-signed URL
 */
export async function getS3SignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET not configured");
  }

  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  // Type cast to avoid smithy/types version conflicts between dependencies
  return await getSignedUrl(client as any, command as any, { expiresIn });
}

export async function deleteS3Object(key: string): Promise<void> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return;
  const client = getClient();
  const importer: any = new Function('p', 'return import(p)');
  const mod: any = await importer('@aws-sdk/client-s3');
  const { DeleteObjectCommand } = mod;
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    console.warn('[S3] delete failed for key', key, err as any);
  }
}

export async function purgeS3Prefix(prefixInput: string): Promise<{ deleted: number }> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET not configured");

  const raw = (prefixInput || "").trim();
  if (!raw) {
    throw new Error("S3_RESET_PREFIX is required and cannot be empty");
  }

  // Normalize to single trailing slash
  const normalizedPrefix = `${raw.replace(/^\/+/, "").replace(/\/+$/, "")}/`;

  const client = getClient();
  let deleted = 0;
  let continuation: string | undefined;

  do {
    const listResp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: normalizedPrefix,
        ContinuationToken: continuation,
      })
    );

    const objects = listResp.Contents || [];
    if (objects.length > 0) {
      const toDelete = objects
        .map((obj) => obj.Key)
        .filter((key): key is string => !!key && key.startsWith(normalizedPrefix))
        .map((Key) => ({ Key }));

      if (toDelete.length > 0) {
        const delResp = await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: toDelete } })
        );
        deleted += delResp.Deleted?.length || 0;
      }
    }

    continuation = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
  } while (continuation);

  return { deleted };
}
