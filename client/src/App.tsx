import React, { Suspense, lazy } from "react";
import { Routes, Route, Navigate, useLocation, Outlet } from "react-router-dom";
import { Header } from "@/components/Header";
import { AppShell } from "@/components/layout/AppShell";
import { Toaster } from "@/components/ui/toaster";
import AuthComplete from "@/pages/auth-complete";

// Match the filenames exactly (case sensitive on Linux)
const Landing        = lazy(() => import("@/pages/landing"));
const Login          = lazy(() => import("@/pages/login"));
const Signup         = lazy(() => import("@/pages/signup"));
const Home           = lazy(() => import("@/pages/home"));
const Editor         = lazy(() => import("@/pages/Editor"));
const Results        = lazy(() => import("@/pages/Results"));
const RegionEditPage = lazy(() => import("@/pages/RegionEditPage"));
const Agency         = lazy(() => import("@/pages/agency"));
const AcceptInvite   = lazy(() => import("@/pages/accept-invite"));
const EnhancedHistory = lazy(() => import("@/pages/enhanced-history"));
const ForgotPassword = lazy(() => import("@/pages/forgot-password"));
const ResetPassword = lazy(() => import("@/pages/reset-password"));
const ChangePassword = lazy(() => import("@/pages/change-password"));
const ProfileSettings = lazy(() => import("@/pages/settings/profile"));
const SecuritySettings = lazy(() => import("@/pages/settings/security"));
const NotFound       = lazy(() => import("@/pages/not-found"));
const StartTrial     = lazy(() => import("@/pages/start-trial"));

function LegacyMyPhotosRedirect() {
  const location = useLocation();
  const search = location.search || "";
  const hash = location.hash || "";

  return <Navigate to={`/enhanced-history${search}${hash}`} replace />;
}

export default function App() {
  return (
    <>
      <Suspense fallback={<div className="p-6">Loading…</div>}>
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
          <Route element={<AppShell><Outlet /></AppShell>}>
            <Route path="/home" element={<Home />} />
            <Route path="/change-password" element={<ChangePassword />} />
            <Route path="/settings/profile" element={<ProfileSettings />} />
            <Route path="/settings/security" element={<SecuritySettings />} />
            <Route path="/editor" element={<Editor />} />
            <Route path="/results" element={<Results />} />
            <Route path="/my-photos" element={<LegacyMyPhotosRedirect />} />
            <Route path="/region-edit" element={<RegionEditPage />} />
            <Route path="/agency" element={<Agency />} />
            <Route path="/enhanced-history" element={<EnhancedHistory />} />
            <Route path="/dashboard" element={<Navigate to="/home" replace />} />
          </Route>
        </Routes>
      </Suspense>
      {/* Keep Toaster inside App so upstream providers receive a single child */}
      <Toaster />
    </>
  );
}
