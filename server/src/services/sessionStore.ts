import { getRedis } from "@realenhance/shared/redisClient.js";

/**
 * Remove all express-session records containing the given userId.
 * Best-effort: skips quietly if Redis scanning is unavailable (e.g. mock client).
 */
export async function invalidateSessionsForUser(userId: string): Promise<number> {
  try {
    const client = getRedis();
    const keys: string[] = [];

    const scanIterator = (client as any).scanIterator;
    if (typeof scanIterator === "function") {
      for await (const key of scanIterator.call(client, { MATCH: "sess:*", COUNT: 100 })) {
        keys.push(String(key));
      }
    } else if (typeof (client as any).keys === "function") {
      const found = await (client as any).keys("sess:*");
      keys.push(...(found || []).map(String));
    } else {
      console.warn("[sessions] Redis client cannot scan sessions; skipping invalidation");
      return 0;
    }

    let removed = 0;
    for (const key of keys) {
      const raw = await client.get(key);
      if (!raw) continue;
      try {
        const payload = JSON.parse(raw);
        if (payload?.user?.id === userId) {
          await client.del(key);
          removed += 1;
        }
      } catch (err) {
        console.warn(`[sessions] Failed to parse session ${key} for user ${userId}`, err);
      }
    }

    return removed;
  } catch (err) {
    console.warn(`[sessions] Failed to invalidate sessions for ${userId}:`, err);
    return 0;
  }
}
