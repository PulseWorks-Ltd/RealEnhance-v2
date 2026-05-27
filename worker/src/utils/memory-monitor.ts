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

interface TrackedResource {
  kind: "buffer" | "image";
  bytes: number;
  pixelFootprint: number;
  label: string;
}

export interface JobResourceSnapshot {
  activeImageCount: number;
  activeBufferCount: number;
  trackedBytes: number;
  trackedPixelFootprint: number;
}

export interface MemoryPhaseReport {
  token: string;
  jobId: string;
  phase: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  before: MemorySnapshot;
  after: MemorySnapshot;
  peakHeapUsed: number;
  deltaHeapUsed: number;
  outcome: "ok" | "error";
  resources: JobResourceSnapshot;
  metadata?: Record<string, unknown>;
}

interface ActivePhase {
  token: string;
  jobId: string;
  phase: string;
  before: MemorySnapshot;
  startedAt: number;
  peakHeapUsed: number;
  interval?: NodeJS.Timeout;
}

const jobMemoryMap = new Map<string, JobMemoryStats>();
const jobResourceMap = new Map<string, Map<string, TrackedResource>>();
const activePhaseMap = new Map<string, ActivePhase>();
let phaseCounter = 0;
const MEMORY_WARNING_THRESHOLD = 0.8; // 80% of available memory
const PHASE_PEAK_WARNING_THRESHOLD = MEMORY_WARNING_THRESHOLD;
const JOB_RETAINED_WARNING_THRESHOLD = MEMORY_WARNING_THRESHOLD;
const PHASE_DELTA_WARNING_BYTES = 20 * 1024 * 1024; // 20MB

function toFiniteNumber(value: number | undefined | null): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value);
}

function getOrCreateJobResources(jobId: string): Map<string, TrackedResource> {
  const existing = jobResourceMap.get(jobId);
  if (existing) return existing;
  const created = new Map<string, TrackedResource>();
  jobResourceMap.set(jobId, created);
  return created;
}

function collectJobResources(jobId: string): JobResourceSnapshot {
  const entries = jobResourceMap.get(jobId);
  if (!entries) {
    return {
      activeImageCount: 0,
      activeBufferCount: 0,
      trackedBytes: 0,
      trackedPixelFootprint: 0,
    };
  }

  let activeImageCount = 0;
  let activeBufferCount = 0;
  let trackedBytes = 0;
  let trackedPixelFootprint = 0;

  for (const value of entries.values()) {
    if (value.kind === "image") activeImageCount += 1;
    if (value.kind === "buffer") activeBufferCount += 1;
    trackedBytes += value.bytes;
    trackedPixelFootprint += value.pixelFootprint;
  }

  return {
    activeImageCount,
    activeBufferCount,
    trackedBytes,
    trackedPixelFootprint,
  };
}

function buildPhaseToken(jobId: string, phase: string): string {
  phaseCounter += 1;
  return `${jobId}:${phase}:${phaseCounter}`;
}

function stopPhaseSampler(phase: ActivePhase): void {
  if (!phase.interval) return;
  clearInterval(phase.interval);
  phase.interval = undefined;
}

function safeUsagePercent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return used / total;
}

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
  jobResourceMap.delete(jobId);
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

  for (const phase of activePhaseMap.values()) {
    if (phase.jobId !== jobId) continue;
    if (current > phase.peakHeapUsed) {
      phase.peakHeapUsed = current;
    }
  }
}

/**
 * Track a buffer-like resource for memory forensics.
 */
export function trackJobBuffer(jobId: string, key: string, bytes: number, label?: string): void {
  if (!jobId || !key) return;
  const resources = getOrCreateJobResources(jobId);
  resources.set(key, {
    kind: "buffer",
    bytes: Math.max(0, Math.floor(toFiniteNumber(bytes))),
    pixelFootprint: 0,
    label: label || key,
  });
}

/**
 * Track an image-like resource for memory forensics.
 */
export function trackJobImage(
  jobId: string,
  key: string,
  options?: { estimatedBytes?: number; width?: number; height?: number; label?: string }
): void {
  if (!jobId || !key) return;
  const resources = getOrCreateJobResources(jobId);
  const width = Math.max(0, Math.floor(toFiniteNumber(options?.width)));
  const height = Math.max(0, Math.floor(toFiniteNumber(options?.height)));
  resources.set(key, {
    kind: "image",
    bytes: Math.max(0, Math.floor(toFiniteNumber(options?.estimatedBytes))),
    pixelFootprint: width > 0 && height > 0 ? width * height : 0,
    label: options?.label || key,
  });
}

/**
 * Release a tracked resource once it is no longer needed by the job.
 */
export function releaseJobResource(jobId: string, key: string): void {
  const resources = jobResourceMap.get(jobId);
  if (!resources) return;
  resources.delete(key);
}

/**
 * Read current tracked resource counters for a job.
 */
export function getJobResourceSnapshot(jobId: string): JobResourceSnapshot {
  return collectJobResources(jobId);
}

/**
 * Begin a phase-level memory telemetry window.
 */
