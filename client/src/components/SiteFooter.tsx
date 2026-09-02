import { Link } from "react-router-dom";

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="w-full px-4 sm:px-6 lg:px-10 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <p className="text-sm text-slate-600">
            <span className="font-semibold text-slate-800">RealEnhance</span>
            {" "}· AI photo enhancement for New Zealand real estate
          </p>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm" aria-label="Footer links">
            <Link to="/privacy" className="font-medium text-slate-600 transition-colors hover:text-emerald-700">
              Privacy
            </Link>
            <Link to="/terms" className="font-medium text-slate-600 transition-colors hover:text-emerald-700">
              Terms
            </Link>
            <a href="mailto:support@realenhance.co.nz" className="font-medium text-slate-600 transition-colors hover:text-emerald-700">
              Contact
            </a>
            <Link to="/faq" className="font-medium text-slate-600 transition-colors hover:text-emerald-700">
              FAQ
            </Link>
          </nav>
        </div>
        <p className="mt-6 text-xs text-slate-400">
          © {new Date().getFullYear()} RealEnhance. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
