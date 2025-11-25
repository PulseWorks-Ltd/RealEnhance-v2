import { getRedis } from "./redisClient";

export function parseRetryInfo(url: string) {
  const noQuery = url.split("?")[0];
  const filename = noQuery.split("/").pop() || "";
  const retryMatch = filename.match(/-retry(\d+)(?=\.[^.]+$)/);
  const retry = retryMatch ? parseInt(retryMatch[1], 10) : 0;
  const baseKey = filename.replace(/-retry\d+(?=\.[^.]+$)/, "");
  return { noQuery, filename, baseKey, retry };
}
const FAMILY_KEY_PREFIX = "image:family:"; // by baseKey
const URL_KEY_PREFIX = "image:url:";       // by normalized URL

type HistoryEntry = {
  imageId: string;
  ownerUserId: string;
  publicUrl: string;
  baseKey: string;
  versionId: string;
  stage?: string;
  isRetry?: boolean;
  retryCount?: number;
  ts: number;
};

function familyKey(baseKey: string) {
  return FAMILY_KEY_PREFIX + baseKey;
}
function urlKey(noQueryUrl: string) {
  return URL_KEY_PREFIX + noQueryUrl;
}

export async function recordEnhancedImageRedis(opts: {
  userId: string;
  imageId: string;
  publicUrl: string;
  baseKey?: string;
  versionId: string;
  stage?: string;
  isRetry?: boolean;
  retryCount?: number;
}) {
  const redis = getRedis();
  const { noQuery, baseKey: parsedBase, retry } = parseRetryInfo(opts.publicUrl);
  const baseKey = opts.baseKey || parsedBase;

  const entry: HistoryEntry = {
    imageId: opts.imageId,
    ownerUserId: opts.userId,
    publicUrl: opts.publicUrl,
    baseKey,
    versionId: opts.versionId,
    stage: opts.stage,
    isRetry: opts.isRetry,
    retryCount: opts.retryCount,
    ts: Date.now(),
  };

  const urlKeyStr = urlKey(noQuery);
  const familyKeyStr = familyKey(baseKey);

  const json = JSON.stringify(entry);

  // 1) Direct lookup by exact URL
  await redis.set(urlKeyStr, json, { EX: 60 * 60 * 24 * 90 }); // 90 days TTL

  // 2) Family list by baseKey (we'll choose best retry from here)
  await redis.lPush(familyKeyStr, json);
  await redis.expire(familyKeyStr, 60 * 60 * 24 * 90);

  console.log("[recordEnhancedImageRedis] stored", {
    imageId: opts.imageId,
    userId: opts.userId,
    baseKey,
    retry,
  });
}

export async function findByPublicUrlRedis(
  userId: string,
  url: string
): Promise<{ imageId: string; versionId: string } | null> {
  const redis = getRedis();
  const target = parseRetryInfo(url);

  // 1) Exact URL match first
  const urlJson = await redis.get(urlKey(target.noQuery));
  let exactOwnerMatch: HistoryEntry | null = null;
  let exactAnyMatch: HistoryEntry | null = null;

  if (urlJson) {
    const entry = JSON.parse(urlJson) as HistoryEntry;
    if (entry.ownerUserId === userId) {
      exactOwnerMatch = entry;
    } else {
      exactAnyMatch = entry;
    }
  }

  // 2) Family scan by baseKey
  const familyKeyStr = familyKey(target.baseKey);
  const familyJson = await redis.lRange(familyKeyStr, 0, -1);

  const familyEntries: HistoryEntry[] = familyJson
    .map((j: string) => {
      try {
        return JSON.parse(j) as HistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((x: HistoryEntry | null): x is HistoryEntry => !!x);

  const familyCandidates = familyEntries.map((e) => ({
    entry: e,
    retry: parseRetryInfo(e.publicUrl).retry,
  }));

  if (!exactOwnerMatch && !exactAnyMatch && familyCandidates.length > 0) {
    const sameOwner = familyCandidates.filter(
      (c) => c.entry.ownerUserId === userId
    );
    const pool = sameOwner.length > 0 ? sameOwner : familyCandidates;
    const best = pool.reduce(
      (best, cur) => (!best || cur.retry > best.retry ? cur : best),
      null as (typeof familyCandidates)[0] | null
    );
    if (best) {
      console.warn("[region-edit] Using family fallback match", {
        userId,
        targetUrl: url,
        baseKey: target.baseKey,
        chosenRetry: best.retry,
        owner: best.entry.ownerUserId,
      });
      return {
        imageId: best.entry.imageId,
        versionId: best.entry.versionId,
      };
    }
  }

  if (exactOwnerMatch) {
    return {
      imageId: exactOwnerMatch.imageId,
      versionId: exactOwnerMatch.versionId,
    };
  }
  if (exactAnyMatch) {
    return {
      imageId: exactAnyMatch.imageId,
      versionId: exactAnyMatch.versionId,
    };
  }

  console.warn("[region-edit] No image record found for user", {
    userId,
    url,
    baseKey: target.baseKey,
  });
  return null;
}
