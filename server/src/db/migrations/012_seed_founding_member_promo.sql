-- Seed the FoundingMember promo code: first 20 redemptions get 1 month Starter free (75 credits, 30 days)
INSERT INTO promo_codes (code, code_normalized, is_active, max_redemptions, trial_days, credits_granted)
VALUES ('FoundingMember', 'foundingmember', true, 20, 30, 75)
ON CONFLICT (code_normalized) DO NOTHING;
