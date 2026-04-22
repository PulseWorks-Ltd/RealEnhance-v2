import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(serverRoot, ".env") });

type RedisAgency = {
  agencyId: string;
  name: string;
  planTier: string | null;
  subscriptionStatus: string;
  stripeCustomerId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  createdAt: string;
};

type RedisUser = {
  id: string;
  email: string;
  role: string;
  agencyId: string;
  createdAt: string;
};

type PromoCodeAdminRow = {
  id: number;
  code: string;
  code_normalized: string;
  is_active: boolean;
  expires_at: string | null;
  max_redemptions: number | null;
  redemptions_count: number;
  trial_days: number;
  credits_granted: number;
  created_at: string;
  updated_at: string;
};

function getCurrentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthlyIncluded(planTier: string | null | undefined, planLimits: Record<string, { mainAllowance?: number }>): number {
  if (!planTier) return 0;
  return planLimits[planTier]?.mainAllowance ?? 0;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm --filter @realenhance/server run admin:dump summary
  pnpm --filter @realenhance/server run admin:dump agencies
  pnpm --filter @realenhance/server run admin:dump agency <agencyId>
  pnpm --filter @realenhance/server run admin:dump promo-codes
  pnpm --filter @realenhance/server run admin:dump all`);
}

async function main(): Promise<void> {
  const [{ getRedis }, { pool }, { PLAN_LIMITS }] = await Promise.all([
    import("@realenhance/shared/redisClient.js"),
    import("../src/db/index.js"),
    import("@realenhance/shared/plans.js"),
  ]);

  const redis = getRedis();

  async function getAllAgenciesFromRedis(): Promise<RedisAgency[]> {
    const keys = await redis.keys("agency:*");
    const agencies: RedisAgency[] = [];

    for (const key of keys) {
      try {
        const data = await redis.hGetAll(key);
        if (!data?.agencyId) continue;
        agencies.push({
          agencyId: data.agencyId,
          name: data.name || "",
          planTier: data.planTier || null,
          subscriptionStatus: data.subscriptionStatus || "ACTIVE",
          stripeCustomerId: data.stripeCustomerId || undefined,
          currentPeriodStart: data.currentPeriodStart || undefined,
          currentPeriodEnd: data.currentPeriodEnd || undefined,
          createdAt: data.createdAt || "",
        });
      } catch {
        continue;
      }
    }

    return agencies;
  }

  async function getAllUsersGroupedByAgency(): Promise<Map<string, RedisUser[]>> {
    const keys = await redis.keys("user:*");
    const userMap = new Map<string, RedisUser[]>();

    for (const key of keys) {
      try {
        if ((await redis.type(key)) !== "hash") continue;
        const data = await redis.hGetAll(key);
        if (!data?.agencyId) continue;

        const user: RedisUser = {
          id: data.id,
          email: data.email || "",
          role: data.role || "member",
          agencyId: data.agencyId,
          createdAt: data.createdAt || "",
        };

        const list = userMap.get(data.agencyId) || [];
        list.push(user);
        userMap.set(data.agencyId, list);
      } catch {
        continue;
      }
    }

    return userMap;
  }

  async function fetchSummary() {
    const agencies = await getAllAgenciesFromRedis();
    const monthKey = getCurrentMonthKey();

    const [trialRes, jobsRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM organisations WHERE trial_status = 'active'`),
      pool.query(
        `SELECT COALESCE(SUM(reserved_images), 0) AS total
           FROM job_reservations
          WHERE created_at >= NOW() - INTERVAL '30 days'
            AND reservation_status IN ('consumed', 'committed')`
      ),
    ]);

    return {
      month: monthKey,
      totalAgencies: agencies.length,
      activeSubscriptions: agencies.filter((agency) => agency.subscriptionStatus === "ACTIVE").length,
      trialUsers: Number(trialRes.rows[0]?.count || 0),
      imagesLast30Days: Number(jobsRes.rows[0]?.total || 0),
    };
  }

  async function fetchAgencies() {
    const agencies = await getAllAgenciesFromRedis();
    const userMap = await getAllUsersGroupedByAgency();
    const monthKey = getCurrentMonthKey();

    const [usageRows, accountRows, trialRows, lastActiveRows] = await Promise.all([
      pool.query<{ agency_id: string; included_used: number; addon_used: number }>(
        `SELECT agency_id, included_used, addon_used
           FROM agency_month_usage
          WHERE yyyymm = $1`,
        [monthKey]
      ),
      pool.query<{ agency_id: string; addon_images_balance: number }>(
        `SELECT agency_id, addon_images_balance FROM agency_accounts`
      ),
      pool.query<{
        agency_id: string;
        trial_status: string;
        trial_credits_total: number;
        trial_credits_used: number;
      }>(
        `SELECT agency_id, trial_status, trial_credits_total, trial_credits_used FROM organisations`
      ),
      pool.query<{ agency_id: string; last_active: string }>(
        `SELECT agency_id, MAX(created_at) AS last_active FROM job_reservations GROUP BY agency_id`
      ),
    ]);

    const usageMap = new Map<string, { includedUsed: number; addonUsed: number }>();
    for (const row of usageRows.rows) {
      usageMap.set(row.agency_id, {
        includedUsed: Number(row.included_used || 0),
        addonUsed: Number(row.addon_used || 0),
      });
    }

    const accountMap = new Map<string, number>();
    for (const row of accountRows.rows) {
      accountMap.set(row.agency_id, Number(row.addon_images_balance || 0));
    }

    const trialMap = new Map<string, { status: string; remaining: number }>();
    for (const row of trialRows.rows) {
      trialMap.set(row.agency_id, {
        status: row.trial_status,
        remaining: Math.max(0, Number(row.trial_credits_total || 0) - Number(row.trial_credits_used || 0)),
      });
    }

    const lastActiveMap = new Map<string, string>();
    for (const row of lastActiveRows.rows) {
      lastActiveMap.set(row.agency_id, row.last_active);
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = agencies.map((agency) => {
      const monthlyIncluded = getMonthlyIncluded(agency.planTier, PLAN_LIMITS as Record<string, { mainAllowance?: number }>);
      const usage = usageMap.get(agency.agencyId);
      const usedThisMonth = usage ? usage.includedUsed + usage.addonUsed : 0;
      const trial = trialMap.get(agency.agencyId);
      const lastActiveAt = lastActiveMap.get(agency.agencyId) ?? null;
      const usagePercent = monthlyIncluded > 0 ? usedThisMonth / monthlyIncluded : 0;

      return {
        agencyId: agency.agencyId,
        agencyName: agency.name,
        planTier: agency.planTier,
        subscriptionStatus: agency.subscriptionStatus,
        stripeCustomerId: agency.stripeCustomerId ?? null,
        seats: (userMap.get(agency.agencyId) ?? []).length,
        monthlyIncluded,
        usedThisMonth,
        remainingThisMonth: Math.max(0, monthlyIncluded - (usage?.includedUsed || 0)),
        trialRemaining: trial?.status === "active" ? trial.remaining : 0,
        addonBalance: accountMap.get(agency.agencyId) ?? 0,
        createdAt: agency.createdAt,
        lastActiveAt,
        usagePercent: Math.round(usagePercent * 100) / 100,
        isNearLimit: usagePercent >= 0.8,
        isInactive: lastActiveAt ? new Date(lastActiveAt) < sevenDaysAgo : true,
      };
    });

    result.sort((left, right) => {
      const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
      return rightTime - leftTime;
    });

    return { month: monthKey, agencies: result };
  }

  async function fetchAgencyDetail(agencyId: string) {
    const data = await redis.hGetAll(`agency:${agencyId}`);
    if (!data?.agencyId) {
      throw new Error(`Agency not found: ${agencyId}`);
    }

    const agency: RedisAgency = {
      agencyId: data.agencyId,
      name: data.name || "",
      planTier: data.planTier || null,
      subscriptionStatus: data.subscriptionStatus || "ACTIVE",
      stripeCustomerId: data.stripeCustomerId || undefined,
      currentPeriodStart: data.currentPeriodStart || undefined,
      currentPeriodEnd: data.currentPeriodEnd || undefined,
      createdAt: data.createdAt || "",
    };

    const monthKey = getCurrentMonthKey();
    const monthlyIncluded = getMonthlyIncluded(agency.planTier, PLAN_LIMITS as Record<string, { mainAllowance?: number }>);

    const [usageRes, lifetimeRes, trialRes, accountRes, jobStatsRes, users] = await Promise.all([
      pool.query(
        `SELECT included_used, addon_used
           FROM agency_month_usage
          WHERE agency_id = $1 AND yyyymm = $2`,
        [agencyId, monthKey]
      ),
      pool.query(
        `SELECT COALESCE(SUM(included_used + addon_used), 0) AS total
           FROM agency_month_usage
          WHERE agency_id = $1`,
        [agencyId]
      ),
      pool.query(
        `SELECT trial_status, trial_credits_total, trial_credits_used, trial_expires_at
           FROM organisations
          WHERE agency_id = $1`,
        [agencyId]
      ),
      pool.query(
        `SELECT addon_images_balance FROM agency_accounts WHERE agency_id = $1`,
        [agencyId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(retry_count), 0) AS retries,
                COALESCE(SUM(edit_count), 0) AS edits,
                MAX(created_at) AS last_active
           FROM job_reservations
          WHERE agency_id = $1`,
        [agencyId]
      ),
      (async () => {
        const keys = await redis.keys("user:*");
        const rows: RedisUser[] = [];
        for (const key of keys) {
          try {
            if ((await redis.type(key)) !== "hash") continue;
            const user = await redis.hGetAll(key);
            if (user?.agencyId !== agencyId) continue;
            rows.push({
              id: user.id,
              email: user.email || "",
              role: user.role || "member",
              agencyId: user.agencyId,
              createdAt: user.createdAt || "",
            });
          } catch {
            continue;
          }
        }
        return rows;
      })(),
    ]);

    const usageRow = usageRes.rows[0];
    const imagesThisMonth = usageRow
      ? Number(usageRow.included_used || 0) + Number(usageRow.addon_used || 0)
      : 0;
    const trialRow = trialRes.rows[0];

    return {
      agencyId: agency.agencyId,
      agencyName: agency.name,
      planTier: agency.planTier,
      subscriptionStatus: agency.subscriptionStatus,
      stripeCustomerId: agency.stripeCustomerId ?? null,
      currentPeriodStart: agency.currentPeriodStart ?? null,
      currentPeriodEnd: agency.currentPeriodEnd ?? null,
      createdAt: agency.createdAt,
      seats: users.length,
      monthlyIncluded,
      usedThisMonth: imagesThisMonth,
      remainingThisMonth: Math.max(0, monthlyIncluded - (Number(usageRow?.included_used) || 0)),
      trialRemaining: trialRow
        ? Math.max(0, Number(trialRow.trial_credits_total || 0) - Number(trialRow.trial_credits_used || 0))
        : 0,
      addonBalance: Number(accountRes.rows[0]?.addon_images_balance || 0),
      lastActiveAt: jobStatsRes.rows[0]?.last_active ?? null,
      usage: {
        totalImagesProcessed: Number(lifetimeRes.rows[0]?.total || 0),
        imagesThisMonth,
        retryCount: Number(jobStatsRes.rows[0]?.retries || 0),
        editCount: Number(jobStatsRes.rows[0]?.edits || 0),
      },
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
      })),
    };
  }

  async function fetchPromoCodes() {
    const result = await pool.query<PromoCodeAdminRow>(
      `SELECT id, code, code_normalized, is_active, expires_at, max_redemptions, redemptions_count,
              trial_days, credits_granted, created_at, updated_at
         FROM promo_codes
        ORDER BY created_at DESC, id DESC`
    );

    return {
      promoCodes: result.rows.map((row) => ({
        id: row.id,
        code: row.code,
        normalizedCode: row.code_normalized,
        isActive: row.is_active,
        expiresAt: row.expires_at,
        maxRedemptions: row.max_redemptions,
        redemptionsCount: row.redemptions_count,
        trialDays: row.trial_days,
        creditsGranted: row.credits_granted,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  const command = process.argv[2];
  const arg = process.argv[3];

  try {
    let payload: unknown;

    switch (command) {
      case "summary":
        payload = await fetchSummary();
        break;
      case "agencies":
        payload = await fetchAgencies();
        break;
      case "agency":
        if (!arg) {
          printUsage();
          process.exitCode = 1;
          return;
        }
        payload = await fetchAgencyDetail(arg);
        break;
      case "promo-codes":
        payload = await fetchPromoCodes();
        break;
      case "all":
        payload = {
          summary: await fetchSummary(),
          agencies: await fetchAgencies(),
          promoCodes: await fetchPromoCodes(),
        };
        break;
      default:
        printUsage();
        process.exitCode = 1;
        return;
    }

    console.log(JSON.stringify(payload, null, 2));
  } finally {
    await Promise.resolve(redis.quit?.()).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});