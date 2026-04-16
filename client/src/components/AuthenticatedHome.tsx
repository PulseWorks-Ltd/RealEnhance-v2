import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Loader2 } from "lucide-react";

/**
 * AuthenticatedHome - Smart redirect for authenticated users
 * 
 * RULE 1: Preserve existing behavior
 * - Redirect authenticated users to /home
 * - Guards will handle agency/subscription checks
 * 
 * This component ensures that when authenticated users land on
 * the landing page or root, they're automatically redirected to
 * the app, maintaining existing user flow.
 */
export function AuthenticatedHome() {
  const { user, loading, initialising } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !initialising && user) {
      // RULE 1: Existing users with agency go to /home
      // Guards will redirect new users to /agency if needed
      navigate("/home", { replace: true });
    }
  }, [user, loading, initialising, navigate]);

  if (loading || initialising) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return null;
}
