/**
 * Memory monitoring utilities for worker process
 * Tracks memory usage per job and alerts on high usage
 */

interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  timestamp: number;
}

interface JobMemoryStats {
  jobId: string;
  start: MemorySnapshot;
  end?: MemorySnapshot;
  peak: number;
  delta: number;
}

const jobMemoryMap = new Map<string, JobMemoryStats>();
const MEMORY_WARNING_THRESHOLD = 0.8; // 80% of available memory

/**
 * Get current memory usage snapshot
 */
export function getMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    rss: usage.rss,
    timestamp: Date.now()
  };
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Start tracking memory for a job
 */
export function startMemoryTracking(jobId: string): void {
  const snapshot = getMemorySnapshot();
  jobMemoryMap.set(jobId, {
    jobId,
    start: snapshot,
    peak: snapshot.heapUsed,
    delta: 0
  });
  
  console.log(`[Memory] Job ${jobId} started - Heap: ${formatBytes(snapshot.heapUsed)}`);
}

/**
 * Update peak memory usage for a job
 */
export function updatePeakMemory(jobId: string): void {
  const stats = jobMemoryMap.get(jobId);
  if (!stats) return;
  
  const current = process.memoryUsage().heapUsed;
  if (current > stats.peak) {
    stats.peak = current;
  }
}

/**
 * End memory tracking for a job and return stats
 */
export function endMemoryTracking(jobId: string): JobMemoryStats | null {
  const stats = jobMemoryMap.get(jobId);
  if (!stats) return null;
  
  const snapshot = getMemorySnapshot();
  stats.end = snapshot;
  stats.delta = snapshot.heapUsed - stats.start.heapUsed;
  
  console.log(`[Memory] Job ${jobId} completed:`, {
    start: formatBytes(stats.start.heapUsed),
    end: formatBytes(snapshot.heapUsed),
    peak: formatBytes(stats.peak),
    delta: formatBytes(stats.delta),
    duration: `${((snapshot.timestamp - stats.start.timestamp) / 1000).toFixed(2)}s`
  });
  
  // Check if we're approaching memory limit
  const memoryUsagePercent = snapshot.heapUsed / snapshot.heapTotal;
  if (memoryUsagePercent > MEMORY_WARNING_THRESHOLD) {
    console.warn(`[Memory] ⚠️  High memory usage: ${(memoryUsagePercent * 100).toFixed(1)}% of heap`);
  }
  
  // Clean up
  jobMemoryMap.delete(jobId);
  
  return stats;
}

/**
 * Check if memory usage is critical
 */
export function isMemoryCritical(): boolean {
  const usage = process.memoryUsage();
  const percent = usage.heapUsed / usage.heapTotal;
  return percent > MEMORY_WARNING_THRESHOLD;
}

/**
 * Force garbage collection if available (requires --expose-gc flag)
 */
export function forceGC(): void {
  if (global.gc) {
    const before = process.memoryUsage().heapUsed;
    global.gc();
    const after = process.memoryUsage().heapUsed;
    const freed = before - after;
    console.log(`[Memory] GC freed ${formatBytes(freed)}`);
  }
}

/**
 * Get current memory stats
 */
export function getMemoryStats() {
  const usage = process.memoryUsage();
  return {
    heapUsed: formatBytes(usage.heapUsed),
    heapTotal: formatBytes(usage.heapTotal),
    external: formatBytes(usage.external),
    rss: formatBytes(usage.rss),
    usagePercent: ((usage.heapUsed / usage.heapTotal) * 100).toFixed(1) + '%'
  };
}
