import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { storage } from "../storage";
import { runWithImageModelFallback } from "../ai/runWithImageModelFallback.js";

export interface BatchFile {
  buffer: Buffer;
  mimeType: string;
  originalName: string;
}

export interface BatchResult {
  index: number;
  filename: string;
  ok: boolean;
  image?: string;       // base64 data URL for immediate display
  imageUrl?: string;    // storage path for ZIP creation (now using consistent naming)
  error?: string;
}

export async function processBatch(opts: {
  userId: string;
  files: BatchFile[];
  prompts: string[];
  ai: GoogleGenAI;
  maxParallel?: number;
  onProgress?: (completed: number, total: number) => void;
}): Promise<BatchResult[]> {
  const { userId, files, prompts, ai, maxParallel = 1, onProgress } = opts;
  const results: BatchResult[] = files.map((f, i) => ({
    index: i,
    filename: f.originalName || `image-${i + 1}.png`,
    ok: false,
  }));

  let idx = 0;
  let completed = 0;
  const running: Promise<void>[] = [];

  async function runOne(i: number) {
    const f = files[i];
    try {
      console.log(`[BATCH] Processing image ${i + 1}/${files.length}: ${f.originalName}`);
      
      // compress before sending to Gemini
      const buf = await sharp(f.buffer)
        .rotate()
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();

      const { resp: result } = await runWithImageModelFallback(
        ai,
        {
          contents: [
            { inlineData: { mimeType: "image/webp", data: buf.toString("base64") } },
            { text: prompts[i] }
          ]
        } as any,
        `batchProcessor-${i + 1}`
      );

      const parts = result.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p: any) => p.inlineData);
      
      if (!imagePart) {
        throw new Error("Model returned no image");
      }

      const dataUrl = `data:image/png;base64,${imagePart.inlineData?.data || ""}`;

      // For now, store as base64 in memory for immediate display
      // In production, you'd store in cloud storage and return URL
      results[i] = {
        index: i,
        filename: f.originalName || `image-${i + 1}.png`,
        ok: true,
        image: dataUrl,
        imageUrl: `batch-${Date.now()}-${i + 1}.png` // placeholder storage path
      };

      // deduct credit on success
      const user = await storage.getUser(userId);
      if (user) {
        await storage.updateUserCredits(user.id, user.credits - 1);
      }

      console.log(`[BATCH] Success ${i + 1}/${files.length}`);
    } catch (err: any) {
      console.log(`[BATCH] Failed ${i + 1}/${files.length}: ${err.message}`);
      results[i] = {
        index: i,
        filename: f.originalName || `image-${i + 1}.png`,
        ok: false,
        error: err.message || "Processing failed",
      };
    } finally {
      completed++;
      if (onProgress) {
        onProgress(completed, files.length);
      }
    }
  }

  while (idx < files.length || running.length) {
    while (idx < files.length && running.length < maxParallel) {
      const p = runOne(idx++);
      running.push(p.then(() => {
        const pos = running.indexOf(p as any);
        if (pos >= 0) running.splice(pos, 1);
      }));
    }
    if (running.length) await Promise.race(running);
  }

  return results;
}