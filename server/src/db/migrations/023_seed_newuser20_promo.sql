-- Seed the NEWUSER20 promo code: 20 free credits, valid for 30 days.
-- New agencies only (no previous trial, paid subscription or one-off purchase,
-- and no other new-user code), and each agency can redeem it once.
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
  'NEWUSER20',
  'newuser20',
  true,
  NULL,
  1,
  NULL,
  30,
  20
)
ON CONFLICT (code_normalized) DO UPDATE
  SET is_active                  = EXCLUDED.is_active,
      max_redemptions            = EXCLUDED.max_redemptions,
      max_redemptions_per_agency = EXCLUDED.max_redemptions_per_agency,
      topup_target               = EXCLUDED.topup_target,
      trial_days                 = EXCLUDED.trial_days,
      credits_granted            = EXCLUDED.credits_granted,
      updated_at                 = NOW();
