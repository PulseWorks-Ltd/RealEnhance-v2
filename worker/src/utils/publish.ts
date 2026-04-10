import fs from "fs";
import path from "path";
import { logIfNotFocusMode } from "../logger";

type EdgeTrim = { top: number; right: number; bottom: number; left: number };

function parseEnvInt(raw: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.max(min, Math.min(max, rounded));
}

function parseEnvFloat(raw: string | undefined, fallback: number, min = 0, max = 1): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function loadImageWithFinalBorderGuard(
  filePath: string
): Promise<{ body: Buffer; didTrim: boolean; trim?: EdgeTrim }> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".jpg" && ext !== ".jpeg" && ext !== ".png" && ext !== ".webp") {
    return { body: fs.readFileSync(filePath), didTrim: false };
  }

  const enabled = process.env.PUBLISH_ANTI_BORDER_TRIM !== "0";
  if (!enabled) {
    return { body: fs.readFileSync(filePath), didTrim: false };
  }

  const importer: any = new Function("p", "return import(p)");
  const sharpMod: any = await importer("sharp");
  const sharp = sharpMod?.default ?? sharpMod;

  const base = sharp(filePath);
  const meta = await base.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) {
    return { body: fs.readFileSync(filePath), didTrim: false };
  }

  const threshold = parseEnvInt(process.env.PUBLISH_ANTI_BORDER_THRESHOLD, 10, 0, 255);
  const minBlackFrac = parseEnvFloat(process.env.PUBLISH_ANTI_BORDER_MIN_BLACK_FRAC, 0.85, 0.5, 1);
  const maxScan = parseEnvInt(process.env.PUBLISH_ANTI_BORDER_MAX_SCAN, 20, 1, 200);
  const maxTrim = parseEnvInt(process.env.PUBLISH_ANTI_BORDER_MAX_TRIM_PX, 12, 1, 80);
  const minResultW = parseEnvInt(process.env.PUBLISH_ANTI_BORDER_MIN_RESULT_W, 320, 64, 10000);
  const minResultH = parseEnvInt(process.env.PUBLISH_ANTI_BORDER_MIN_RESULT_H, 240, 64, 10000);

  const rawObj = await base
    .clone()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = rawObj.info.channels || 3;
  const data = rawObj.data;
  const w = rawObj.info.width || width;
  const h = rawObj.info.height || height;
  if (!w || !h || channels < 3) {
    return { body: fs.readFileSync(filePath), didTrim: false };
  }

  const isDarkAt = (offset: number): boolean => {
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    return r <= threshold && g <= threshold && b <= threshold;
  };

  const scanRow = (y: number): number => {
    let dark = 0;
    for (let x = 0; x < w; x++) {
      const offset = (y * w + x) * channels;
      if (isDarkAt(offset)) dark++;
    }
    return dark / w;
  };

  const scanCol = (x: number): number => {
    let dark = 0;
    for (let y = 0; y < h; y++) {
      const offset = (y * w + x) * channels;
      if (isDarkAt(offset)) dark++;
    }
    return dark / h;
  };

  const topLimit = Math.min(maxScan, h);
  const bottomLimit = Math.min(maxScan, h);
  const leftLimit = Math.min(maxScan, w);
  const rightLimit = Math.min(maxScan, w);

  let top = 0;
  for (let i = 0; i < topLimit; i++) {
    if (scanRow(i) >= minBlackFrac) top++;
    else break;
  }

  let bottom = 0;
  for (let i = 0; i < bottomLimit; i++) {
    if (scanRow(h - 1 - i) >= minBlackFrac) bottom++;
    else break;
  }

  let left = 0;
  for (let i = 0; i < leftLimit; i++) {
    if (scanCol(i) >= minBlackFrac) left++;
    else break;
  }

  let right = 0;
  for (let i = 0; i < rightLimit; i++) {
    if (scanCol(w - 1 - i) >= minBlackFrac) right++;
    else break;
  }

  const trim: EdgeTrim = {
    top: Math.min(top, maxTrim),
    right: Math.min(right, maxTrim),
    bottom: Math.min(bottom, maxTrim),
    left: Math.min(left, maxTrim),
  };

  const anyTrim = trim.top > 0 || trim.right > 0 || trim.bottom > 0 || trim.left > 0;
  if (!anyTrim) {
    return { body: fs.readFileSync(filePath), didTrim: false };
  }

  const outW = w - trim.left - trim.right;
  const outH = h - trim.top - trim.bottom;
  if (outW < minResultW || outH < minResultH) {
    logIfNotFocusMode(`[PUBLISH] Anti-border trim skipped (result too small): ${outW}x${outH}`);
    return { body: fs.readFileSync(filePath), didTrim: false };
  }

  const extracted = await sharp(filePath)
    .extract({ left: trim.left, top: trim.top, width: outW, height: outH });

  let body: Buffer;
  if (ext === ".png") {
    body = await extracted.png().toBuffer();
  } else if (ext === ".jpg" || ext === ".jpeg") {
    body = await extracted.jpeg({ quality: 92 }).toBuffer();
  } else {
    body = await extracted.webp({ quality: 90 }).toBuffer();
  }

  return { body, didTrim: true, trim };
}

