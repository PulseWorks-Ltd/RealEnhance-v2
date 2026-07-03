import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { useUsage } from "@/hooks/use-usage";
import { Loader2 } from "lucide-react";

/**
 * RequireSubscription - Enhance Page Access Guard
 * 
 * RULE 5: Enhance page access requirements
 * Allow access ONLY if:
 * - User has agencyId AND
 * - (active subscription OR valid trial OR addonRemaining > 0)
 * 
 * If conditions not met → redirect to /agency (billing/plan selection)
 * 
 * This ensures users cannot access Enhance without proper credits/subscription.
 */
export function RequireSubscription({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { usage, loading: usageLoading, error: usageError } = useUsage();
  const navigate = useNavigate();
  const location = useLocation();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Wait for both auth and usage bootstrap requests to settle.
    if (authLoading || usageLoading) {
      return;
    }

    // User must be authenticated and have agency (handled by previous guards).
    if (!user || !user.agencyId) {
      setChecking(false);
      return;
    }

    // Fail-open when usage cannot be loaded to avoid trapping login on a spinner.
    // Upload and billing APIs remain authoritative server-side gates.
    if (usageError || !usage) {
      console.warn("[RequireSubscription] Usage unavailable; skipping client-side subscription redirect", {
        hasUsage: !!usage,
        usageError,
      });
      setChecking(false);
      return;
    }

    // RULE 5: Check if user has access to Enhance
    const hasActiveSubscription = !!(usage.planName && usage.planName !== "Free" && usage.status === "active");
    const hasValidTrial = !!(usage.trial && usage.trial.status === "active" && (usage.trial.remaining ?? 0) > 0);
    const hasAddonCredits = (usage.addonRemaining ?? 0) > 0;
    const totalRemaining = Number.isFinite(usage.remaining as number)
      ? Number(usage.remaining)
      : Math.max(0, Number(usage.mainRemaining ?? 0)) + Math.max(0, Number(usage.addonRemaining ?? 0));
    const hasAnyCredits = totalRemaining > 0;

    // Allow access if any of these conditions are met
    const hasAccess = hasActiveSubscription || hasValidTrial || hasAddonCredits || hasAnyCredits;

    if (!hasAccess) {
      console.log("[RequireSubscription] No active subscription or credits, redirecting to billing");
      // Don't redirect if already on agency/billing page
      if (!location.pathname.startsWith("/agency")) {
        navigate("/agency", { replace: true });
      }
    }

    setChecking(false);
  }, [user, authLoading, usage, usageLoading, usageError, navigate, location.pathname]);

  // Show loading state while checking
  if (authLoading || usageLoading || checking) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">Verifying subscription status...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
