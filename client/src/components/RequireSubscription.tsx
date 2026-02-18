import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
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
 * If conditions not met → redirect to /signup
 * 
 * This ensures users cannot access Enhance without proper credits/subscription.
 */
export function RequireSubscription({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { usage, loading: usageLoading, error: usageError } = useUsage();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (authLoading || usageLoading) return;

    if (!user || !user.agencyId) return;

    // Do not redirect existing users on transient usage API failures.
    if (usageError || !usage) return;

    const hasActiveSubscription = !!(usage?.planName && usage.planName !== "Free" && usage.status === "active");
    const hasValidTrial = !!(usage?.trial && usage.trial.status === "active" && (usage.trial.remaining ?? 0) > 0);
    const hasAddonCredits = (usage?.addonRemaining ?? 0) > 0;
    const hasAnyCredits = (usage?.remaining ?? 0) > 0;
    const hasAccess = hasActiveSubscription || hasValidTrial || hasAddonCredits || hasAnyCredits;

    if (!hasAccess && location.pathname !== "/signup") {
      console.log("[RequireSubscription] No active subscription or credits, redirecting to signup");
      navigate("/signup", {
        replace: true,
        state: { from: location.pathname, reason: "subscription_required" },
      });
    }
  }, [user, authLoading, usage, usageLoading, usageError, navigate, location.pathname]);

  return <>{children}</>;
}
