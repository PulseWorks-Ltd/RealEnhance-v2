import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useNavigate } from "react-router-dom";

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

  // DEPRECATED: Credits are no longer enforced
  const ensureLoggedInAndCredits = useCallback(
    async (needCredits: number) => {
      if (!user) {
        redirectToLogin();
        throw new Error("Please sign in to continue");
      }
      // Credits no longer checked - always allow
      await refreshUser();
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