import { getRedis } from "./redisClient";

const ACTIVE_USERS_SET_KEY = "active:users";
const USER_ACTIVE_KEY_PREFIX = "active:user:";
const ACTIVE_KEY_TTL_SECONDS = Math.max(60, Number(process.env.FAIR_SCHEDULER_ACTIVE_TTL_SECONDS || 600));

const WORKER_REPLICAS = Math.max(1, Number(process.env.WORKER_REPLICAS || process.env.RAILWAY_WORKER_REPLICAS || 1));
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2));

export type FairShareDecision = {
  canStart: boolean;
  activeUsers: number;
  maxJobsPerUser: number;
  userActiveJobs: number;
  totalSlots: number;
};

function userKey(userId: string): string {
  return `${USER_ACTIVE_KEY_PREFIX}${userId}`;
}

export async function getActiveJobsByUser(): Promise<Record<string, number>> {
  const redis = getRedis() as any;
  const userIdsRaw = await redis.sMembers(ACTIVE_USERS_SET_KEY);
  const userIds = Array.isArray(userIdsRaw) ? userIdsRaw.map((v: unknown) => String(v)) : [];

  const activeJobs: Record<string, number> = {};
  for (const userId of userIds) {
    const raw = await redis.get(userKey(userId));
    const count = Math.max(0, Number(raw || 0));
    if (count > 0) {
      activeJobs[userId] = count;
      continue;
    }

    // Clean up stale set entries when counters are missing/zero.
    await redis.sRem(ACTIVE_USERS_SET_KEY, userId);
    await redis.del(userKey(userId));
  }

  return activeJobs;
}

export async function evaluateFairShare(userId: string): Promise<FairShareDecision> {
  const activeJobs = await getActiveJobsByUser();
  const activeUsersRaw = Object.keys(activeJobs).length;
  const activeUsers = activeUsersRaw || 1;

  const totalSlots = WORKER_REPLICAS * WORKER_CONCURRENCY;
  const minShare = WORKER_CONCURRENCY;
  const share = Math.floor(totalSlots / activeUsers);
  const maxJobsPerUser = Math.max(share, minShare);
  const userActiveJobs = activeJobs[userId] || 0;

  // First-image priority: always allow a new user to start their first job immediately.
  if (userActiveJobs === 0) {
    return {
      canStart: true,
      activeUsers,
      maxJobsPerUser,
      userActiveJobs,
      totalSlots,
    };
  }

  return {
    canStart: userActiveJobs < maxJobsPerUser,
    activeUsers,
    maxJobsPerUser,
    userActiveJobs,
    totalSlots,
  };
}

export async function canStartJob(userId: string): Promise<boolean> {
  const decision = await evaluateFairShare(userId);
  return decision.canStart;
}

export async function markJobStarted(userId: string): Promise<void> {
  if (!userId) return;

  const redis = getRedis() as any;
  await redis.sAdd(ACTIVE_USERS_SET_KEY, userId);
  await redis.incr(userKey(userId));
  await redis.expire(userKey(userId), ACTIVE_KEY_TTL_SECONDS);
}

export async function markJobFinished(userId: string): Promise<void> {
  if (!userId) return;

  const redis = getRedis() as any;
  const nextCount = Number(await redis.decr(userKey(userId)));

  if (!Number.isFinite(nextCount) || nextCount <= 0) {
    await redis.del(userKey(userId));
    await redis.sRem(ACTIVE_USERS_SET_KEY, userId);
    return;
  }

  await redis.expire(userKey(userId), ACTIVE_KEY_TTL_SECONDS);
}
