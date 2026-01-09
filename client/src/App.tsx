import React, { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Header } from "@/components/Header";
import { Toaster } from "@/components/ui/toaster";
import AuthComplete from "@/pages/auth-complete";

// Match the filenames exactly (case sensitive on Linux)
const Landing        = lazy(() => import("@/pages/landing"));
const Login          = lazy(() => import("@/pages/login"));
const Signup         = lazy(() => import("@/pages/signup"));
const Home           = lazy(() => import("@/pages/home"));
const Editor         = lazy(() => import("@/pages/Editor"));
const Results        = lazy(() => import("@/pages/Results"));
const MyPhotos       = lazy(() => import("@/pages/MyPhotos"));
const RegionEditPage = lazy(() => import("@/pages/RegionEditPage"));
const Agency         = lazy(() => import("@/pages/agency"));
const AcceptInvite   = lazy(() => import("@/pages/accept-invite"));
const NotFound       = lazy(() => import("@/pages/not-found"));

export default function App() {
  return (
    <>
      <Header />
      <Suspense fallback={<div className="p-6">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/home" element={<Home />} />
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="/auth/complete" element={<AuthComplete />} />
          <Route path="/editor" element={<Editor />} />
          <Route path="/results" element={<Results />} />
          <Route path="/my-photos" element={<MyPhotos />} />
          <Route path="/region-edit" element={<RegionEditPage />} />
          <Route path="/agency" element={<Agency />} />
          <Route path="/dashboard" element={<Navigate to="/home" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      {/* Keep Toaster inside App so upstream providers receive a single child */}
      <Toaster />
    </>
  );
}
