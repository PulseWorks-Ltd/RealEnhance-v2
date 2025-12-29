#!/usr/bin/env tsx
// Emergency CLI tool for managing agency subscriptions
// Usage: tsx server/scripts/manage-subscription.ts <command> <agencyId> [args...]

import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";
import type { SubscriptionStatus, PlanTier } from "@realenhance/shared/auth/types.js";

async function main() {
  const [command, agencyId, ...args] = process.argv.slice(2);

  if (!command || !agencyId) {
    console.log(`
Usage: tsx server/scripts/manage-subscription.ts <command> <agencyId> [args...]

Commands:
  get <agencyId>                           - Get current subscription status
  activate <agencyId>                      - Set subscription to ACTIVE
  cancel <agencyId>                        - Set subscription to CANCELLED
  set-status <agencyId> <status>          - Set subscription status (ACTIVE|PAST_DUE|CANCELLED|TRIAL)
  set-plan <agencyId> <tier>              - Set plan tier (starter|pro|agency)
  set-period <agencyId> <start> <end>     - Set billing period (ISO dates)

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

        console.log(`\n📋 Agency: ${agency.name} (${agency.agencyId})`);
        console.log(`   Plan: ${agency.planTier}`);
        console.log(`   Status: ${agency.subscriptionStatus}`);
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
        console.log();
        break;
      }

      case "activate": {
        const agency = await getAgency(agencyId);
        if (!agency) {
          console.error(`❌ Agency ${agencyId} not found`);
          process.exit(1);
        }

        agency.subscriptionStatus = "ACTIVE";
        agency.updatedAt = new Date().toISOString();
        await updateAgency(agency);

        console.log(`✅ Activated subscription for ${agency.name} (${agencyId})`);
        console.log(`   Status: ${agency.subscriptionStatus}`);
        break;
      }

      case "cancel": {
        const agency = await getAgency(agencyId);
        if (!agency) {
          console.error(`❌ Agency ${agencyId} not found`);
          process.exit(1);
        }

        agency.subscriptionStatus = "CANCELLED";
        agency.updatedAt = new Date().toISOString();
        await updateAgency(agency);

        console.log(`✅ Cancelled subscription for ${agency.name} (${agencyId})`);
        console.log(`   Status: ${agency.subscriptionStatus}`);
        break;
      }

      case "set-status": {
        const status = args[0] as SubscriptionStatus;
        const validStatuses: SubscriptionStatus[] = ["ACTIVE", "PAST_DUE", "CANCELLED", "TRIAL"];

        if (!status || !validStatuses.includes(status)) {
          console.error(`❌ Invalid status. Valid options: ${validStatuses.join(", ")}`);
          process.exit(1);
        }

        const agency = await getAgency(agencyId);
        if (!agency) {
          console.error(`❌ Agency ${agencyId} not found`);
          process.exit(1);
        }

        agency.subscriptionStatus = status;
        agency.updatedAt = new Date().toISOString();
        await updateAgency(agency);

        console.log(`✅ Updated subscription status for ${agency.name} (${agencyId})`);
        console.log(`   Status: ${agency.subscriptionStatus}`);
        break;
      }

      case "set-plan": {
        const tier = args[0] as PlanTier;
        const validTiers: PlanTier[] = ["starter", "pro", "agency"];

        if (!tier || !validTiers.includes(tier)) {
          console.error(`❌ Invalid plan tier. Valid options: ${validTiers.join(", ")}`);
          process.exit(1);
        }

        const agency = await getAgency(agencyId);
        if (!agency) {
          console.error(`❌ Agency ${agencyId} not found`);
          process.exit(1);
        }

        agency.planTier = tier;
        agency.updatedAt = new Date().toISOString();
        await updateAgency(agency);

        console.log(`✅ Updated plan tier for ${agency.name} (${agencyId})`);
        console.log(`   Plan: ${agency.planTier}`);
        break;
      }

      case "set-period": {
        const [start, end] = args;

        if (!start || !end) {
          console.error(`❌ Usage: set-period <agencyId> <start> <end>`);
          console.error(`   Example: set-period agency_123 2025-01-01 2025-02-01`);
          process.exit(1);
        }

        // Validate ISO date format
        const startDate = new Date(start);
        const endDate = new Date(end);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          console.error(`❌ Invalid date format. Use ISO format (YYYY-MM-DD)`);
          process.exit(1);
        }

        const agency = await getAgency(agencyId);
        if (!agency) {
          console.error(`❌ Agency ${agencyId} not found`);
          process.exit(1);
        }

        agency.currentPeriodStart = startDate.toISOString();
        agency.currentPeriodEnd = endDate.toISOString();
        agency.updatedAt = new Date().toISOString();
        await updateAgency(agency);

        console.log(`✅ Updated billing period for ${agency.name} (${agencyId})`);
        console.log(`   Period: ${agency.currentPeriodStart} → ${agency.currentPeriodEnd}`);
        break;
      }

      default:
        console.error(`❌ Unknown command: ${command}`);
        console.error(`   Run without arguments to see usage`);
        process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    console.error(`❌ Error:`, error);
    process.exit(1);
  }
}

main();
