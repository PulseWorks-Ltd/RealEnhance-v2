// client/src/components/header.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { ProfileDropdown } from "@/components/profile-dropdown";
import { withDevice } from "@/lib/withDevice";
import { apiFetch } from "@/lib/api";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { Menu, X } from "lucide-react";

// "route" entries navigate to a real page (client-side, via react-router);
// "anchor" entries jump to a section id on the landing page itself — when
// not already on "/", they're prefixed with "/#" so they still resolve
// (e.g. from /faq, "Pricing" correctly goes back to the homepage section).
const MARKETING_NAV_LINKS = [
  { type: "route", href: "/", label: "Home" },
  { type: "anchor", href: "features", label: "Features" },
  { type: "anchor", href: "pricing", label: "Pricing" },
  { type: "route", href: "/examples", label: "Examples" },
  { type: "route", href: "/faq", label: "FAQ" },
] as const;

const MARKETING_ROUTES = ["/", "/faq", "/examples"];

export function Header() {
  const { user: authUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthed = !!authUser;
  const isLandingRoute = location.pathname === "/";
  // The FAQ and Examples pages share the marketing header/nav treatment
  // with the homepage rather than the narrower app-page header — they're
  // part of the same public marketing site, not in-app pages.
  const isMarketingRoute = MARKETING_ROUTES.includes(location.pathname);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Show "Enhance Images" button when not on home page
  const showEnhanceButton = isAuthed && location.pathname !== "/home";

  const handleEnhanceClick = () => {
    navigate("/home");
  };

  // Marketing nav links + primary CTA are only shown on marketing pages for
  // a logged-out visitor — an authed user already has the app nav.
  const showLandingNav = isMarketingRoute && !isAuthed;

  return (
    <header
      className="sticky top-0 z-50 border-b bg-white/70 backdrop-blur supports-[backdrop-filter]:bg-white/60"
      data-testid="header-main"
    >
      <div className={isMarketingRoute
        ? "w-full flex items-center justify-between px-4 sm:px-6 lg:px-10 py-3"
        : "mx-auto max-w-7xl flex items-center justify-between px-4 py-3"}>
        {/* Brand */}
        <a href="/" className="flex items-center gap-2.5">
          <img src="/Logo-dark-v2.png" alt="RealEnhance" className="h-8 w-auto" />
        </a>

        {showLandingNav && (
          <nav className="hidden md:flex items-center gap-7" aria-label="Main">
            {MARKETING_NAV_LINKS.map((link) =>
              link.type === "route" ? (
                <Link
                  key={link.label}
                  to={link.href}
                  className="text-sm font-medium text-slate-600 hover:text-emerald-700 transition-colors"
                >
                  {link.label}
                </Link>
              ) : (
                <a
                  key={link.label}
                  href={isLandingRoute ? `#${link.href}` : `/#${link.href}`}
                  className="text-sm font-medium text-slate-600 hover:text-emerald-700 transition-colors"
                >
                  {link.label}
                </a>
              )
            )}
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
            {MARKETING_NAV_LINKS.map((link) =>
              link.type === "route" ? (
                <Link
                  key={link.label}
                  to={link.href}
                  onClick={() => setMobileNavOpen(false)}
                  className="text-sm font-medium text-slate-700 hover:text-emerald-700"
                >
                  {link.label}
                </Link>
              ) : (
                <a
                  key={link.label}
                  href={isLandingRoute ? `#${link.href}` : `/#${link.href}`}
                  onClick={() => setMobileNavOpen(false)}
                  className="text-sm font-medium text-slate-700 hover:text-emerald-700"
                >
                  {link.label}
                </a>
              )
            )}
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
