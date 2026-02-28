import { useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { useUsage } from "@/hooks/use-usage";

/**
 * RequireSubscription - Enhance Page Access Guard
 * 
 * RULE 5: Enhance page access requirements
 * Allow access ONLY if:
 * - User has agencyId AND
 * - (active subscription OR valid trial OR addonRemaining > 0)
 * 
 * If conditions not met → keep user on page and defer enforcement to action APIs
 * 
 * This ensures users cannot access Enhance without proper credits/subscription.
 */
export function RequireSubscription({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { usage, loading: usageLoading, error: usageError } = useUsage();

  useEffect(() => {
    if (authLoading || usageLoading) return;

    if (!user || !user.agencyId) return;

    // Do not redirect existing users on transient usage API failures.
    if (usageError || !usage) return;

    const hasActiveSubscription = !!(usage?.planName && usage.planName !== "Free" && usage.status === "active");
    const hasValidTrial = !!(usage?.trial && usage.trial.status === "active" && (usage.trial.remaining ?? 0) > 0);
    const hasAddonCredits = (usage?.addonRemaining ?? 0) > 0;
    const totalRemaining = Number.isFinite(usage?.remaining as number)
      ? Number(usage?.remaining)
      : Math.max(0, Number(usage?.mainRemaining ?? 0)) + Math.max(0, Number(usage?.addonRemaining ?? 0));
    const hasAnyCredits = totalRemaining > 0;
    const hasAccess = hasActiveSubscription || hasValidTrial || hasAddonCredits || hasAnyCredits;

    if (!hasAccess) {
      console.log("[RequireSubscription] No active subscription or credits; deferring enforcement to upload gate");
    }
  }, [user, authLoading, usage, usageLoading, usageError]);

  return <>{children}</>;
}
