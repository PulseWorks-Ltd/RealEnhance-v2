// client/src/context/AuthContext.tsx
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import clientApi, { apiFetch } from "@/lib/api";

type AuthUser = {
  id: string;
  email?: string | null;
  deviceId?: string | null;
  credits: number;
  name?: string | null;
};

type AuthState = {
  user: AuthUser | null;
  loading: boolean;
  ensureSignedIn: (opts?: { reason?: string }) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<AuthUser | null>;
};

const AuthCtx = createContext<AuthState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const pendingActionRef = useRef<null | (() => void)>(null);

  const refreshUser = useCallback(async (): Promise<AuthUser | null> => {
    try {
      // ✅ correct path: /api/auth-user
      const data = await clientApi.request<AuthUser>("/api/auth-user");
      setUser(data);
      return data;
    } catch (e: any) {
      if (e.code === 401 || e?.message?.includes("401")) setUser(null);
      else console.error(e);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
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

  // Open Google OAuth in a popup; server should redirect back to the client
  // which calls window.opener.postMessage({ type: "auth:success" }, clientOrigin)
  const openPopupLogin = useCallback(() => {
    return new Promise<AuthUser>((resolve, reject) => {
      const width = 520, height = 640;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      const OAUTH_BASE =
        (import.meta as any).env?.VITE_API_BASE_URL || window.location.origin;

      const popup = window.open(
        `${OAUTH_BASE}/api/login`, // 🔁 use /api/auth/google if that's your route
        "google_oauth_popup",
        `width=${width},height=${height},left=${left},top=${top}`
      );
      if (!popup) return reject(new Error("Popup blocked"));

      const clientOrigin = window.location.origin;
      let finished = false;

      const onMessage = async (ev: MessageEvent) => {
        if (ev.origin !== clientOrigin) return;
        if (!ev.data || ev.data.type !== "auth:success") return;
        finished = true;
        window.removeEventListener("message", onMessage);
        try { popup.close(); } catch {}
        const u = await refreshUser();
        if (u) resolve(u);
        else reject(new Error("Failed to get user data after login"));
      };

      window.addEventListener("message", onMessage);

      setTimeout(() => {
        if (!finished) {
          window.removeEventListener("message", onMessage);
          try { popup.close(); } catch {}
          reject(new Error("Login timed out. Please try again."));
        }
      }, 60_000);
    });
  }, [refreshUser]);

  const ensureSignedIn = useCallback(async (_opts?: { reason?: string }) => {
    if (loading) await new Promise((r) => setTimeout(r, 200));
    if (user) return user;
    return openPopupLogin();
  }, [loading, user, openPopupLogin]);

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
