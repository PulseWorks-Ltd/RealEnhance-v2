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
  signInWithEmail: (email: string, password: string) => Promise<AuthUser>;
  signUpWithEmail: (email: string, password: string, name: string) => Promise<AuthUser>;
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

  // Lazy auth: do not auto-load session on first paint.
  // We fetch the user only when the app needs it (e.g., ensureSignedIn or an explicit refresh)
  // This keeps first-time visitors looking anonymous until they interact.
  useEffect(() => {
    // no-op: intentionally not auto-refreshing user on mount
  }, []);

  const signOut = useCallback(async () => {
    try {
  // Server exposes /auth/logout
  await apiFetch("/auth/logout", { method: "POST" });
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
        `${OAUTH_BASE}/auth/google`,
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

      // Fallback A: detect when popup reaches same-origin (client) and then finish
      const pollSameOrigin = window.setInterval(async () => {
        if (finished) { window.clearInterval(poll); return; }
        try {
          // Will throw while cross-origin; succeeds once popup is on our origin
          if (popup.closed) { window.clearInterval(poll); return; }
          const sameOrigin = popup.location.origin === clientOrigin;
          if (sameOrigin) {
            finished = true;
            window.clearInterval(pollSameOrigin);
            try { popup.close(); } catch {}
            const u = await refreshUser();
            if (u) resolve(u);
            else reject(new Error("Failed to get user after login (poll)"));
          }
        } catch {}
      }, 300);

      // Fallback B: independent session polling (works even if popup closes before
      // we detect same-origin or message)
      let pollCount = 0;
      const pollMax = 30; // ~30s
      const pollSession = window.setInterval(async () => {
        if (finished) { window.clearInterval(pollSession); return; }
        try {
          const u = await refreshUser();
          if (u) {
            finished = true;
            window.clearInterval(pollSession);
            try { window.clearInterval(pollSameOrigin); } catch {}
            try { popup.close(); } catch {}
            resolve(u);
          }
        } catch {
          // ignore
        } finally {
          pollCount++;
          if (pollCount >= pollMax && !finished) {
            window.clearInterval(pollSession);
          }
        }
      }, 1000);

      setTimeout(() => {
        if (!finished) {
          window.removeEventListener("message", onMessage);
          try { window.clearInterval(pollSameOrigin); } catch {}
          try { window.clearInterval(pollSession); } catch {}
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

  const signInWithEmail = useCallback(async (email: string, password: string): Promise<AuthUser> => {
    try {
      const response = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Login failed" }));
        throw new Error(errorData.error || "Login failed");
      }

      const userData = await response.json();
      setUser(userData);
      return userData;
    } catch (error: any) {
      throw new Error(error.message || "Login failed");
    }
  }, []);

  const signUpWithEmail = useCallback(async (email: string, password: string, name: string): Promise<AuthUser> => {
    try {
      const response = await apiFetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Signup failed" }));
        throw new Error(errorData.error || "Signup failed");
      }

      const userData = await response.json();
      setUser(userData);
      return userData;
    } catch (error: any) {
      throw new Error(error.message || "Signup failed");
    }
  }, []);

  const value: AuthState = {
    user,
    loading,
    ensureSignedIn,
    signOut,
    refreshUser,
    signInWithEmail,
    signUpWithEmail,
  };

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
};

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
