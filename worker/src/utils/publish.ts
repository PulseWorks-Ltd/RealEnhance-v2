import fs from "fs";
import path from "path";

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

/**
 * Publish an image so the client can access it across services.
 * - If S3_BUCKET is set, uploads to S3 (optionally via S3_PUBLIC_BASEURL/CDN).
 * - Otherwise, returns a data URL (good for demo/smaller files).
 */
export async function publishImage(filePath: string): Promise<{ url: string; kind: "s3" | "data-url"; key?: string }>{
  const bucket = process.env.S3_BUCKET;
  process.stdout.write('\n========================================\n');
  process.stdout.write(`[PUBLISH] File: ${path.basename(filePath)}\n`);
  process.stdout.write(`[PUBLISH] S3_BUCKET: ${bucket || 'NOT SET'}\n`);
  if (bucket) {
    process.stdout.write('[PUBLISH] >>> ATTEMPTING S3 UPLOAD <<<\n');
    process.stdout.write(`[PUBLISH] Bucket: ${bucket}\n`);
    const rawRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    const region = sanitizeRegion(rawRegion);
    process.stdout.write(`[PUBLISH] Region (raw): ${rawRegion}\n`);
    process.stdout.write(`[PUBLISH] Region (sanitized): ${region}\n`);
    try {
      // Avoid TS module resolution by using an indirect dynamic import
      const importer: any = new Function('p', 'return import(p)');
      const mod: any = await importer('@aws-sdk/client-s3');
      const { S3Client, PutObjectCommand } = mod;
      const prefix = (process.env.S3_PREFIX || 'realenhance/outputs').replace(/\/+$/, '');
      const key = `${prefix}/${Date.now()}-${path.basename(filePath)}`.replace(/^\//, '');
      const Body = fs.readFileSync(filePath);
      const ContentType = mimeFromExt(filePath);

      // Explicitly configure credentials if provided (Railway may not auto-detect)
      const clientConfig: any = { region };
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        clientConfig.credentials = {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        };
        process.stdout.write(`[PUBLISH] Using explicit AWS credentials (key: ${process.env.AWS_ACCESS_KEY_ID?.substring(0, 8)}...)\n`);
      }

      const s3 = new S3Client(clientConfig);
      process.stdout.write('[PUBLISH] >>> UPLOADING NOW <<<\n');
      process.stdout.write(`[PUBLISH] Destination: s3://${bucket}/${key}\n`);
      process.stdout.write(`[PUBLISH] Size: ${Body.length} bytes\n`);
      
      const envNoAcl = process.env.S3_NO_ACL === '1' || process.env.S3_NO_ACL === 'true';
      const wantAcl = !!process.env.S3_ACL && !envNoAcl;
      
      // Default to public-read if no ACL env is set and not explicitly disabled
      const shouldUseAcl = wantAcl || (!envNoAcl && !process.env.S3_ACL);
      const aclValue = process.env.S3_ACL || 'public-read';
      
      const baseParams: any = { Bucket: bucket, Key: key, Body, ContentType };
      let uploaded = false;
      
      if (shouldUseAcl) {
        process.stdout.write(`[PUBLISH] Attempting upload with ACL: ${aclValue}\n`);
        try {
          await s3.send(new PutObjectCommand({ ...baseParams, ACL: aclValue }));
          uploaded = true;
          process.stdout.write(`[PUBLISH] ✅ Upload succeeded with ACL\n`);
        } catch (e: any) {
          const msg = e?.message || String(e);
          const code = e?.Code || e?.code || e?.name;
          const aclNotAllowed = /does not allow ACLs|AccessControlListNotSupported|InvalidRequest/i.test(msg) || /AccessControlListNotSupported|InvalidRequest/i.test(String(code || ''));
          if (aclNotAllowed) {
            process.stderr.write('[PUBLISH] Bucket disallows ACLs; retrying without ACL\n');
          } else {
            throw e;
          }
        }
      } else {
        process.stdout.write(`[PUBLISH] Uploading without ACL (S3_NO_ACL=${process.env.S3_NO_ACL})\n`);
      }
      if (!uploaded) {
        const result = await s3.send(new PutObjectCommand(baseParams));
        process.stdout.write(`[PUBLISH] PutObject response: ETag=${result.ETag || 'none'}, VersionId=${result.VersionId || 'none'}\n`);
      }

      // Verify upload with HeadObject to ensure file actually exists
      try {
        const { HeadObjectCommand } = mod;
        const headResult = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        process.stdout.write(`[PUBLISH] ✅ VERIFIED: Object exists, size=${headResult.ContentLength}, ETag=${headResult.ETag}\n`);
      } catch (verifyErr: any) {
        process.stderr.write(`[PUBLISH] ⚠️ WARNING: Upload reported success but verification failed: ${verifyErr?.message}\n`);
        process.stderr.write(`[PUBLISH] Key: ${key}\n`);
        // Continue anyway - might be eventual consistency
      }

      const base = (process.env.S3_PUBLIC_BASEURL || '').replace(/\/+$/, '');
      const url = base ? `${base}/${key}` : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
      process.stdout.write('[PUBLISH] ✅ SUCCESS!\n');
      process.stdout.write(`[PUBLISH] URL: ${url}\n`);
      process.stdout.write('========================================\n\n');
      return { url, kind: 's3', key };
    } catch (e: any) {
      // Module not installed or runtime import failed; fall back to data URL
      process.stderr.write('[PUBLISH] ❌ FAILED!\n');
      process.stderr.write(`[PUBLISH] Error: ${e?.message || String(e)}\n`);
      process.stderr.write(`[PUBLISH] Error code: ${e?.Code || e?.code || 'none'}\n`);
      process.stderr.write(`[PUBLISH] Full error: ${JSON.stringify(e, null, 2)}\n`);
      process.stderr.write('[PUBLISH] >>> FALLING BACK TO DATA URL <<<\n');
      process.stderr.write('========================================\n\n');
    }
  } else {
    process.stdout.write('[PUBLISH] S3_BUCKET not set - using data URL\n');
    process.stdout.write('========================================\n\n');
  }

  // Fallback for dev/demo: inline data URL
  // IMPORTANT: For production, configure S3_BUCKET to avoid huge data URLs
  // Resize to max 800px to keep data URL reasonable (<500KB typically)
  process.stdout.write('[PUBLISH] Generating data URL fallback...\n');
  const buf = fs.readFileSync(filePath);
  const mime = mimeFromExt(filePath);
  process.stdout.write(`[PUBLISH] Original size: ${buf.length} bytes\n`);
  
  // Only resize if file is large to avoid overhead on small files
  let finalBuf = buf;
  if (buf.length > 100 * 1024) { // > 100KB
    try {
      // Avoid TS module resolution by using dynamic import
      const importer: any = new Function('p', 'return import(p)');
      const sharp = await importer('sharp');
      finalBuf = await sharp.default(buf)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
      process.stdout.write(`[PUBLISH] Resized: ${buf.length} -> ${finalBuf.length} bytes (${Math.round(finalBuf.length/1024)}KB)\n`);
    } catch (e) {
      process.stderr.write(`[PUBLISH] Resize failed: ${e}\n`);
      finalBuf = buf;
    }
  } else {
    process.stdout.write(`[PUBLISH] Small file - no resize needed (${buf.length} bytes)\n`);
  }
  
  const b64 = finalBuf.toString("base64");
  const dataUrl = `data:${mime};base64,${b64}`;
  process.stdout.write(`[PUBLISH] Data URL created: ${Math.round(dataUrl.length/1024)}KB\n`);
  process.stdout.write('========================================\n\n');
  return { url: dataUrl, kind: "data-url" };
}
