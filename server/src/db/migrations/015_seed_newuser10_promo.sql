INSERT INTO promo_codes (code, code_normalized, is_active, max_redemptions, trial_days, credits_granted)
VALUES ('NewUser10', 'newuser10', true, NULL, 30, 10)
ON CONFLICT (code_normalized) DO UPDATE
SET is_active = EXCLUDED.is_active,
    max_redemptions = EXCLUDED.max_redemptions,
    trial_days = EXCLUDED.trial_days,
    credits_granted = EXCLUDED.credits_granted,
    updated_at = NOW();
