/**
 * Memory-safe Sharp utilities
 * Implements streaming, cleanup, and resource management
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { updatePeakMemory } from './memory-monitor';

/**
 * Create unique temp filename with job ID prefix to prevent collisions
 */
export function createTempPath(jobId: string, suffix: string): string {
  return path.join('/tmp', `${jobId}-${suffix}-${Date.now()}.jpg`);
}

/**
 * Clean up temp files for a job
 */
export function cleanupTempFiles(jobId: string): void {
  try {
    const tempDir = '/tmp';
    const files = fs.readdirSync(tempDir);
    // Match files that start with jobId OR contain the jobId (downloadToTemp uses realenhance-{jobId}-... pattern)
    const jobFiles = files.filter(f => f.startsWith(jobId) || (f.startsWith('realenhance-') && f.includes(jobId)));
    
    const MIN_AGE_MS = 10_000; // Only delete files idle for 10+ seconds
    const now = Date.now();
    let cleaned = 0;
    let skippedRecent = 0;
    for (const file of jobFiles) {
      try {
        const filePath = path.join(tempDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs < MIN_AGE_MS) {
          skippedRecent++;
          continue; // Skip recently modified files to avoid race with concurrent jobs
        }
        fs.unlinkSync(filePath);
        cleaned++;
      } catch (err) {
        console.warn(`[Cleanup] Failed to delete ${file}:`, err);
      }
    }
    
    if (cleaned > 0 || skippedRecent > 0) {
      console.log(`[Cleanup] Deleted ${cleaned} temp files for job ${jobId}${skippedRecent > 0 ? ` (${skippedRecent} skipped: recent)` : ''}`);
    }
  } catch (err) {
    console.error(`[Cleanup] Error cleaning temp files for ${jobId}:`, err);
  }
}

/**
 * Resize image before processing to reduce memory footprint
 * Max dimensions: 4096x4096 (maintains aspect ratio)
 */
export async function resizeForProcessing(
  inputPath: string,
  outputPath: string,
  jobId: string,
  maxDimension: number = 4096
): Promise<{ width: number; height: number }> {
  let sharpInstance: sharp.Sharp | null = null;
  
  try {
    sharpInstance = sharp(inputPath);
    const metadata = await sharpInstance.metadata();
    
    const needsResize = 
      (metadata.width && metadata.width > maxDimension) ||
      (metadata.height && metadata.height > maxDimension);
    
    if (needsResize) {
      console.log(`[Sharp] Resizing ${jobId}: ${metadata.width}x${metadata.height} → max ${maxDimension}`);
      
      await sharp(inputPath)
        .resize(maxDimension, maxDimension, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 95 })
        .toFile(outputPath);
      
      const resized = await sharp(outputPath).metadata();
      updatePeakMemory(jobId);
      
      return {
        width: resized.width || maxDimension,
        height: resized.height || maxDimension
      };
    } else {
      // No resize needed, just copy
      fs.copyFileSync(inputPath, outputPath);
      return {
        width: metadata.width || 0,
        height: metadata.height || 0
      };
    }
  } finally {
    // Clean up Sharp instance
    if (sharpInstance) {
      try {
        sharpInstance.destroy();
      } catch (err) {
        console.warn(`[Sharp] Error destroying instance:`, err);
      }
    }
  }
}

/**
 * Convert image to buffer with automatic cleanup
 */
export async function imageToBuffer(
  imagePath: string,
  jobId: string
): Promise<Buffer> {
  let sharpInstance: sharp.Sharp | null = null;
  
  try {
    sharpInstance = sharp(imagePath);
    const buffer = await sharpInstance.jpeg({ quality: 95 }).toBuffer();
    updatePeakMemory(jobId);
    return buffer;
  } finally {
    if (sharpInstance) {
      try {
        sharpInstance.destroy();
      } catch (err) {
        console.warn(`[Sharp] Error destroying instance:`, err);
      }
    }
  }
}

/**
 * Get image metadata safely with cleanup
 */
export async function getImageMetadata(
  imagePath: string,
  jobId: string
): Promise<sharp.Metadata> {
  let sharpInstance: sharp.Sharp | null = null;
  
  try {
    sharpInstance = sharp(imagePath);
    const metadata = await sharpInstance.metadata();
    updatePeakMemory(jobId);
    return metadata;
  } finally {
    if (sharpInstance) {
      try {
        sharpInstance.destroy();
      } catch (err) {
        console.warn(`[Sharp] Error destroying instance:`, err);
      }
    }
  }
}

/**
 * Apply transformation with automatic cleanup
 */
