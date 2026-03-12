#!/usr/bin/env tsx

import Stripe from "stripe";
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

function isMissingResourceError(err: any): boolean {
  return err?.type === "StripeInvalidRequestError" && err?.code === "resource_missing";
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
  const clearAll = hasFlag("--clear-all");
  const onlyAgencyId = readArg("--agency");

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error("[cutover] Missing STRIPE_SECRET_KEY.");
    process.exit(1);
  }

  const stripeApiVersion = process.env.STRIPE_API_VERSION as Stripe.StripeConfig["apiVersion"] | undefined;
  const stripe = new Stripe(stripeKey, { apiVersion: stripeApiVersion });

  const agencyIds = onlyAgencyId ? [onlyAgencyId] : await listAgencyIds();
  console.log(`[cutover] Agencies to inspect: ${agencyIds.length}`);
  console.log(`[cutover] Mode: ${dryRun ? "DRY-RUN" : "APPLY"}${clearAll ? " (clear-all enabled)" : ""}`);

  let touched = 0;
  let unchanged = 0;
  let errors = 0;

  for (const agencyId of agencyIds) {
    try {
      const agency = await getAgency(agencyId);
      if (!agency) {
        console.warn(`[cutover] Agency not found: ${agencyId}`);
        continue;
      }

      const hadAnyStripeRef = !!(
        agency.stripeCustomerId ||
        agency.stripeSubscriptionId ||
        agency.stripePriceId
      );

      if (!hadAnyStripeRef && !clearAll) {
        unchanged++;
        continue;
      }

      const reasons: string[] = [];
      let shouldClear = false;

      if (clearAll && hadAnyStripeRef) {
        shouldClear = true;
        reasons.push("clear_all_requested");
      }

      if (!shouldClear && agency.stripeCustomerId) {
        try {
          const customer = await stripe.customers.retrieve(agency.stripeCustomerId);
          if ("deleted" in customer && customer.deleted) {
            shouldClear = true;
            reasons.push("customer_deleted");
          }
        } catch (err: any) {
          if (isMissingResourceError(err)) {
            shouldClear = true;
            reasons.push("customer_missing");
          } else {
            throw err;
          }
        }
      }

      if (!shouldClear && agency.stripeSubscriptionId) {
        try {
          await stripe.subscriptions.retrieve(agency.stripeSubscriptionId);
        } catch (err: any) {
          if (isMissingResourceError(err)) {
            shouldClear = true;
            reasons.push("subscription_missing");
          } else {
            throw err;
          }
        }
      }

      if (!shouldClear) {
        unchanged++;
        continue;
      }

      touched++;
      console.log(
        `[cutover] ${dryRun ? "Would clear" : "Clearing"} agency=${agency.agencyId} ` +
          `customer=${agency.stripeCustomerId || "-"} subscription=${agency.stripeSubscriptionId || "-"} ` +
          `reasons=${reasons.join(",")}`
      );

      if (!dryRun) {
        agency.stripeCustomerId = undefined;
        agency.stripeSubscriptionId = undefined;
        agency.stripePriceId = undefined;
        agency.currentPeriodStart = undefined;
        agency.currentPeriodEnd = undefined;
        agency.subscriptionStatus = "TRIAL";
        await updateAgency(agency);
      }
    } catch (err) {
      errors++;
      console.error(`[cutover] Failed for agency ${agencyId}:`, err);
    }
  }

  console.log("[cutover] Summary", {
    inspected: agencyIds.length,
    touched,
    unchanged,
    errors,
    mode: dryRun ? "dry-run" : "apply",
  });

  if (errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[cutover] Fatal error", err);
  process.exit(1);
});
