import React, { Suspense, lazy } from "react";
import { Routes, Route, Navigate, useLocation, Outlet } from "react-router-dom";
import { Header } from "@/components/Header";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/RequireAuth";
import { RequireAgency } from "@/components/RequireAgency";
import { RequireSubscription } from "@/components/RequireSubscription";
import { Toaster } from "@/components/ui/toaster";
import AuthComplete from "@/pages/auth-complete";

// Helper to create retry-enabled lazy imports
function lazyWithRetry(componentImport: () => Promise<any>) {
  return lazy(async () => {
    try {
      return await componentImport();
    } catch (error) {
      console.error('[LazyLoad] Failed to load component:', error);
      // If chunk loading fails, reload the page to get fresh chunks
      if (error instanceof Error && 
          (error.message.includes('Failed to fetch') || 
           error.message.includes('Importing a module script failed'))) {
        console.warn('[LazyLoad] Chunk loading failed - triggering page reload');
        sessionStorage.setItem('vite-chunk-reload', window.location.href);
        window.location.reload();
        // Return a dummy component that will never render (reload happens first)
        return { default: () => null };
      }
      throw error;
    }
  });
}

// Match the filenames exactly (case sensitive on Linux)
const Landing        = lazyWithRetry(() => import("@/pages/landing"));
const Login          = lazyWithRetry(() => import("@/pages/login"));
const Signup         = lazyWithRetry(() => import("@/pages/signup"));
const Home           = lazyWithRetry(() => import("@/pages/home"));
const Editor         = lazyWithRetry(() => import("@/pages/Editor"));
const Results        = lazyWithRetry(() => import("@/pages/Results"));
const RegionEditPage = lazyWithRetry(() => import("@/pages/RegionEditPage"));
const Agency         = lazyWithRetry(() => import("@/pages/agency"));
const AcceptInvite   = lazyWithRetry(() => import("@/pages/accept-invite"));
const EnhancedHistory = lazyWithRetry(() => import("@/pages/enhanced-history"));
const ForgotPassword = lazyWithRetry(() => import("@/pages/forgot-password"));
const ResetPassword = lazyWithRetry(() => import("@/pages/reset-password"));
const ChangePassword = lazyWithRetry(() => import("@/pages/change-password"));
const ProfileSettings = lazyWithRetry(() => import("@/pages/settings/profile"));
const SecuritySettings = lazyWithRetry(() => import("@/pages/settings/security"));
const BillingSettings = lazyWithRetry(() => import("@/pages/agency"));
const NotFound       = lazyWithRetry(() => import("@/pages/not-found"));
const StartTrial     = lazyWithRetry(() => import("@/pages/start-trial"));

function LegacyMyPhotosRedirect() {
  const location = useLocation();
  const search = location.search || "";
  const hash = location.hash || "";

  return <Navigate to={`/enhanced-history${search}${hash}`} replace />;
}

// Loading fallback component
function LoadingFallback() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center space-y-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto"></div>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <>
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          {/* Public Routes with Header */}
          <Route element={<><Header /><Outlet /></>}>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />
            <Route path="/auth/complete" element={<AuthComplete />} />
            <Route path="/start-trial" element={<StartTrial />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="*" element={<NotFound />} />
          </Route>

          {/* App Routes with Sidebar Shell */}
          {/* All routes require authentication via RequireAuth */}
          <Route element={<RequireAuth><Outlet /></RequireAuth>}>
            {/* Agency page: RequireAuth only (new users create agency here) */}
            <Route path="/agency" element={<AppShell><Agency /></AppShell>} />
            <Route path="/settings/billing" element={<AppShell><BillingSettings /></AppShell>} />
            
            {/* Protected routes: RequireAuth + RequireAgency */}
            <Route element={<RequireAgency><Outlet /></RequireAgency>}>
              {/* Enhance page: Additional RequireSubscription guard */}
              <Route path="/home" element={<RequireSubscription><AppShell><Home /></AppShell></RequireSubscription>} />
              
              {/* Other app routes: RequireAuth + RequireAgency */}
              <Route element={<AppShell><Outlet /></AppShell>}>
                <Route path="/change-password" element={<ChangePassword />} />
                <Route path="/settings/profile" element={<ProfileSettings />} />
                <Route path="/settings/security" element={<SecuritySettings />} />
                <Route path="/editor" element={<Editor />} />
                <Route path="/results" element={<Results />} />
                <Route path="/my-photos" element={<LegacyMyPhotosRedirect />} />
                <Route path="/region-edit" element={<RegionEditPage />} />
                <Route path="/enhanced-history" element={<EnhancedHistory />} />
                <Route path="/dashboard" element={<Navigate to="/home" replace />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </Suspense>
      {/* Keep Toaster inside App so upstream providers receive a single child */}
      <Toaster />
    </>
  );
}