export async function applyTransformation(
  inputPath: string,
  outputPath: string,
  transform: (instance: sharp.Sharp) => sharp.Sharp,
  jobId: string
): Promise<void> {
  let sharpInstance: sharp.Sharp | null = null;
  
  try {
    sharpInstance = sharp(inputPath);
    const transformed = transform(sharpInstance);
    await transformed.toFile(outputPath);
    updatePeakMemory(jobId);
  } finally {
    if (sharpInstance) {
      try {
        sharpInstance.destroy();
      } catch (err) {
        console.warn(`[Sharp] Error destroying instance:`, err);
      }
    }
  }
}

/**
 * Stream-based image processing (for large images)
 * Reduces memory usage by processing in chunks
 */
export function createImageStream(inputPath: string): sharp.Sharp {
  return sharp(inputPath, {
    // Limit memory usage
    limitInputPixels: 268402689, // ~16384x16384
    sequentialRead: true
  });
}

// AUDIT FIX: Safe wrappers with try/catch, logging, and cleanup

/**
 * Safe resize — wraps sharp resize with error handling and structured logging
 */
export async function safeResize(
  inputPath: string,
  outputPath: string,
  width: number | undefined,
  height: number | undefined,
  jobId: string,
  options?: sharp.ResizeOptions & { format?: 'jpeg' | 'webp' | 'png'; quality?: number }
): Promise<void> {
  let inst: sharp.Sharp | null = null;
  try {
    inst = sharp(inputPath);
    let chain = inst.resize(width, height, {
      fit: options?.fit ?? 'inside',
      withoutEnlargement: options?.withoutEnlargement ?? true,
      ...options,
    });
    const fmt = options?.format ?? 'jpeg';
    const q = options?.quality ?? 95;
    if (fmt === 'webp') chain = chain.webp({ quality: q });
    else if (fmt === 'png') chain = chain.png();
    else chain = chain.jpeg({ quality: q });
    await chain.toFile(outputPath);
    updatePeakMemory(jobId);
    console.log(`[sharp-safe] safeResize OK job=${jobId} ${width ?? '?'}x${height ?? '?'} → ${outputPath}`);
  } catch (err) {
    console.error(`[sharp-safe] safeResize FAILED job=${jobId}:`, (err as Error)?.message ?? err);
    throw err;
  } finally {
    if (inst) { try { inst.destroy(); } catch (_) { /* noop */ } }
  }
}

/**
 * Safe rotate — wraps sharp rotate with error handling and structured logging
 */
export async function safeRotate(
  inputPath: string,
  outputPath: string,
  jobId: string,
  options?: { angle?: number; format?: 'jpeg' | 'webp' | 'png'; quality?: number }
): Promise<void> {
  let inst: sharp.Sharp | null = null;
  try {
    inst = sharp(inputPath);
    let chain = inst.rotate(options?.angle);
    const fmt = options?.format ?? 'jpeg';
    const q = options?.quality ?? 95;
    if (fmt === 'webp') chain = chain.webp({ quality: q });
    else if (fmt === 'png') chain = chain.png();
    else chain = chain.jpeg({ quality: q });
    await chain.toFile(outputPath);
    updatePeakMemory(jobId);
    console.log(`[sharp-safe] safeRotate OK job=${jobId} → ${outputPath}`);
  } catch (err) {
    console.error(`[sharp-safe] safeRotate FAILED job=${jobId}:`, (err as Error)?.message ?? err);
    throw err;
  } finally {
    if (inst) { try { inst.destroy(); } catch (_) { /* noop */ } }
  }
}

/**
 * Safe toBuffer — raw buffer without forced jpeg encoding
 */
export async function safeToBuffer(
  input: string | Buffer,
  jobId: string,
): Promise<Buffer> {
  let inst: sharp.Sharp | null = null;
  try {
    inst = sharp(input);
    const buf = await inst.toBuffer();
    updatePeakMemory(jobId);
    return buf;
  } catch (err) {
    console.error(`[sharp-safe] safeToBuffer FAILED job=${jobId}:`, (err as Error)?.message ?? err);
    throw err;
  } finally {
    if (inst) { try { inst.destroy(); } catch (_) { /* noop */ } }
  }
}

/**
 * Safe metadata — accepts both path and Buffer input
 */
export async function safeMetadata(
  input: string | Buffer,
  jobId: string,
): Promise<sharp.Metadata> {
  let inst: sharp.Sharp | null = null;
  try {
    inst = sharp(input);
    const meta = await inst.metadata();
    updatePeakMemory(jobId);
    return meta;
  } catch (err) {
    console.error(`[sharp-safe] safeMetadata FAILED job=${jobId}:`, (err as Error)?.message ?? err);
    throw err;
  } finally {
    if (inst) { try { inst.destroy(); } catch (_) { /* noop */ } }
  }
}
