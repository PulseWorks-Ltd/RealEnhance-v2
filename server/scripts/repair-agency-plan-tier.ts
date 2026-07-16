#!/usr/bin/env tsx
// One-time repair for agencies persisted with an entitled subscriptionStatus
// (ACTIVE/TRIAL) but no planTier — see shared/src/agencies.ts enforcePlanTierInvariant.
// These records were created before that invariant was enforced at write time,
// so getPlanLimitForAgency() (server/src/services/usageLedger.ts) correctly
// returns 0 allowance for them ("missing_plan_tier").
//
// Usage:
//   tsx server/scripts/repair-agency-plan-tier.ts              (dry run, report only)
//   tsx server/scripts/repair-agency-plan-tier.ts --apply       (apply fixes)
//   tsx server/scripts/repair-agency-plan-tier.ts --agency <id> (limit to one agency)

import { getRedis } from "@realenhance/shared/redisClient.js";
import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function listAgencyIds(): Promise<string[]> {
  const redis = getRedis();
  const keys = await redis.keys("agency:*");
  const ids: string[] = [];

  for (const key of keys) {
    const keyType = await redis.type(key);
    if (keyType !== "hash") continue;
    const data = await redis.hGetAll(key);
    if (!data || !data.agencyId) continue;
    ids.push(data.agencyId);
  }

  return ids;
}

async function main() {
  const dryRun = !hasFlag("--apply");
  const onlyAgencyId = readArg("--agency");

  const agencyIds = onlyAgencyId ? [onlyAgencyId] : await listAgencyIds();
  console.log(`[repair] Agencies to inspect: ${agencyIds.length}`);
  console.log(`[repair] Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);

  const categories = {
    trialMissingPlan: [] as string[],
    activeMissingPlan: [] as string[],
    cancelledWithPlan: [] as string[], // reported only — expected/correct state, not repaired
  };

  for (const agencyId of agencyIds) {
    const agency = await getAgency(agencyId);
    if (!agency) continue;

    if (!agency.planTier && agency.subscriptionStatus === "TRIAL") {
      categories.trialMissingPlan.push(agencyId);
    } else if (!agency.planTier && agency.subscriptionStatus === "ACTIVE") {
      categories.activeMissingPlan.push(agencyId);
    } else if (agency.planTier && agency.subscriptionStatus === "CANCELLED") {
      categories.cancelledWithPlan.push(agencyId);
    }
  }

  console.log("[repair] Counts", {
    "subscriptionStatus=TRIAL, planTier=null": categories.trialMissingPlan.length,
    "subscriptionStatus=ACTIVE, planTier=null": categories.activeMissingPlan.length,
    "subscriptionStatus=CANCELLED, planTier set (expected — not repaired)":
      categories.cancelledWithPlan.length,
  });

  const toRepair = [...categories.trialMissingPlan, ...categories.activeMissingPlan];
  let repaired = 0;
  let errors = 0;

  for (const agencyId of toRepair) {
    try {
      const agency = await getAgency(agencyId);
      if (!agency) continue;

      console.log(
        `[repair] ${dryRun ? "Would fix" : "Fixing"} agency=${agencyId} ` +
          `status=${agency.subscriptionStatus} planTier=null -> starter`
      );

      if (!dryRun) {
        // updateAgency() applies enforcePlanTierInvariant() internally, defaulting
        // planTier to "starter" since subscriptionStatus is ACTIVE/TRIAL and planTier is null.
        await updateAgency(agency);
        repaired++;
      }
    } catch (err) {
      errors++;
      console.error(`[repair] Failed for agency ${agencyId}:`, err);
    }
  }

  console.log("[repair] Summary", {
    inspected: agencyIds.length,
    eligibleForRepair: toRepair.length,
    repaired,
    errors,
    mode: dryRun ? "dry-run" : "apply",
  });

  if (errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[repair] Fatal error", err);
  process.exit(1);
});
