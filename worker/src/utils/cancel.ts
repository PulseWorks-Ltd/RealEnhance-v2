import { createClient, type RedisClientType } from "redis";

let client: RedisClientType | null = null;

export function getRedis(): RedisClientType | null {
  if (client) return client;
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  try {
    client = createClient({ url });
    client.on("error", (e) => console.warn("[worker][redis]", e));
    client.connect().catch(() => {});
    return client;
  } catch {
    return null;
  }
}

const key = (jobId: string) => `re:cancel:${jobId}`;

export async function isCancelled(jobId: string): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  try {
    const v = await r.get(key(jobId));
    return v === "1";
  } catch {
    return false;
  }
}
