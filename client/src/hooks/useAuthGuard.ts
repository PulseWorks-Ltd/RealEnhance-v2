import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";

export function useAuthGuard() {
  const { user, loading, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!loading) {
      setIsReady(true);
    }
  }, [loading]);

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

      await refreshUser();

      if (!Number.isFinite(needCredits) || needCredits <= 0) {
        return user;
      }

      const resp = await fetch(api("/api/billing/subscription"), {
        credentials: "include",
      });

      if (resp.status === 401 || resp.status === 403) {
        redirectToLogin();
        throw new Error("Please sign in to continue");
      }

      if (!resp.ok) {
        throw new Error("Unable to verify available credits. Please try again.");
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

      return user;
    },
    [user, refreshUser, redirectToLogin]
  );

  return {
    user,
    isReady,
    isAuthed: !!user,
    redirectToLogin,
    ensureLoggedInAndCredits
  };
}