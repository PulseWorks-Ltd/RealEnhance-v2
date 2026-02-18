import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useNavigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";

/**
 * RequireAgency - Routing Guard
 * 
 * RULE 1: Preserve existing behavior
 * - If user has agencyId → allow access (existing users continue to Enhance)
 * 
 * RULE 2: New user without agency
 * - If user has NO agencyId → redirect to /agency (agency creation page)
 * 
 * This guard ensures new users must create an agency before accessing
 * protected features, while existing users are unaffected.
 */
export function RequireAgency({ children }: { children: React.ReactNode }) {
  const { user, loading, refreshUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const checkAgency = async () => {
      // Wait for auth to finish loading
      if (loading) {
        return;
      }

      // User must be authenticated (handled by RequireAuth)
      if (!user) {
        setChecking(false);
        return;
      }

      // Preserve existing behavior for established users:
      // if auth context already has agencyId, allow immediately.
      if (user.agencyId) {
        setChecking(false);
        return;
      }

      // Refresh user data to ensure we have latest agencyId
      const freshUser = await refreshUser();

      // RULE 1: User has agency → allow access
      if (freshUser?.agencyId) {
        setChecking(false);
        return;
      }

      // RULE 2: User has NO agency → redirect to agency creation
      // Don't redirect if already on agency page
      if (location.pathname !== "/agency" && location.pathname !== "/settings/billing") {
        console.log("[RequireAgency] No agency found, redirecting to agency creation");
        navigate("/agency", { replace: true });
      }
      
      setChecking(false);
    };

    checkAgency();
  }, [user, loading, navigate, location.pathname, refreshUser]);

  // Show loading state while checking
  if (loading || checking) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">Checking organization status...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
