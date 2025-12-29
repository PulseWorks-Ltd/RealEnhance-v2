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
        get: async () => null,
        // lists
        lPush: async () => 1 as any,
        lTrim: async () => "OK" as any,
        lRange: async () => [] as any,
    };

    client = fake as RedisClientType;
    return client;
  }

  // ✅ If no REDIS_URL set, use mock client (for services that don't need Redis)
  const url = process.env.REDIS_URL;

  if (!url) {
    console.log("[redis] MOCK MODE – no REDIS_URL set, using in-memory stub");
    const store = new Map<string, string>();
    const hashStore = new Map<string, Map<string, string>>();
    const listStore = new Map<string, string[]>();

    const mock: Partial<RedisClientType> = {
      // Hash operations
      // @ts-ignore - Mock signature doesn't match all overloads
      hSet: async (key: any, field: any, value: any) => {
        const k = String(key);
        const f = String(field);
        const v = String(value);
        if (!hashStore.has(k)) hashStore.set(k, new Map());
        hashStore.get(k)!.set(f, v);
        return 1;
      },
      hGet: async (key: any, field: any) => {
        const k = String(key);
        const f = String(field);
        return hashStore.get(k)?.get(f) ?? null;
      },
      // Key expiry (no-op in mock)
      expire: async () => 1,
      // Simple string operations
      set: async (key: any, value: any) => {
        store.set(String(key), String(value));
        return "OK" as any;
      },
      get: async (key: any) => {
        return store.get(String(key)) ?? null;
      },
      del: async (key: any) => {
        const existed = store.delete(String(key));
        return existed ? 1 : 0;
      },
      // List operations
      // @ts-ignore - Mock signature doesn't match all overloads
      lPush: async (key: any, ...values: any[]) => {
        const k = String(key);
        if (!listStore.has(k)) listStore.set(k, []);
        listStore.get(k)!.unshift(...values.map(String));
        return listStore.get(k)!.length as any;
      },
      lTrim: async () => "OK" as any,
      lRange: async (key: any, start: number, stop: number) => {
        const k = String(key);
        const list = listStore.get(k) || [];
        // Handle negative indices like Redis
        const len = list.length;
        const startIdx = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
        const stopIdx = stop < 0 ? Math.max(0, len + stop + 1) : Math.min(stop + 1, len);
        return list.slice(startIdx, stopIdx);
      },
    };

    client = mock as RedisClientType;
    return client;
  }

  // ✅ Normal behaviour (server/worker in dev/prod)
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
