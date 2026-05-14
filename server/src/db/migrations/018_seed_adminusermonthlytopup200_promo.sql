-- Seed the AdminUserMonthlyTopUp200 promo code.
-- Each redemption tops up the agency's total credits to 200 (adds the deficit only).
-- An agency can redeem this code at most 2 times (2 monthly top-ups).
-- No global redemption cap; credits_granted = 200 is the theoretical maximum per redemption.

INSERT INTO promo_codes (
  code,
  code_normalized,
  is_active,
  max_redemptions,
  max_redemptions_per_agency,
  topup_target,
  trial_days,
  credits_granted
)
VALUES (
  'AdminUserMonthlyTopUp200',
  'adminusermonthlytopup200',
  true,
  NULL,
  2,
  200,
  30,
  200
)
ON CONFLICT (code_normalized) DO UPDATE
  SET is_active                  = EXCLUDED.is_active,
      max_redemptions            = EXCLUDED.max_redemptions,
      max_redemptions_per_agency = EXCLUDED.max_redemptions_per_agency,
      topup_target               = EXCLUDED.topup_target,
      trial_days                 = EXCLUDED.trial_days,
      credits_granted            = EXCLUDED.credits_granted,
      updated_at                 = NOW();
