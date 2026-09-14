import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import sharp from "sharp";

// Diagnostic instrumentation added while investigating a real production
// incident (2026-08-24 batch): 3 of 6 concurrent jobs each received a
// DIFFERENT job's actual generated image at delivery, while every other
// piece of job context (jobId, room type, prompt) stayed correctly
// attached throughout. Logs a content hash of the actual file on disk at a
// named pipeline checkpoint, so a real production run can be grepped
// afterward to find exactly which checkpoint a job's own image lineage
// stops matching itself. Deliberately a single-line JSON console.log (not
// the nLog("[TAG]", {...}) pretty-printed-object pattern used elsewhere in
// this codebase) — that pattern produces multi-line output that reliably
// interleaves with concurrent jobs' own log lines under real concurrency,
// which made an unrelated log-analysis task materially harder tonight.
// This needs to stay atomic and single-line to actually be usable.
export function logImageContentHash(params: {
  point: string;
  filePath: string;
  ctx: { jobId: string; imageId?: string; stage?: string; attempt?: number };
}): void {
  try {
    const buf = fs.readFileSync(params.filePath);
    const sha1 = createHash("sha1").update(buf).digest("hex");
    console.log(
      JSON.stringify({
        event: "IMAGE_CONTENT_HASH",
        jobId: params.ctx.jobId,
        imageId: params.ctx.imageId,
        stage: params.ctx.stage,
        attempt: params.ctx.attempt,
        point: params.point,
        sha1,
        sizeBytes: buf.length,
        file: path.basename(params.filePath),
      })
    );
  } catch (err: any) {
    console.log(
      JSON.stringify({
        event: "IMAGE_CONTENT_HASH_ERROR",
        jobId: params.ctx.jobId,
        point: params.point,
        filePath: params.filePath,
        error: err?.message || String(err),
      })
    );
  }
}

export function toBase64(filePath: string): { data: string; mime: string } {
  const buf = fs.readFileSync(filePath);
  // crude mime guess by extension
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { data: buf.toString("base64"), mime };
}

export function writeImageDataUrl(outPath: string, dataUrl: string) {
  const m = dataUrl.match(/^data:(.+);base64,(.*)$/);
  if (!m) throw new Error("invalid data URL from model");
  const b64 = m[2];
  const buf = Buffer.from(b64, "base64");
  fs.writeFileSync(outPath, buf);
}

export function siblingOutPath(srcPath: string, suffix: string, ext: string = ".webp"): string {
  const dir = path.dirname(srcPath);
  const base = path.basename(srcPath, path.extname(srcPath));
  return path.join(dir, `${base}${suffix}${ext}`);
}

// Reinstated from commit 0245366b ("Portrait Image Tiling Fix 1", July 10
// — never merged into main or this branch, confirmed via
// `git merge-base --is-ancestor 0245366b HEAD` returning false), and
// generalized to cover every whole-image Gemini call site (Stage 1A and
// 1B via enhanceWithGemini, and Stage 2's own separate call path), not
// just Stage 1A as originally written. Understood cause: sending an
// oversized/tall portrait image directly to Gemini's image-generation API
// can cause Gemini's own internal processing to misbehave. This is a
// distinct, independent mechanism from the client-side pica/ImageBitmap
// tiling bug (client/src/utils/processImage.ts) — both are worth guarding
// against; this one doesn't overlap with or supersede that one.
const GEMINI_MAX_PORTRAIT_HEIGHT = Math.max(1024, Number(process.env.GEMINI_MAX_PORTRAIT_HEIGHT || 2048));

export async function normalizePortraitImageForGemini(
  inputPath: string,
  ctx: { jobId: string; imageId?: string; stage: "1A" | "1B" | "2"; roomType?: string }
): Promise<string> {
  const meta = await sharp(inputPath).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) {
    return inputPath;
  }

  const isPortrait = height > width;
  if (!isPortrait || height <= GEMINI_MAX_PORTRAIT_HEIGHT) {
    console.warn(
      JSON.stringify({
        event: "GEMINI_PORTRAIT_GUARD",
        jobId: ctx.jobId,
        imageId: ctx.imageId,
        stage: ctx.stage,
        roomType: ctx.roomType || null,
        inputWidth: width,
        inputHeight: height,
        applied: false,
        reason: !isPortrait ? "not_portrait" : "within_height_limit",
        threshold: GEMINI_MAX_PORTRAIT_HEIGHT,
      })
    );
    return inputPath;
  }

  let targetHeight = GEMINI_MAX_PORTRAIT_HEIGHT;
  let targetWidth = Math.max(1, Math.round((width * targetHeight) / height));
  // Keep dimensions even — some encoders/codecs misbehave on odd dimensions.
  if (targetWidth % 2 !== 0) targetWidth -= 1;
  if (targetHeight % 2 !== 0) targetHeight -= 1;

  const normalizedPath = siblingOutPath(inputPath, "-portrait-normalized", ".webp");
  await sharp(inputPath)
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: "inside",
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: true,
    })
    .webp({ quality: 97, effort: 6, smartSubsample: true, nearLossless: false })
    .toFile(normalizedPath);

  console.warn(
    JSON.stringify({
      event: "GEMINI_PORTRAIT_GUARD",
      jobId: ctx.jobId,
      imageId: ctx.imageId,
      stage: ctx.stage,
      roomType: ctx.roomType || null,
      inputWidth: width,
      inputHeight: height,
      outputWidth: targetWidth,
      outputHeight: targetHeight,
      applied: true,
      reason: "portrait_exceeds_max_height",
      threshold: GEMINI_MAX_PORTRAIT_HEIGHT,
    })
  );

  return normalizedPath;
}
