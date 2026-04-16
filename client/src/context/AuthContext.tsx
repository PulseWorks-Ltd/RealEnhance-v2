// client/src/context/AuthContext.tsx
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { apiFetchSoft } from "@/lib/api";
import { requestClearEnhancementState } from "@/lib/enhancement-state";

type AuthUser = {
  id: string;
  email?: string | null;
  emailVerified?: boolean;
  hasSeenWelcome?: boolean;
  deviceId?: string | null;
  credits: number;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  agencyId?: string | null;
  role?: "owner" | "admin" | "member";
  authProvider?: "email" | "google" | "both";
  isSiteAdmin?: boolean;
};

type AuthState = {
  user: AuthUser | null;
  loading: boolean;
  initialising: boolean;
  authError: string | null;
  ensureSignedIn: (opts?: { reason?: string }) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<AuthUser | null>;
  signInWithEmail: (email: string, password: string) => Promise<AuthUser>;
  signUpWithEmail: (agencyName: string, fullName: string, email: string, password: string, confirmPassword: string) => Promise<AuthUser>;
  requestPasswordReset: (email: string) => Promise<void>;
  confirmPasswordReset: (token: string, newPassword: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  setPassword: (newPassword: string) => Promise<void>;
  markWelcomeSeen: () => Promise<void>;
  updateProfile: (payload: { firstName: string; lastName: string }) => Promise<AuthUser>;
};

const AuthCtx = createContext<AuthState | null>(null);

function isAuthUser(value: unknown): value is AuthUser {
  return !!value && typeof value === "object" && typeof (value as AuthUser).id === "string";
}

type AuthProbeResult =
  | { type: "user"; user: AuthUser }
  | { type: "unauthenticated" }
  | { type: "unresolved" };

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialising, setInitialising] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const pendingActionRef = useRef<null | (() => void)>(null);
  const refreshInFlightRef = useRef(0);
  // Ref tracks latest user so signOut callback never reads stale closure
  const userRef = useRef<AuthUser | null>(null);
  useEffect(() => { userRef.current = user; }, [user]);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const probeUserInternal = useCallback(async (): Promise<AuthProbeResult> => {
    try {
      const res = await apiFetch("/api/auth-user", {
        cache: "no-store",
      });

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return { type: "unresolved" };
      }

      let data: unknown = null;
      try {
        data = await res.json();
      } catch (error) {
        if (error instanceof SyntaxError) {
          return { type: "unresolved" };
        }
        throw error;
      }

      if (!isAuthUser(data)) {
        return { type: "unresolved" };
      }

      return { type: "user", user: data };
    } catch (e: any) {
      const status = Number(e?.status ?? e?.code ?? 0);
      const unauthorized = status === 401 || String(e?.message || "").includes("401");
      const notModified = status === 304;

      if (unauthorized) {
        return { type: "unauthenticated" };
      }

      if (notModified) {
        return { type: "unresolved" };
      }

      throw e;
    }
  }, []);

  const refreshUserInternal = useCallback(async ({ commit = true }: { commit?: boolean } = {}): Promise<AuthUser | null> => {
    refreshInFlightRef.current += 1;
    setLoading(true);
    setAuthError(null);

    try {
      const result = await probeUserInternal();

      if (result.type === "user") {
        console.log("[AUTH_REFRESH_AFTER_LOGIN]", result.user);
        setAuthError(null);
        if (commit) {
          setUser(result.user);
        }
        return result.user;
      }

      if (result.type === "unauthenticated") {
        setAuthError(null);
        if (commit) {
          setUser(null);
        }
        return null;
      }

      setAuthError(null);
      return null;
    } catch (e: any) {
      console.error(e);
      setAuthError("Failed to load session");
      throw e;
    } finally {
      refreshInFlightRef.current = Math.max(0, refreshInFlightRef.current - 1);
      setLoading(refreshInFlightRef.current > 0);
    }
  }, []);

  const refreshUser = useCallback(async (): Promise<AuthUser | null> => {
    return refreshUserInternal();
  }, [refreshUserInternal]);

  // Auto-check session on mount to maintain logged-in state across page loads
  // This ensures users stay logged in when returning from external redirects (e.g., Stripe)
  useEffect(() => {
    let mounted = true;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const bootstrapAuth = async () => {
      let nextUser: AuthUser | null = null;
      let sawDefinitiveUnauthed = false;

      try {
        const firstResult = await probeUserInternal();
        if (firstResult.type === "user") {
          nextUser = firstResult.user;
        } else if (firstResult.type === "unauthenticated") {
          sawDefinitiveUnauthed = true;
        }
      } catch (error) {
        if (mounted) {
          console.error("Initial auth refresh failed", error);
        }
      }

      if (!nextUser && !sawDefinitiveUnauthed && mounted) {
        await sleep(200);
        if (!mounted) return;

        try {
          const secondResult = await probeUserInternal();
          if (secondResult.type === "user") {
            nextUser = secondResult.user;
          } else if (secondResult.type === "unauthenticated") {
            sawDefinitiveUnauthed = true;
          }
        } catch (retryError) {
          if (mounted) {
            console.error("Initial auth retry failed", retryError);
          }
        }
      }

      if (!mounted) return;

      if (!nextUser && !sawDefinitiveUnauthed) {
        fallbackTimer = setTimeout(() => {
          if (!mounted) return;

          refreshUser()
            .catch((error) => {
              if (mounted) {
                console.error("Deferred auth refresh failed", error);
              }
            })
            .finally(() => {
              if (!mounted) return;

              setInitialising(false);
              console.log("[AUTH_BOOTSTRAP_DONE]", {
                user: userRef.current,
                hasUser: !!userRef.current,
              });
            });
        }, 1000);
        return;
      }

      setUser(nextUser);
      setInitialising(false);
      console.log("[AUTH_BOOTSTRAP_DONE]", {
        user: nextUser,
        hasUser: !!nextUser,
      });
    };

    bootstrapAuth();

    return () => {
      mounted = false;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }
    };
  }, [refreshUser, refreshUserInternal]);

  const signOut = useCallback(async () => {
    try {
      // Support both proxy shapes: /api/auth/logout and /auth/logout
      const primary = await apiFetchSoft("/api/auth/logout", { method: "POST" }, 12_000);
      if (!primary.ok && primary.status !== 404) {
        await apiFetchSoft("/auth/logout", { method: "POST" }, 12_000);
      }
      if (primary.status === 404) {
        await apiFetchSoft("/auth/logout", { method: "POST" }, 12_000);
      }
    } catch (e) {
      console.warn("logout:", e);
    } finally {
      // Clear any persisted or in-memory enhancement state so new sessions start clean
      try { requestClearEnhancementState(userRef.current?.id || null); } catch {}
      setUser(null);
      // Redirect to public landing after logout
      const landing = (import.meta as any)?.env?.VITE_PUBLIC_LANDING_URL || "https://www.realenhance.co.nz/";
      try {
        window.location.href = landing;
      } catch {
        window.location.assign(landing);
      }
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
        if (finished) { window.clearInterval(pollSameOrigin); return; }
        try {
          // Will throw while cross-origin; succeeds once popup is on our origin
          if (popup.closed) { window.clearInterval(pollSameOrigin); return; }
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
    if (loading || initialising) await new Promise((r) => setTimeout(r, 200));
    if (user) return user;
    return openPopupLogin();
  }, [loading, initialising, user, openPopupLogin]);

  const signInWithEmail = useCallback(async (email: string, password: string): Promise<AuthUser> => {
    try {
      // Authenticate — apiFetch throws ApiError on non-2xx
      await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      // Always hydrate from /api/auth-user so isSiteAdmin (and any other
      // server-computed flags) are present before the caller navigates.
      const refreshed = await refreshUser();
      if (!refreshed) throw new Error("Login succeeded but failed to load user data");
      return refreshed;
    } catch (error: any) {
      throw new Error(error.message || "Login failed");
    }
  }, [refreshUser]);

  const signUpWithEmail = useCallback(async (agencyName: string, fullName: string, email: string, password: string, confirmPassword: string): Promise<AuthUser> => {
    try {
      // Create account — apiFetch throws ApiError on non-2xx (returns 201 on success)
      await apiFetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agencyName, fullName, email, password, confirmPassword }),
      });
      // Hydrate full user state (including isSiteAdmin) from /api/auth-user
      const refreshed = await refreshUser();
      if (!refreshed) throw new Error("Signup succeeded but failed to load user data");
      return refreshed;
    } catch (error: any) {
      throw new Error(error.message || "Signup failed");
    }
  }, [refreshUser]);

  const value: AuthState = {
    user,
    loading,
    initialising,
    authError,
    ensureSignedIn,
    signOut,
    refreshUser,
    signInWithEmail,
    signUpWithEmail,
    requestPasswordReset: async (email: string) => {
      await apiFetch("/api/auth/request-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    },
    confirmPasswordReset: async (token: string, newPassword: string) => {
      await apiFetch("/api/auth/confirm-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
    },
    changePassword: async (currentPassword: string, newPassword: string) => {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      await refreshUser();
    },
    setPassword: async (newPassword: string) => {
      const response = await apiFetch("/api/auth/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Failed to set password");
      }
      await refreshUser();
    },
    markWelcomeSeen: async () => {
      await apiFetch("/api/auth/welcome-seen", {
        method: "POST",
      });
      await refreshUser();
    },
    updateProfile: async (payload: { firstName: string; lastName: string }) => {
      const res = await apiFetch("/api/profile/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update profile");
      }
      const data = await res.json();
      const nextUser = data.user || data;
      setUser((prev) => (prev ? { ...prev, ...nextUser } : nextUser));
      return nextUser;
    },
  };

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
};

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
