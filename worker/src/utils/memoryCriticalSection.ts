type MemorySectionState = {
  active: number;
  waiters: Array<() => void>;
};

type MemorySectionOptions = {
  section: string;
  maxConcurrency?: number;
  metadata?: Record<string, unknown>;
};

const sectionStates = new Map<string, MemorySectionState>();

function getState(section: string): MemorySectionState {
  const existing = sectionStates.get(section);
  if (existing) return existing;
  const created: MemorySectionState = { active: 0, waiters: [] };
  sectionStates.set(section, created);
  return created;
}

function normalizeConcurrency(value: number | undefined, fallback: number): number {
  const candidate = Number.isFinite(value) ? Number(value) : fallback;
  if (!Number.isFinite(candidate)) return fallback;
  if (candidate <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(candidate));
}

export function resolveSectionConcurrency(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey]);
  return normalizeConcurrency(raw, fallback);
}

export async function withMemoryCriticalSection<T>(
  options: MemorySectionOptions,
  operation: () => Promise<T>
): Promise<T> {
  const section = String(options.section || "unknown_section");
  const maxConcurrency = normalizeConcurrency(options.maxConcurrency, 2);
  const state = getState(section);
  const queuedAt = Date.now();

  if (state.active >= maxConcurrency) {
    await new Promise<void>((resolve) => {
      state.waiters.push(resolve);
    });
  }

  state.active += 1;
  const acquiredAt = Date.now();
  let peakHeapUsed = process.memoryUsage().heapUsed;
  let peakRss = process.memoryUsage().rss;
  const startMem = process.memoryUsage();
  const monitor = setInterval(() => {
    const mem = process.memoryUsage();
    if (mem.heapUsed > peakHeapUsed) peakHeapUsed = mem.heapUsed;
    if (mem.rss > peakRss) peakRss = mem.rss;
  }, 25);

  console.log("[MEMORY_CRITICAL_SECTION_ACQUIRED]", JSON.stringify({
    section,
    maxConcurrency: Number.isFinite(maxConcurrency) ? maxConcurrency : "unbounded",
    activeCount: state.active,
    queuedCount: state.waiters.length,
    waitMs: acquiredAt - queuedAt,
    heapUsed: startMem.heapUsed,
    rss: startMem.rss,
    ...options.metadata,
  }));

  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    clearInterval(monitor);
    const durationMs = Date.now() - startedAt;
    state.active = Math.max(0, state.active - 1);
    const next = state.waiters.shift();
    if (next) next();

    const endMem = process.memoryUsage();
    console.log("[MEMORY_CRITICAL_SECTION_RELEASED]", JSON.stringify({
      section,
      maxConcurrency: Number.isFinite(maxConcurrency) ? maxConcurrency : "unbounded",
      activeCount: state.active,
      queuedCount: state.waiters.length,
      durationMs,
      heapUsed: endMem.heapUsed,
      rss: endMem.rss,
      peakHeapUsed,
      peakRss,
      heapDelta: endMem.heapUsed - startMem.heapUsed,
      rssDelta: endMem.rss - startMem.rss,
      ...options.metadata,
    }));
  }
}
