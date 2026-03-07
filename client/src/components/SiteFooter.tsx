import { Link } from "react-router-dom";

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-3 px-4 py-4 text-sm text-slate-600 sm:flex-row">
        <p>© {new Date().getFullYear()} RealEnhance. All rights reserved.</p>
        <nav className="flex items-center gap-4" aria-label="Legal links">
          <Link to="/terms" className="font-medium text-slate-700 transition-colors hover:text-emerald-700">
            Terms of Service
          </Link>
          <Link to="/privacy" className="font-medium text-slate-700 transition-colors hover:text-emerald-700">
            Privacy Policy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
