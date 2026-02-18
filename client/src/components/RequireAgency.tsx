import { useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { useNavigate, useLocation } from "react-router-dom";

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
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (loading || !user) return;

    // RULE 1: User has agency → allow access immediately.
    if (user.agencyId) return;

    // RULE 2: User has NO agency → redirect to agency creation
    // Don't redirect if already on agency/billing pages
    if (location.pathname !== "/agency" && location.pathname !== "/settings/billing") {
      console.log("[RequireAgency] No agency found, redirecting to agency creation");
      navigate("/agency", { replace: true });
    }
  }, [user, loading, navigate, location.pathname]);

  return <>{children}</>;
}
