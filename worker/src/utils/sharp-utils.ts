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
    
    let cleaned = 0;
    for (const file of jobFiles) {
      try {
        fs.unlinkSync(path.join(tempDir, file));
        cleaned++;
      } catch (err) {
        console.warn(`[Cleanup] Failed to delete ${file}:`, err);
      }
    }
    
    if (cleaned > 0) {
      console.log(`[Cleanup] Deleted ${cleaned} temp files for job ${jobId}`);
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
