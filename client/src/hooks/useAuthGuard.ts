import { useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";

export function useAuthGuard() {
  const { ensureSignedIn, refreshUser, user } = useAuth();

  const ensureLoggedInAndCredits = useCallback(
    async (needCredits: number) => {
      const u = await ensureSignedIn();
      // Always re-fetch credits just before charging
      const latest = await api<{ user: typeof u }>("/api/me");
      if ((latest.user?.credits ?? 0) < needCredits) {
        const short = needCredits - (latest.user?.credits ?? 0);
        const message = short > 1
          ? `You need ${short} more credits for this operation.`
          : `You need ${short} more credit for this operation.`;
        throw Object.assign(new Error(message), { code: "INSUFFICIENT_CREDITS", needed: short });
      }
      await refreshUser(); // keep header in sync
      return latest.user;
    },
    [ensureSignedIn, refreshUser]
  );

  return { user, ensureLoggedInAndCredits };
}