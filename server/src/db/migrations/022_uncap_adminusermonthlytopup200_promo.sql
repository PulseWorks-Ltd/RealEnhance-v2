-- Lift the per-agency redemption cap on AdminUserMonthlyTopUp200 so the
-- scheduler (server/src/services/monthlyPromoTopup.ts) can keep topping up
-- the nominated accounts every month indefinitely, until manually disabled.
--
-- Previously capped at 2 redemptions per agency by migration 018, which
-- silently stopped further top-ups after 2 months (PROMO_MAXED_FOR_AGENCY).
--
-- NOT setting this to NULL: for this schema, max_redemptions_per_agency = NULL
-- does not mean "unlimited" — it triggers the legacy single-redemption dedupe
-- branch in redeemCreditPromoForExistingAgency() (server/src/services/trials.ts,
-- ~line 462), used by one-off codes like FoundingMember/GiveMe100/NewUser10,
-- which silently no-ops every redemption after the agency's first ever one.
-- Monthly cadence is already enforced separately via the
-- PROMO_ALREADY_REDEEMED_THIS_MONTH check, so a very high numeric cap here
-- behaves as "unlimited months" without colliding with that branch.
--
-- To retire this promo, set is_active = false (or lower this cap) directly
-- against promo_codes; no code change needed.

UPDATE promo_codes
   SET max_redemptions_per_agency = 999999,
       updated_at = NOW()
 WHERE code_normalized = 'adminusermonthlytopup200';
