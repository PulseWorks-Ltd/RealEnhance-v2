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

/**
 * Update the user stored in every open session for this user (e.g. a new
 * role after an ownership transfer), so the app shows it without a re-login.
 * Session TTLs are kept. Best-effort; returns how many sessions were updated.
 */
export async function updateSessionsForUser(userId: string, patch: Record<string, unknown>): Promise<number> {
  try {
    const client = getRedis();
    const keys: string[] = [];
    const scanIterator = (client as any).scanIterator;
    if (typeof scanIterator === "function") {
      for await (const key of scanIterator.call(client, { MATCH: "sess:*", COUNT: 100 })) keys.push(String(key));
    } else if (typeof (client as any).keys === "function") {
      keys.push(...((await (client as any).keys("sess:*")) || []).map(String));
    } else {
      return 0;
    }
    let updated = 0;
    for (const key of keys) {
      const raw = await client.get(key);
      if (!raw) continue;
      try {
        const payload = JSON.parse(raw);
        if (payload?.user?.id !== userId) continue;
        payload.user = { ...payload.user, ...patch };
        const ttl = Number(await (client as any).ttl(key));
        if (ttl > 0) await (client as any).set(key, JSON.stringify(payload), { EX: ttl });
        else await client.set(key, JSON.stringify(payload));
        updated += 1;
      } catch {
        /* skip unreadable session */
      }
    }
    return updated;
  } catch (err) {
    console.warn(`[sessions] Failed to update sessions for ${userId}:`, err);
    return 0;
  }
}
