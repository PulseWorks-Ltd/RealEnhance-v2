import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

export async function ensureS3Ready(): Promise<boolean> {
  try {
    if (!process.env.S3_BUCKET) return false;
    // simple no-op client creation sanity
    getClient();
    return true;
  } catch {
    return false;
  }
}