function mimeFromExt(p: string) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
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

export type PublishResult = {
  url: string;
  kind: "s3" | "data-url";
  key?: string;
  /** true when S3 was configured but upload failed — fell back to data URL */
  degraded?: boolean;
  /** The S3 error message when degraded */
  s3Error?: string;
};

/**
 * Publish an image so the client can access it across services.
 * - If S3_BUCKET is set, uploads to S3 (optionally via S3_PUBLIC_BASEURL/CDN).
 * - Otherwise, returns a data URL (good for demo/smaller files).
 */
export async function publishImage(filePath: string): Promise<PublishResult> {
  const guarded = await loadImageWithFinalBorderGuard(filePath);
  if (guarded.didTrim && guarded.trim) {
    logIfNotFocusMode(`[PUBLISH] Anti-border trim applied top=${guarded.trim.top} right=${guarded.trim.right} bottom=${guarded.trim.bottom} left=${guarded.trim.left}`);
  }

  const bucket = process.env.S3_BUCKET;
  logIfNotFocusMode('\n========================================\n');
  logIfNotFocusMode(`[PUBLISH] File: ${path.basename(filePath)}\n`);
  logIfNotFocusMode(`[PUBLISH] S3_BUCKET: ${bucket || 'NOT SET'}\n`);
  if (bucket) {
    logIfNotFocusMode('[PUBLISH] >>> ATTEMPTING S3 UPLOAD <<<\n');
    logIfNotFocusMode(`[PUBLISH] Bucket: ${bucket}\n`);
    const rawRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    const region = sanitizeRegion(rawRegion);
    logIfNotFocusMode(`[PUBLISH] Region (raw): ${rawRegion}\n`);
    logIfNotFocusMode(`[PUBLISH] Region (sanitized): ${region}\n`);
    try {
      // Avoid TS module resolution by using an indirect dynamic import
      const importer: any = new Function('p', 'return import(p)');
      const mod: any = await importer('@aws-sdk/client-s3');
      const { S3Client, PutObjectCommand } = mod;
      const prefix = (process.env.S3_PREFIX || 'realenhance/outputs').replace(/\/+$/, '');
      const key = `${prefix}/${Date.now()}-${path.basename(filePath)}`.replace(/^\//, '');
      const Body = guarded.body;
      const ContentType = mimeFromExt(filePath);

      // Explicitly configure credentials if provided (Railway may not auto-detect)
      const clientConfig: any = { region };
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        clientConfig.credentials = {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        };
        logIfNotFocusMode(`[PUBLISH] Using explicit AWS credentials (key: ${process.env.AWS_ACCESS_KEY_ID?.substring(0, 8)}...)\n`);
      }

      const s3 = new S3Client(clientConfig);
      logIfNotFocusMode('[PUBLISH] >>> UPLOADING NOW <<<\n');
      logIfNotFocusMode(`[PUBLISH] Destination: s3://${bucket}/${key}\n`);
      logIfNotFocusMode(`[PUBLISH] Size: ${Body.length} bytes\n`);
      
      const envNoAcl = process.env.S3_NO_ACL === '1' || process.env.S3_NO_ACL === 'true';
      const wantAcl = !!process.env.S3_ACL && !envNoAcl;
      
      // Default to public-read if no ACL env is set and not explicitly disabled
      const shouldUseAcl = wantAcl || (!envNoAcl && !process.env.S3_ACL);
      const aclValue = process.env.S3_ACL || 'public-read';
      
      const baseParams: any = { Bucket: bucket, Key: key, Body, ContentType };
      let uploaded = false;
      
      if (shouldUseAcl) {
        logIfNotFocusMode(`[PUBLISH] Attempting upload with ACL: ${aclValue}\n`);
        try {
          await s3.send(new PutObjectCommand({ ...baseParams, ACL: aclValue }));
          uploaded = true;
          logIfNotFocusMode(`[PUBLISH] ✅ Upload succeeded with ACL\n`);
        } catch (e: any) {
          const msg = e?.message || String(e);
          const code = e?.Code || e?.code || e?.name;
          const aclNotAllowed = /does not allow ACLs|AccessControlListNotSupported|InvalidRequest/i.test(msg) || /AccessControlListNotSupported|InvalidRequest/i.test(String(code || ''));
          if (aclNotAllowed) {
            logIfNotFocusMode('[PUBLISH] Bucket disallows ACLs; retrying without ACL\n');
          } else {
            throw e;
          }
        }
      } else {
        logIfNotFocusMode(`[PUBLISH] Uploading without ACL (S3_NO_ACL=${process.env.S3_NO_ACL})\n`);
      }
      if (!uploaded) {
        const result = await s3.send(new PutObjectCommand(baseParams));
        logIfNotFocusMode(`[PUBLISH] PutObject response: ETag=${result.ETag || 'none'}, VersionId=${result.VersionId || 'none'}\n`);
      }

      // Verify upload with HeadObject to ensure file actually exists
      try {
        const { HeadObjectCommand } = mod;
        const headResult = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        logIfNotFocusMode(`[PUBLISH] ✅ VERIFIED: Object exists, size=${headResult.ContentLength}, ETag=${headResult.ETag}\n`);
      } catch (verifyErr: any) {
        logIfNotFocusMode(`[PUBLISH] ⚠️ WARNING: Upload reported success but verification failed: ${verifyErr?.message}\n`);
        logIfNotFocusMode(`[PUBLISH] Key: ${key}\n`);
        // Continue anyway - might be eventual consistency
      }

      const base = (process.env.S3_PUBLIC_BASEURL || '').replace(/\/+$/, '');
      const url = base ? `${base}/${key}` : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
      logIfNotFocusMode('[PUBLISH] ✅ SUCCESS!\n');
      logIfNotFocusMode(`[PUBLISH] URL: ${url}\n`);
      logIfNotFocusMode('========================================\n\n');
      return { url, kind: 's3', key };
    } catch (e: any) {
      // S3 was configured but upload failed — return data URL but mark degraded
      const errMsg = e?.message || String(e);
      console.error(`[PUBLISH] S3 UPLOAD FAILED (degraded): ${errMsg}`);
      logIfNotFocusMode('[PUBLISH] ❌ S3 UPLOAD FAILED!\n');
      logIfNotFocusMode(`[PUBLISH] Error: ${errMsg}\n`);
      logIfNotFocusMode(`[PUBLISH] Error code: ${e?.Code || e?.code || 'none'}\n`);
      logIfNotFocusMode(`[PUBLISH] Full error: ${JSON.stringify(e, null, 2)}\n`);
      logIfNotFocusMode('[PUBLISH] >>> Returning data URL with degraded flag <<<\n');
      logIfNotFocusMode('========================================\n\n');

      // Build data URL fallback explicitly so callers still get a usable URL
      const fallbackResult = await buildDataUrl(filePath, guarded.body);
      return { ...fallbackResult, degraded: true, s3Error: errMsg };
    }
  } else {
    logIfNotFocusMode('[PUBLISH] S3_BUCKET not set - using data URL\n');
    logIfNotFocusMode('========================================\n\n');
  }

  return buildDataUrl(filePath, guarded.body);
}

/** Build a data-URL result from a local file (dev/demo fallback). */
async function buildDataUrl(filePath: string, sourceBuffer?: Buffer): Promise<PublishResult> {
  logIfNotFocusMode('[PUBLISH] Generating data URL fallback...\n');
  const buf = sourceBuffer || fs.readFileSync(filePath);
  const mime = mimeFromExt(filePath);
  logIfNotFocusMode(`[PUBLISH] Original size: ${buf.length} bytes\n`);

  logIfNotFocusMode('[PUBLISH] Preserving original dimensions and encoding for fallback download quality\n');

  const b64 = buf.toString("base64");
  const dataUrl = `data:${mime};base64,${b64}`;
  logIfNotFocusMode(`[PUBLISH] Data URL created: ${Math.round(dataUrl.length/1024)}KB\n`);
  logIfNotFocusMode('========================================\n\n');
  return { url: dataUrl, kind: "data-url" };
}
