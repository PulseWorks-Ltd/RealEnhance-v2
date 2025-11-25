
// @ts-ignore
import { createClient, RedisClientType } from "redis";

let client: RedisClientType | null = null;

export function getRedis(): RedisClientType {
  if (!client) {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    client = createClient({ url });

    client.on("error", (err: any) => {
      console.error("[redis] error", err);
    });

    client.connect().catch((err: any) => {
      console.error("[redis] connect failed", err);
    });

    console.log("[redis] connecting to", url);
  }
  return client;
}
