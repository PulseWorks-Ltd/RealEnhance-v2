import fs from "fs";
import path from "path";

function mimeFromExt(p: string) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

/**
 * Publish an image so the client can access it across services.
 * - If S3_BUCKET is set, uploads to S3 (optionally via S3_PUBLIC_BASEURL/CDN).
 * - Otherwise, returns a data URL (good for demo/smaller files).
 */
export async function publishImage(filePath: string): Promise<{ url: string; kind: "s3" | "data-url"; key?: string }>{
  const bucket = process.env.S3_BUCKET;
  if (bucket) {
    try {
      // Avoid TS module resolution by using an indirect dynamic import
      const importer: any = new Function('p', 'return import(p)');
      const mod: any = await importer('@aws-sdk/client-s3');
      const { S3Client, PutObjectCommand } = mod;
      const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
      const prefix = (process.env.S3_PREFIX || 'realenhance/outputs').replace(/\/+$/, '');
      const key = `${prefix}/${Date.now()}-${path.basename(filePath)}`.replace(/^\//, '');
      const Body = fs.readFileSync(filePath);
      const ContentType = mimeFromExt(filePath);

      const s3 = new S3Client({ region });
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body,
        ContentType,
        ACL: process.env.S3_ACL || 'public-read',
      }));

      const base = (process.env.S3_PUBLIC_BASEURL || '').replace(/\/+$/, '');
      const url = base ? `${base}/${key}` : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
      return { url, kind: 's3', key };
    } catch (e) {
      // Module not installed or runtime import failed; fall back to data URL
      console.warn('[publish] S3 upload skipped (missing @aws-sdk/client-s3 or other error). Falling back to data URL.');
    }
  }

  // Fallback for dev/demo: inline data URL
  // IMPORTANT: For production, configure S3_BUCKET to avoid huge data URLs
  // Resize to max 800px to keep data URL reasonable (<500KB typically)
  const buf = fs.readFileSync(filePath);
  const mime = mimeFromExt(filePath);
  
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
      console.warn(`[publish] No S3 configured - using resized data URL (${finalBuf.length} bytes). Configure S3_BUCKET for production.`);
    } catch (e) {
      console.warn('[publish] Could not resize for data URL fallback:', e);
    }
  }
  
  const b64 = finalBuf.toString("base64");
  return { url: `data:${mime};base64,${b64}`, kind: "data-url" };
}
