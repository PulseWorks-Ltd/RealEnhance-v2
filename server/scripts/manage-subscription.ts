#!/usr/bin/env tsx
// server/scripts/manage-subscription.ts
// Emergency CLI tool for managing agency subscriptions
// Usage: tsx server/scripts/manage-subscription.ts <command> <agencyId> [options]

import { getAgency, updateAgencySubscriptionStatus, updateAgency } from "@realenhance/shared/agencies.js";
import type { SubscriptionStatus, PlanTier } from "@realenhance/shared/auth/types.js";

const VALID_STATUSES: SubscriptionStatus[] = ["ACTIVE", "PAST_DUE", "CANCELLED", "TRIAL"];
const VALID_TIERS: PlanTier[] = ["starter", "pro", "agency"];

async function main() {
  const [command, agencyId, ...args] = process.argv.slice(2);

  if (!command || !agencyId) {
    console.log(`
Emergency Subscription Management CLI

Usage:
  tsx server/scripts/manage-subscription.ts <command> <agencyId> [options]

Commands:
  get <agencyId>
    Get current subscription status

  activate <agencyId>
    Set subscription to ACTIVE

  cancel <agencyId>
    Set subscription to CANCELLED

  set-status <agencyId> <status>
    Set subscription status (ACTIVE|PAST_DUE|CANCELLED|TRIAL)

  set-plan <agencyId> <tier>
    Set plan tier (starter|pro|agency)

  set-period <agencyId> <start> <end>
    Set billing period (ISO dates)

Examples:
  tsx server/scripts/manage-subscription.ts get agency_123
  tsx server/scripts/manage-subscription.ts activate agency_123
  tsx server/scripts/manage-subscription.ts set-status agency_123 ACTIVE
  tsx server/scripts/manage-subscription.ts set-plan agency_123 pro
  tsx server/scripts/manage-subscription.ts set-period agency_123 2025-01-01 2025-02-01
`);
    process.exit(1);
  }

  try {
    switch (command) {
      case "get": {
        const agency = await getAgency(agencyId);
        if (!agency) {
          console.error(`❌ Agency ${agencyId} not found`);
          process.exit(1);
        }

        console.log(`\n📋 Agency: ${agency.name}`);
        console.log(`   ID: ${agency.agencyId}`);
        console.log(`   Plan: ${agency.planTier}`);
        console.log(`   Subscription: ${agency.subscriptionStatus}`);
        if (agency.currentPeriodStart) {
          console.log(`   Period Start: ${agency.currentPeriodStart}`);
        }
        if (agency.currentPeriodEnd) {
          console.log(`   Period End: ${agency.currentPeriodEnd}`);
        }
        console.log(`   Created: ${agency.createdAt}`);
        if (agency.updatedAt) {
          console.log(`   Updated: ${agency.updatedAt}`);
        }
        break;
      }

      case "activate": {
        await updateAgencySubscriptionStatus(agencyId, "ACTIVE");
        console.log(`✅ Activated subscription for agency ${agencyId}`);
        const updated = await getAgency(agencyId);
        if (updated) {
          console.log(`   Status: ${updated.subscriptionStatus}`);
        }
        break;
      }

      case "cancel": {
        await updateAgencySubscriptionStatus(agencyId, "CANCELLED");
        console.log(`✅ Cancelled subscription for agency ${agencyId}`);
        const updated = await getAgency(agencyId);
        if (updated) {
          console.log(`   Status: ${updated.subscriptionStatus}`);
        }
        break;
      }

      case "set-status": {
        const status = args[0] as SubscriptionStatus;
        if (!status || !VALID_STATUSES.includes(status)) {
          console.error(`❌ Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`);
          process.exit(1);
        }

        await updateAgencySubscriptionStatus(agencyId, status);
        console.log(`✅ Set subscription status to ${status} for agency ${agencyId}`);
        break;
      }

      case "set-plan": {
        const tier = args[0] as PlanTier;
        if (!tier || !VALID_TIERS.includes(tier)) {
          console.error(`❌ Invalid plan tier. Must be one of: ${VALID_TIERS.join(", ")}`);
          process.exit(1);
        }

        const agency = await getAgency(agencyId);
        if (!agency) {
          console.error(`❌ Agency ${agencyId} not found`);
          process.exit(1);
        }

        agency.planTier = tier;
        await updateAgency(agency);
        console.log(`✅ Set plan tier to ${tier} for agency ${agencyId}`);
        break;
      }

      case "set-period": {
        const start = args[0];
        const end = args[1];

        if (!start || !end) {
          console.error("❌ Both start and end dates required (ISO format)");
          process.exit(1);
        }

        const agency = await getAgency(agencyId);
        if (!agency) {
          console.error(`❌ Agency ${agencyId} not found`);
          process.exit(1);
        }

        agency.currentPeriodStart = start;
        agency.currentPeriodEnd = end;
        await updateAgency(agency);
        console.log(`✅ Set billing period for agency ${agencyId}`);
        console.log(`   Start: ${start}`);
        console.log(`   End: ${end}`);
        break;
      }

      default:
        console.error(`❌ Unknown command: ${command}`);
        console.log("   Run without arguments to see usage");
        process.exit(1);
    }
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }

  process.exit(0);
}

main();
