// client/src/components/header.tsx
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { ProfileDropdown } from "@/components/profile-dropdown";
import { withDevice } from "@/lib/withDevice";
import { apiFetch } from "@/lib/api";
import { useNavigate, useLocation } from "react-router-dom";


export function Header() {
  const { user: authUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthed = !!authUser;

  // Show "Enhance Images" button when not on home page
  const showEnhanceButton = isAuthed && location.pathname !== "/home";

  const handleEnhanceClick = () => {
    navigate("/home");
  };

  return (
    <header
      className="sticky top-0 z-50 border-b bg-white/70 backdrop-blur supports-[backdrop-filter]:bg-white/60"
      data-testid="header-main"
    >
      <div className="mx-auto max-w-7xl flex items-center justify-between px-4 py-3">
        {/* Brand */}
        <a href="/" className="flex items-center gap-3">
          <img src="/logo.svg" alt="RealEnhance" className="h-8 w-auto rounded object-contain drop-shadow-sm" />
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

        {/* Right: actions */}
        <div className="flex items-center gap-4">
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
            <Button
              asChild
              variant="outline"
              className="border-brand-primary text-brand-primary hover:bg-brand-light"
              data-testid="button-signin-header"
          >
            <a href="/login">Sign In</a>
          </Button>
          )}
        </div>
      </div>
    </header>
  );
}
