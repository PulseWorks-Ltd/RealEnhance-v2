-- Add per-agency redemption limit and top-up target to promo_codes
-- max_redemptions_per_agency: if set, caps how many times a single agency can redeem this code
-- topup_target: if set, redemption grants (topup_target - current_credit_balance) credits
--               instead of a flat credits_granted amount

ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS max_redemptions_per_agency INTEGER,
  ADD COLUMN IF NOT EXISTS topup_target INTEGER;
