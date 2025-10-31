// client/src/App.tsx
import React, { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Header } from "./components/Header"; // or "@/components/Header" if file is Header.tsx

// lazy imports must match file names exactly
const Landing        = lazy(() => import("@/pages/landing"));         // landing.tsx
const Home           = lazy(() => import("@/pages/home"));            // home.tsx
const Editor         = lazy(() => import("@/pages/Editor"));          // Editor.tsx
const Results        = lazy(() => import("@/pages/Results"));         // Results.tsx
const MyPhotos       = lazy(() => import("@/pages/MyPhotos"));        // MyPhotos.tsx
const RegionEditPage = lazy(() => import("@/pages/RegionEditPage"));  // RegionEditPage.tsx
const NotFound       = lazy(() => import("@/pages/not-found"));       // not-found.tsx

export default function App() {
  return (
    <>
      <Header />
      <Suspense fallback={<div className="p-6">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/home" element={<Home />} />

          {/* Core app flows */}
          <Route path="/editor" element={<Editor />} />
          <Route path="/results" element={<Results />} />
          <Route path="/my-photos" element={<MyPhotos />} />
          <Route path="/region-edit" element={<RegionEditPage />} />

          {/* Aliases */}
          <Route path="/dashboard" element={<Navigate to="/home" replace />} />

          {/* 404 */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </>
  );
}

