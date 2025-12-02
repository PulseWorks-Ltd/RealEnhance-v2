import { getRedis } from "./redisClient";

export type RetryInfo = {
  noQuery: string;
  filename: string;
  baseKey: string;
  retry: number;
};

/**
 * Parse a public URL into a normalized "noQuery" URL, a baseKey
 * (filename without retry suffix), and a numeric retry counter.
 *
 * Examples:
 *  - https://.../abc.jpg            → baseKey "abc",   retry 0
 *  - https://.../abc-retry1.jpg     → baseKey "abc",   retry 1
 *  - https://.../abc-retry12.webp   → baseKey "abc",   retry 12
 */
export function parseRetryInfo(url: string): RetryInfo {
  if (!url || typeof url !== "string") {
    throw new Error("[keys] parseRetryInfo: unusable url input");
  }
  let noQuery = url;
  let normalized = false;
  let reason = "";
  // Strip query string if present
  if (url.includes("?")) {
    noQuery = url.split("?")[0];
    normalized = true;
    reason = "had query string";
  }
  const filename = noQuery.split("/").pop() || "";
  const retryMatch = filename.match(/-retry(\d+)(?=\.[^.]+$)/);
  const retry = retryMatch ? parseInt(retryMatch[1], 10) : 0;
  const baseKey = filename.replace(/-retry\d+(?=\.[^.]+$)/, "");
  if (normalized) {
    console.info(`[keys] normalized url from ${url} to ${noQuery} (reason: ${reason})`);
  }
  return { noQuery, filename, baseKey, retry };
}

const FAMILY_KEY_PREFIX = "image:family:"; // keyed by baseKey
const URL_KEY_PREFIX = "image:url:"; // keyed by normalized URL

export type HistoryEntry = {
  imageId: string;
  ownerUserId: string;
  publicUrl: string;
  baseKey: string;
  versionId: string;
  stage?: string;
  stage2?: string;
  isRetry?: boolean;
  retryCount?: number;
  ts: number;
};

function familyKey(baseKey: string): string {
  return FAMILY_KEY_PREFIX + baseKey;
}

function urlKey(noQueryUrl: string): string {
  return URL_KEY_PREFIX + noQueryUrl;
}

/**
 * Record an enhanced image in Redis in two ways:
 *  - by normalized URL (for exact lookups)
 *  - by baseKey "family" list (to find images even after retries)
 */
export async function recordEnhancedImageRedis(opts: {
  userId: string;
  imageId: string;
  publicUrl: string;
  baseKey: string; // now required
  versionId: string;
  stage?: string;
  stage2?: string;
  isRetry?: boolean;
  retryCount?: number;
}): Promise<void> {
  const redis = getRedis() as any;

  // Allow empty versionId for region-edit and edit stages which don't have S3 versions
  const isEditStage = opts.stage === "region-edit" || opts.stage === "edit";
  if (!opts.userId || !opts.imageId || !opts.publicUrl || (!opts.versionId && !isEditStage)) {
    throw new Error("[imageStore] recordEnhancedImageRedis: unusable input (missing userId, imageId, publicUrl, or versionId)");
  }

  const parsed = parseRetryInfo(opts.publicUrl);
  const retryFromFilename =
    typeof parsed.retry === "number" ? parsed.retry > 0 : undefined;

  // Defensive: always use normalized baseKey
  let baseKey = opts.baseKey || parsed.baseKey || "";
  if (opts.baseKey && opts.baseKey !== parsed.baseKey) {
    console.info(`[keys] normalized baseKey from ${opts.baseKey} to ${parsed.baseKey} (reason: mismatch with filename)`);
    baseKey = parsed.baseKey;
  }

  const entry: HistoryEntry = {
    imageId: opts.imageId,
    ownerUserId: opts.userId,
    publicUrl: opts.publicUrl,
    baseKey,
    versionId: opts.versionId,
    stage: opts.stage,
    stage2: opts.stage2,
    isRetry: opts.isRetry ?? retryFromFilename,
    retryCount: opts.retryCount,
    ts: Date.now(),
  };

  const urlKeyStr = urlKey(parsed.noQuery);
  const familyKeyStr = familyKey(baseKey);
  const json = JSON.stringify(entry);

  // 1) Exact URL → entry
  try {
    await redis.set(urlKeyStr, json);
  } catch (err) {
    console.warn("[imageStore] Failed to set URL key in redis", {
      urlKey: urlKeyStr,
      err,
    });
  }

  // 2) Family list (baseKey) → [entries...], newest first
  try {
    await redis.lPush(familyKeyStr, json);
    // Keep only the most recent N entries to avoid unbounded growth
    await redis.lTrim(familyKeyStr, 0, 50);
  } catch (err) {
    console.warn("[imageStore] Failed to push family entry in redis", {
      familyKey: familyKeyStr,
      err,
    });
  }
}

/**
 * Find an image by public URL + user.
 *
 * Preference order:
 *  1. Exact URL match for this user.
 *  2. Latest family entry for this user (same baseKey).
 *  3. Latest family entry for any user with this baseKey.
 */
export async function findByPublicUrlRedis(
  userId: string,
  url: string
): Promise<{ imageId: string; versionId: string } | null> {
  const redis = getRedis() as any;
  if (!userId || !url) {
    throw new Error("[imageStore] findByPublicUrlRedis: unusable input (missing userId or url)");
  }
  const parsed = parseRetryInfo(url);
  const baseKey = parsed.baseKey;
  const urlKeyStr = urlKey(parsed.noQuery);
  const familyKeyStr = familyKey(baseKey);

  // 1) Exact URL match
  try {
    const byUrl = await redis.get(urlKeyStr);
    if (byUrl) {
      const entry = JSON.parse(byUrl) as HistoryEntry;
      if (entry && entry.imageId && entry.versionId) {
        if (entry.ownerUserId === userId) {
          return { imageId: entry.imageId, versionId: entry.versionId };
        }
      }
    }
  } catch (err) {
    console.warn("[imageStore] Failed URL lookup in redis", {
      urlKey: urlKeyStr,
      err,
    });
  }

  // 2) Family list lookups
  let familyEntries: HistoryEntry[] = [];
  try {
    const familyJson: string[] = (await redis.lRange(
      familyKeyStr,
      0,
      -1
    )) as string[];
    familyEntries = familyJson
      .map((j) => {
        try {
          return JSON.parse(j) as HistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is HistoryEntry => !!e);
  } catch (err) {
    console.warn("[imageStore] Failed family lookup in redis", {
      familyKey: familyKeyStr,
      err,
    });
  }

  if (familyEntries.length > 0) {
    // Prefer same user, newest first
    const sameUser = familyEntries.find((e) => e.ownerUserId === userId);
    if (sameUser) {
      return { imageId: sameUser.imageId, versionId: sameUser.versionId };
    }

    // Fallback to any entry in the family
    const exactAnyMatch = familyEntries[0];
    if (exactAnyMatch) {
      return {
        imageId: exactAnyMatch.imageId,
        versionId: exactAnyMatch.versionId,
      };
    }
  }

  // Distinguish not found (for API to return IMAGE_HISTORY_NOT_FOUND)
  console.warn("[region-edit] No image record found for user", {
    userId,
    url,
    baseKey,
    reason: "IMAGE_HISTORY_NOT_FOUND"
  });

  return null;
}
