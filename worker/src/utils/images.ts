import fs from "fs";
import path from "path";
import { createHash } from "crypto";

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
