// client/src/components/header.tsx
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { ProfileDropdown } from "@/components/profile-dropdown";
import { withDevice } from "@/lib/withDevice";
import { apiFetch } from "@/lib/api";


type MeUnified = { credits: number; isAuthenticated: boolean };

function normalizeMe(resp: unknown): MeUnified {
  const r = resp as any;
  if (typeof r?.credits === "number") {
    return { credits: r.credits, isAuthenticated: !!r.isAuthenticated };
  }
  if (r?.user) {
    return { credits: Number(r.user.credits ?? 0), isAuthenticated: !!r.isAuthenticated };
  }
  return { credits: 0, isAuthenticated: false };
}

export function Header() {
  const { ensureSignedIn, user: authUser, loading: authLoading } = useAuth();

  const { data, isLoading } = useQuery<MeUnified>({
    queryKey: ["/api/me"],
    queryFn: async () => {
      const res = await apiFetch("/api/me", { ...withDevice() });
      if (!res.ok) return { credits: 0, isAuthenticated: false };
      const json = await res.json();
      return normalizeMe(json);
    },
    staleTime: 30_000,
    retry: 1,
  });

  const credits = data?.credits ?? 0;
  const isAuthed = !!(data?.isAuthenticated || authUser);
  const loading = authLoading || isLoading;

  const handleBuyCredits = () => {
    document.getElementById("credits-section")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <header
      className="sticky top-0 z-50 border-b bg-white/70 backdrop-blur supports-[backdrop-filter]:bg-white/60"
      data-testid="header-main"
    >
      <div className="mx-auto max-w-7xl flex items-center justify-between px-4 py-3">
        {/* Brand */}
        <a href="/" className="flex items-center gap-3">
          <img src="/RealEnhance-Logo.jpg" alt="RealEnhance" className="h-8 w-auto rounded" />
          <div className="leading-tight">
            <h1
              className="text-xl font-bold bg-clip-text text-transparent
                         bg-gradient-to-r from-brand-primary to-brand-accent"
              data-testid="app-title"
            >
              RealEnhance
            </h1>
            <p className="text-[11px] text-neutral-500">AI-Powered Enhancement</p>
          </div>
        </a>

        {/* Right: credits + actions */}
        <div className="flex items-center gap-4">
          <div
            className="flex items-center gap-2 rounded-lg border px-3 py-2 bg-white/60"
            data-testid="credits-display"
          >
            <svg className="h-4 w-4 text-yellow-500" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
            <span className="font-medium tabular-nums min-w-6 text-center" data-testid="credits-count">
              {loading ? "…" : credits}
            </span>
            <span className="text-sm text-neutral-500">credits</span>
          </div>

          <Button
            type="button"
            onClick={handleBuyCredits}
            className="bg-brand-accent text-white hover:opacity-90 shadow-sm"
            data-testid="button-buy-credits"
          >
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
            Buy Credits
          </Button>

          {isAuthed ? (
            <ProfileDropdown />
          ) : (
            <Button
              onClick={() => ensureSignedIn()}
              variant="outline"
              className="border-brand-primary text-brand-primary hover:bg-brand-light"
              data-testid="button-signin-header"
          >
            Sign In
          </Button>
          )}
        </div>
      </div>
    </header>
  );
}
