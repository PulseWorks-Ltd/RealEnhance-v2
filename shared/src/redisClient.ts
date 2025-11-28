// @ts-ignore
import { createClient, RedisClientType } from "redis";

let client: RedisClientType | null = null;

export function getRedis(): RedisClientType {
  // If we already have a client (real or fake), reuse it
  if (client) return client;

  // ✅ In tests, use a fake in-memory client so we never talk to real Redis
  if (process.env.NODE_ENV === "test") {
    console.log("[redis] TEST MODE – using in-memory mock client");
      const fake: Partial<RedisClientType> = {
        // hash helpers
        hSet: async () => 1,
        hGet: async () => null,
        // key expiry
        expire: async () => 1,
        // simple string key
        set: async () => "OK" as any,
        // lists
        lPush: async () => 1 as any,
        lTrim: async () => "OK" as any,
    };

    client = fake as RedisClientType;
    return client;
  }

  // ✅ Normal behaviour (server/worker in dev/prod)
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  client = createClient({ url });

  client.on("error", (err: any) => {
    console.error("[redis] error", err);
  });

  client.connect().catch((err: any) => {
    console.error("[redis] connect failed", err);
  });

  console.log("[redis] connecting to", url);
  return client;
}
