// client/src/components/header.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { ProfileDropdown } from "@/components/profile-dropdown";
import { withDevice } from "@/lib/withDevice";
import { apiFetch } from "@/lib/api";
import { useNavigate, useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";

const LANDING_NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "#features", label: "Features" },
  { href: "#pricing", label: "Pricing" },
  { href: "#examples", label: "Examples" },
  { href: "#faq", label: "FAQ" },
] as const;

export function Header() {
  const { user: authUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthed = !!authUser;
  const isLandingRoute = location.pathname === "/";
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Show "Enhance Images" button when not on home page
  const showEnhanceButton = isAuthed && location.pathname !== "/home";

  const handleEnhanceClick = () => {
    navigate("/home");
  };

  // Landing-page nav links + primary CTA are only shown on "/" for a
  // logged-out visitor — the anchor links (#features etc.) only resolve on
  // the landing page itself, and an authed user already has the app nav.
  const showLandingNav = isLandingRoute && !isAuthed;

  return (
    <header
      className="sticky top-0 z-50 border-b bg-white/70 backdrop-blur supports-[backdrop-filter]:bg-white/60"
      data-testid="header-main"
    >
      <div className={isLandingRoute
        ? "w-full flex items-center justify-between px-4 sm:px-6 lg:px-10 py-3"
        : "mx-auto max-w-7xl flex items-center justify-between px-4 py-3"}>
        {/* Brand */}
        <a href="/" className="flex items-center gap-2.5">
          <img src="/Logo-dark-v2.png" alt="RealEnhance" className="h-8 w-auto" />
        </a>

        {showLandingNav && (
          <nav className="hidden md:flex items-center gap-7" aria-label="Main">
            {LANDING_NAV_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-sm font-medium text-slate-600 hover:text-emerald-700 transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
        )}

        {/* Right: actions */}
        <div className="flex items-center gap-3">
          {isAuthed ? (
            <>
              {showEnhanceButton && (
                <Button
                  onClick={handleEnhanceClick}
                  className="bg-brand-primary hover:bg-brand-accent"
                  data-testid="button-enhance-images"
                >
                  ✨ Enhance Images
                </Button>
              )}
              <ProfileDropdown />
            </>
          ) : (
            <>
              <Button
                asChild
                variant="outline"
                className="border-brand-primary text-brand-primary hover:bg-brand-light hidden sm:inline-flex"
                data-testid="button-signin-header"
              >
                <a href="/login">Sign In</a>
              </Button>
              {showLandingNav && (
                <Button
                  asChild
                  className="bg-emerald-600 hover:bg-emerald-700 text-white hidden sm:inline-flex"
                  data-testid="button-start-trial-header"
                >
                  <a href="/login">Start Free Trial</a>
                </Button>
              )}
              {showLandingNav && (
                <button
                  type="button"
                  onClick={() => setMobileNavOpen((v) => !v)}
                  className="md:hidden inline-flex items-center justify-center h-10 w-10 rounded-md text-slate-600 hover:bg-slate-100"
                  aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
                  aria-expanded={mobileNavOpen}
                  data-testid="button-mobile-nav-toggle"
                >
                  {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                </button>
              )}
              {!showLandingNav && (
                <Button
                  asChild
                  variant="outline"
                  className="border-brand-primary text-brand-primary hover:bg-brand-light sm:hidden"
                >
                  <a href="/login">Sign In</a>
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {showLandingNav && mobileNavOpen && (
        <div className="md:hidden border-t bg-white px-4 py-4 space-y-3" data-testid="mobile-nav-panel">
          <nav className="flex flex-col gap-3" aria-label="Main (mobile)">
            {LANDING_NAV_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={() => setMobileNavOpen(false)}
                className="text-sm font-medium text-slate-700 hover:text-emerald-700"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="flex flex-col gap-2 pt-2 border-t">
            <Button asChild variant="outline" className="border-brand-primary text-brand-primary w-full">
              <a href="/login">Sign In</a>
            </Button>
            <Button asChild className="bg-emerald-600 hover:bg-emerald-700 text-white w-full">
              <a href="/login">Start Free Trial</a>
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
