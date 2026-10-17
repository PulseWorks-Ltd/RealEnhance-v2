// Regression tests for the C3 fix — the advisory per-job processing lock
// that prevents two live workers from running the same jobId concurrently
// (see src/utils/jobProcessingLock.ts's doc comment for the full history).
//
// Uses a minimal in-memory fake Redis client rather than a real Redis
// server, matching this codebase's established pattern of testing pure
// logic directly with literal fixture data. The fake's `set` faithfully
// implements NX+EX semantics; its `eval` models the exact documented
// contract of RELEASE_IF_OWNER_SCRIPT (compare-and-delete by token) rather
// than executing real Lua — that contract is exactly what
// acquireJobProcessingLock/releaseJobProcessingLock depend on.
import {
  acquireJobProcessingLock,
  releaseJobProcessingLock,
  jobProcessingLockKey,
  JOB_PROCESSING_LOCK_TTL_SECONDS,
  type JobProcessingLockClient,
} from "../src/utils/jobProcessingLock";

function makeFakeRedis(): JobProcessingLockClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string, opts: { NX: true; EX: number }) {
      if (opts.NX && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async eval(_script: string, opts: { keys: string[]; arguments: string[] }) {
      const [key] = opts.keys;
      const [expectedToken] = opts.arguments;
      if (store.get(key) === expectedToken) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  };
}

describe("jobProcessingLock (C3 fix)", () => {
  it("acquires the lock when no one else holds it", async () => {
    const redis = makeFakeRedis();
    const acquired = await acquireJobProcessingLock(redis, "job_A", "token_1");
    expect(acquired).toBe(true);
    expect(redis.store.get(jobProcessingLockKey("job_A"))).toBe("token_1");
  });

  it("refuses a second acquire for the same jobId while the first holder's lock is live — the exact duplicate-dispatch scenario", async () => {
    const redis = makeFakeRedis();
    const firstAcquired = await acquireJobProcessingLock(redis, "job_A", "token_worker_A");
    expect(firstAcquired).toBe(true);

    // Simulates BullMQ's stalled-job reassignment handing the same jobId
    // to a second worker while the first is still genuinely alive.
    const secondAcquired = await acquireJobProcessingLock(redis, "job_A", "token_worker_B");
    expect(secondAcquired).toBe(false);
    // The original holder's token must be untouched.
    expect(redis.store.get(jobProcessingLockKey("job_A"))).toBe("token_worker_A");
  });

  it("different jobIds do not contend with each other", async () => {
    const redis = makeFakeRedis();
    expect(await acquireJobProcessingLock(redis, "job_A", "token_1")).toBe(true);
    expect(await acquireJobProcessingLock(redis, "job_B", "token_2")).toBe(true);
  });

  it("release frees the lock so a legitimate later run of the same jobId can acquire it", async () => {
    const redis = makeFakeRedis();
    await acquireJobProcessingLock(redis, "job_A", "token_1");
    await releaseJobProcessingLock(redis, "job_A", "token_1");

    expect(redis.store.has(jobProcessingLockKey("job_A"))).toBe(false);
    const reacquired = await acquireJobProcessingLock(redis, "job_A", "token_2");
    expect(reacquired).toBe(true);
  });

  it("release does NOT delete a lock a different holder has since legitimately acquired (compare-and-delete safety)", async () => {
    const redis = makeFakeRedis();
    // token_1's own invocation is releasing late — after its TTL already
    // expired and a different worker (token_2) legitimately re-acquired
    // the lock for a genuine retry of the same jobId.
    redis.store.set(jobProcessingLockKey("job_A"), "token_2");

    await releaseJobProcessingLock(redis, "job_A", "token_1");

    // token_2's lock must survive token_1's stale release attempt.
    expect(redis.store.get(jobProcessingLockKey("job_A"))).toBe("token_2");
  });

  it("releasing a lock that was never acquired, or already released, is a safe no-op", async () => {
    const redis = makeFakeRedis();
    await expect(releaseJobProcessingLock(redis, "job_never_locked", "token_x")).resolves.not.toThrow();
  });

  it("propagates errors from the underlying client rather than swallowing them — the fail-open policy belongs to the caller, not this module", async () => {
    const failingClient: JobProcessingLockClient = {
      set: async () => {
        throw new Error("redis unavailable");
      },
      eval: async () => {
        throw new Error("redis unavailable");
      },
    };
    await expect(acquireJobProcessingLock(failingClient, "job_A", "token_1")).rejects.toThrow("redis unavailable");
    await expect(releaseJobProcessingLock(failingClient, "job_A", "token_1")).rejects.toThrow("redis unavailable");
  });

  it("uses a TTL matching the codebase's existing 20-minute stuck-job threshold", () => {
    expect(JOB_PROCESSING_LOCK_TTL_SECONDS).toBe(20 * 60);
  });
});
