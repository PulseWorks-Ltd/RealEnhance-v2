import { PutObjectCommand, S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";

export interface S3UploadResult {
  key: string;
  url: string;
  bucket: string;
  size: number;
  contentType: string;
}

function getClient() {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const cfg: any = { region };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    cfg.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }
  return new S3Client(cfg);
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
  const acl = (process.env.S3_ACL as any) || "public-read"; // cast to satisfy TS enum
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buf,
    ContentType: contentType,
    ACL: acl,
  }));

  const base = (process.env.S3_PUBLIC_BASEURL || '').replace(/\/+$/, '');
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const url = base ? `${base}/${key}` : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  return { key, url, bucket, size, contentType };
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
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
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