export function beginMemoryPhase(
  jobId: string,
  phase: string,
  metadata?: Record<string, unknown>
): string {
  const before = getMemorySnapshot();
  const token = buildPhaseToken(jobId, phase);
  const active: ActivePhase = {
    token,
    jobId,
    phase,
    before,
    startedAt: before.timestamp,
    peakHeapUsed: before.heapUsed,
  };

  active.interval = setInterval(() => {
    const heapUsed = process.memoryUsage().heapUsed;
    if (heapUsed > active.peakHeapUsed) {
      active.peakHeapUsed = heapUsed;
    }
  }, 250);
  active.interval.unref?.();

  activePhaseMap.set(token, active);
  console.log("[MEM_PHASE_START]", {
    token,
    jobId,
    phase,
    heapUsed: formatBytes(before.heapUsed),
    rss: formatBytes(before.rss),
    activeJobs: jobMemoryMap.size,
    metadata: metadata || null,
    resources: collectJobResources(jobId),
  });

  return token;
}

/**
 * Opportunistically update a phase peak without closing the phase.
 */
export function markMemoryPhasePeak(token: string): void {
  const active = activePhaseMap.get(token);
  if (!active) return;
  const heapUsed = process.memoryUsage().heapUsed;
  if (heapUsed > active.peakHeapUsed) {
    active.peakHeapUsed = heapUsed;
  }
}

/**
 * End a phase-level telemetry window and emit structured report.
 */
export function endMemoryPhase(
  token: string,
  outcome: "ok" | "error" = "ok",
  metadata?: Record<string, unknown>
): MemoryPhaseReport | null {
  const active = activePhaseMap.get(token);
  if (!active) return null;
  activePhaseMap.delete(token);
  stopPhaseSampler(active);

  const after = getMemorySnapshot();
  const report: MemoryPhaseReport = {
    token: active.token,
    jobId: active.jobId,
    phase: active.phase,
    startedAt: active.startedAt,
    endedAt: after.timestamp,
    durationMs: Math.max(0, after.timestamp - active.startedAt),
    before: active.before,
    after,
    peakHeapUsed: Math.max(active.peakHeapUsed, after.heapUsed),
    deltaHeapUsed: after.heapUsed - active.before.heapUsed,
    outcome,
    resources: collectJobResources(active.jobId),
    metadata,
  };

  console.log("[MEM_PHASE_END]", {
    token: report.token,
    jobId: report.jobId,
    phase: report.phase,
    outcome: report.outcome,
    durationMs: report.durationMs,
    beforeHeap: formatBytes(report.before.heapUsed),
    afterHeap: formatBytes(report.after.heapUsed),
    deltaHeap: formatBytes(report.deltaHeapUsed),
    peakHeap: formatBytes(report.peakHeapUsed),
    beforeRss: formatBytes(report.before.rss),
    afterRss: formatBytes(report.after.rss),
    resources: report.resources,
    metadata: report.metadata || null,
  });

  const phasePeakHeapTotal = Math.max(report.before.heapTotal, report.after.heapTotal, 1);
  const phasePeakUsagePercent = safeUsagePercent(report.peakHeapUsed, phasePeakHeapTotal);
  if (
    phasePeakUsagePercent > PHASE_PEAK_WARNING_THRESHOLD
    && report.deltaHeapUsed >= PHASE_DELTA_WARNING_BYTES
  ) {
    console.warn("[MEMORY_PHASE_PEAK_WARNING]", {
      kind: "phase_peak_pressure",
      jobId: report.jobId,
      phase: report.phase,
      token: report.token,
      peakHeap: formatBytes(report.peakHeapUsed),
      beforeHeap: formatBytes(report.before.heapUsed),
      afterHeap: formatBytes(report.after.heapUsed),
      deltaHeap: formatBytes(report.deltaHeapUsed),
      phasePeakUsagePercent: `${(phasePeakUsagePercent * 100).toFixed(1)}%`,
      durationMs: report.durationMs,
      note: "Transient phase pressure: peak during phase execution, not retained post-job pressure.",
    });
  }

  return report;
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

  const openPhaseTokens: string[] = [];
  for (const [token, phase] of activePhaseMap.entries()) {
    if (phase.jobId !== jobId) continue;
    openPhaseTokens.push(token);
  }
  for (const token of openPhaseTokens) {
    endMemoryPhase(token, "error", { reason: "job_end_cleanup" });
  }

  const resources = collectJobResources(jobId);
  
  console.log(`[Memory] Job ${jobId} completed:`, {
    start: formatBytes(stats.start.heapUsed),
    end: formatBytes(snapshot.heapUsed),
    peak: formatBytes(stats.peak),
    delta: formatBytes(stats.delta),
    duration: `${((snapshot.timestamp - stats.start.timestamp) / 1000).toFixed(2)}s`,
    resources,
  });
  
  // Check if we're approaching memory limit
  const retainedUsagePercent = safeUsagePercent(snapshot.heapUsed, snapshot.heapTotal);
  if (retainedUsagePercent > JOB_RETAINED_WARNING_THRESHOLD) {
    console.warn("[MEMORY_RETAINED_PRESSURE_WARNING]", {
      kind: "retained_post_job_pressure",
      jobId,
      retainedHeap: formatBytes(snapshot.heapUsed),
      heapTotal: formatBytes(snapshot.heapTotal),
      retainedUsagePercent: `${(retainedUsagePercent * 100).toFixed(1)}%`,
      note: "Retained pressure after job completion. This is distinct from in-phase transient spikes.",
    });
  }
  
  // Clean up
  jobMemoryMap.delete(jobId);
  jobResourceMap.delete(jobId);
  
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
