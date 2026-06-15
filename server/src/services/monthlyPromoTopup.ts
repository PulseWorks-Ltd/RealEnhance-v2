import { getCurrentMonthKey } from "@realenhance/shared/usage/monthlyUsage.js";
import {
  MONTHLY_TOPUP_PROMO_CODE,
  MONTHLY_TOPUP_PROMO_INTERVAL_MS,
  MONTHLY_TOPUP_PROMO_USER_EMAILS,
} from "../config.js";
import { redeemCreditPromoForExistingAgency } from "./trials.js";
import { getUserByEmail } from "./users.js";

let cycleInFlight = false;

async function runTopupCycle(): Promise<void> {
  if (cycleInFlight) {
    console.log("[monthly_topup] skipping cycle because a previous cycle is still running");
    return;
  }

  cycleInFlight = true;
  const monthKey = getCurrentMonthKey();

  try {
    for (const email of MONTHLY_TOPUP_PROMO_USER_EMAILS) {
      try {
        const user = await getUserByEmail(email);
        if (!user) {
          console.warn(`[monthly_topup] user not found for email=${email}`);
          continue;
        }

        if (!user.agencyId) {
          console.warn(`[monthly_topup] user has no agency, skipping userId=${user.id} email=${email}`);
          continue;
        }

        const result = await redeemCreditPromoForExistingAgency({
          agencyId: user.agencyId,
          promoCode: MONTHLY_TOPUP_PROMO_CODE,
        });

        if (result.duplicated) {
          console.log(
            `[monthly_topup] already granted previously (legacy dedupe) agencyId=${user.agencyId} email=${email}`
          );
          continue;
        }

        console.log(
          `[monthly_topup] granted promo=${result.promo.code} agencyId=${user.agencyId} userId=${user.id} email=${email} ` +
            `credits=${result.bundle.imagesPurchased} month=${monthKey}`
        );
      } catch (err: any) {
        const code = String(err?.code || "");

        if (code === "PROMO_ALREADY_REDEEMED_THIS_MONTH") {
          console.log(`[monthly_topup] already redeemed this month email=${email} month=${monthKey}`);
          continue;
        }

        if (code === "PROMO_TOPUP_NOT_NEEDED") {
          console.log(
            `[monthly_topup] top-up not needed email=${email} currentTotal=${Number(err?.currentTotal || 0)}`
          );
          continue;
        }

        if (code === "PROMO_MAXED_FOR_AGENCY") {
          console.warn(
            `[monthly_topup] per-agency promo cap reached for email=${email} promo=${MONTHLY_TOPUP_PROMO_CODE}`
          );
          continue;
        }

        console.error(`[monthly_topup] grant failed for email=${email}`, err);
      }
    }
  } finally {
    cycleInFlight = false;
  }
}

export function startMonthlyPromoTopupScheduler(): () => void {
  if (!MONTHLY_TOPUP_PROMO_USER_EMAILS.length) {
    console.log("[monthly_topup] disabled (no MONTHLY_TOPUP_PROMO_USER_EMAILS configured)");
    return () => {};
  }

  console.log(
    `[monthly_topup] scheduler started promo=${MONTHLY_TOPUP_PROMO_CODE} users=${MONTHLY_TOPUP_PROMO_USER_EMAILS.length} ` +
      `intervalMs=${MONTHLY_TOPUP_PROMO_INTERVAL_MS}`
  );

  // Run once on startup so users don't need to wait for the next interval.
  void runTopupCycle().catch((err) => {
    console.error("[monthly_topup] initial cycle failed", err);
  });

  const timer = setInterval(() => {
    void runTopupCycle().catch((err) => {
      console.error("[monthly_topup] scheduled cycle failed", err);
    });
  }, MONTHLY_TOPUP_PROMO_INTERVAL_MS);

  return () => clearInterval(timer);
}
