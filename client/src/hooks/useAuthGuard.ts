import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";

export function useAuthGuard() {
  const { user, loading, initialising, refreshUser, authError } = useAuth();
  const navigate = useNavigate();
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    console.log("AUTH_GUARD", {
      user,
      isSiteAdmin: user?.isSiteAdmin,
      loading,
      initialising,
    });
  }, [user, loading, initialising]);

  useEffect(() => {
    if (!loading && !initialising) {
      setIsReady(true);
    } else {
      setIsReady(false);
    }
  }, [loading, initialising]);

  const redirectToLogin = useCallback(() => {
    const currentPath = window.location.pathname;
    const redirectParam = currentPath !== "/" && currentPath !== "/login"
      ? `?redirect=${encodeURIComponent(currentPath)}`
      : "";
    navigate(`/login${redirectParam}`);
  }, [navigate]);

  const ensureLoggedInAndCredits = useCallback(
    async (needCredits: number) => {
      if (!user) {
        redirectToLogin();
        throw new Error("Please sign in to continue");
      }

      const refreshedUser = await refreshUser();
      if (!refreshedUser && !user) {
        redirectToLogin();
        throw new Error("Please sign in to continue");
      }

      if (!Number.isFinite(needCredits) || needCredits <= 0) {
        return refreshedUser || user;
      }

      let resp: Response;
      try {
        resp = await fetch(api("/api/billing/subscription"), {
          credentials: "include",
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        // Soft-fail billing preflight on transient/network issues.
        // /api/upload remains the authoritative server-side credit gate.
        console.warn("[auth-guard] billing preflight unavailable; deferring credit validation to server", error);
        return refreshedUser || user;
      }

      if (resp.status === 401) {
        redirectToLogin();
        throw new Error("Please sign in to continue");
      }

      if (resp.status === 403) {
        // Billing restrictions should not be treated as authentication failure.
        // Server upload gate remains authoritative and will return actionable billing codes.
        console.warn("[auth-guard] billing preflight returned 403; deferring to server upload gate", {
          needCredits,
        });
        return refreshedUser || user;
      }

      if (!resp.ok) {
        // Fail open for non-auth responses; server enforces credits authoritatively.
        console.warn("[auth-guard] billing preflight non-ok; deferring credit validation to server", {
          status: resp.status,
          needCredits,
        });
        return refreshedUser || user;
      }

      const summary = await resp.json().catch(() => ({} as any));
      const monthlyRemaining = Math.max(0, Number(summary?.allowance?.monthlyRemaining ?? 0));
      const addonRemaining = Math.max(0, Number(summary?.addOns?.remaining ?? 0));
      const availableCredits = monthlyRemaining + addonRemaining;

      if (needCredits > availableCredits) {
        const err: any = new Error("Not enough credits");
        err.code = "INSUFFICIENT_CREDITS";
        err.requiredCredits = needCredits;
        err.availableCredits = availableCredits;
        err.monthlyRemaining = monthlyRemaining;
        err.addonRemaining = addonRemaining;
        err.needed = Math.max(0, needCredits - availableCredits);
        throw err;
      }

      return refreshedUser || user;
    },
    [user, refreshUser, redirectToLogin]
  );

  return {
    user,
    isReady,
    isAuthed: !!user,
    initialising,
    authError,
    redirectToLogin,
    ensureLoggedInAndCredits
  };
}