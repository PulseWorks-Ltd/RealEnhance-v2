import React, { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Header } from "@/components/Header"; // ← named import, lowercase file

const Landing        = lazy(() => import("@/pages/landing"));
const Home           = lazy(() => import("@/pages/home"));
const Editor         = lazy(() => import("@/pages/Editor"));
const Results        = lazy(() => import("@/pages/Results"));
const MyPhotos       = lazy(() => import("@/pages/MyPhotos"));
const RegionEditPage = lazy(() => import("@/pages/RegionEditPage"));
const NotFound       = lazy(() => import("@/pages/not-found"));

export default function App() {
  return (
    <>
      <Header />
      <Suspense fallback={<div className="p-6">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/home" element={<Home />} />
          <Route path="/editor" element={<Editor />} />
          <Route path="/results" element={<Results />} />
          <Route path="/my-photos" element={<MyPhotos />} />
          <Route path="/region-edit" element={<RegionEditPage />} />
          <Route path="/dashboard" element={<Navigate to="/home" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </>
  );
}
