import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import clientApi, { apiFetch } from "@/lib/api";

type User = {
  id: string;
  email?: string | null;
  deviceId?: string | null;
  credits: number;
  name?: string | null;
};

type AuthState = {
  user: User | null;
  loading: boolean;
  ensureSignedIn: (opts?: { reason?: string }) => Promise<User>;
  signOut: () => Promise<void>;
  // credits helper
  refreshUser: () => Promise<User | null>;
};

const AuthCtx = createContext<AuthState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const pendingActionRef = useRef<null | (() => void)>(null);

  const refreshUser = useCallback(async () => {
    try {
      // Your server already has /api/auth/user -> returns { user: { ... } } or 401
      const data = await clientApi.request<{ user: User }>("/api/auth/user");
      setUser(data.user);
      return data.user;
    } catch (e: any) {
      if (e.code === 401) setUser(null);
      else console.error(e);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
    // periodic refresh (keeps header credits current)
    const id = setInterval(refreshUser, 60_000);
    return () => clearInterval(id);
  }, [refreshUser]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/api/logout", { method: "POST" });
    } catch (e) {
      console.warn("logout:", e);
    } finally {
      setUser(null);
    }
  }, []);

  // Google OAuth popup login with postMessage
  const openPopupLogin = useCallback(() => {
    return new Promise<User>((resolve, reject) => {
      const width = 520, height = 640;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const w = window.open(
        "/api/auth/google",
        "google_oauth_popup",
        `width=${width},height=${height},left=${left},top=${top}`
      );
      if (!w) return reject(new Error("Popup blocked"));

      const origin = window.location.origin;

      let finished = false;
      const onMessage = async (ev: MessageEvent) => {
        if (ev.origin !== origin) return;              // strict origin check
        if (!ev.data || ev.data.type !== "auth:success") return;
        finished = true;
        window.removeEventListener("message", onMessage);
        try { w.close(); } catch {}
        const userData = await refreshUser();
        if (userData) {
          resolve(userData);
        } else {
          reject(new Error("Failed to get user data after login"));
        }
      };

      window.addEventListener("message", onMessage);

      // safety timeout
      setTimeout(() => {
        if (!finished) {
          window.removeEventListener("message", onMessage);
          try { w.close(); } catch {}
          reject(new Error("Login timed out. Please try again."));
        }
      }, 60_000);
    });
  }, [refreshUser]);

  const ensureSignedIn = useCallback(
    async (_opts?: { reason?: string }) => {
      if (loading) {
        // wait for initial probe
        await new Promise((r) => setTimeout(r, 200));
      }
      if (user) return user;

      // If not signed in, open popup
      const u = await openPopupLogin();
      return u;
    },
    [loading, user, openPopupLogin]
  );

  // re-run pending action after login succeeds
  const runAfterLogin = useCallback(
    async (fn: () => void) => {
      pendingActionRef.current = fn;
      try {
        await ensureSignedIn();
        pendingActionRef.current?.();
      } finally {
        pendingActionRef.current = null;
      }
    },
    [ensureSignedIn]
  );

  const value: AuthState = {
    user,
    loading,
    ensureSignedIn,
    signOut,
    refreshUser,
  };

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
};

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}