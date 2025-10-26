// client/src/pages/Results.tsx
import React, { useMemo } from "react";
import { useLocation } from "wouter";

function useQuery() {
  // Works both in dev and prod without react-router-dom
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  return params;
}

export default function Results() {
  const [, setLocation] = useLocation();
  const query = useQuery();

  // Example: read ?jobId=...&status=...
  const jobId = query.get("jobId") ?? "";
  const status = query.get("status") ?? "";
  const src = query.get("src") ?? "";  // e.g., original image
  const out = query.get("out") ?? "";  // e.g., processed image

  const goHome = () => setLocation("/");

  return (
    <main className="min-h-screen w-full bg-brand-light text-slate-800 p-6">
      <div className="mx-auto w-full max-w-5xl">
        <header className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Results</h1>
          <button
            className="rounded-lg bg-slate-900 text-white px-4 py-2 hover:bg-slate-800"
            onClick={goHome}
          >
            Back to Home
          </button>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600">Job ID</div>
            <div className="mt-1 font-medium">{jobId || "—"}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600">Status</div>
            <div className="mt-1 font-medium">{status || "pending"}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600">When</div>
            <div className="mt-1 font-medium">{new Date().toLocaleString()}</div>
          </div>
        </section>

        <section className="mt-6 grid gap-6 md:grid-cols-2">
          <figure className="rounded-xl overflow-hidden border border-slate-200 bg-white">
            <div className="p-3 text-sm text-slate-600">Original</div>
            {src ? (
              <img src={src} alt="Original" className="w-full object-contain" />
            ) : (
              <div className="p-6 text-slate-500">No source image provided.</div>
            )}
          </figure>

          <figure className="rounded-xl overflow-hidden border border-slate-200 bg-white">
            <div className="p-3 text-sm text-slate-600">Enhanced</div>
            {out ? (
              <img src={out} alt="Enhanced" className="w-full object-contain" />
            ) : (
              <div className="p-6 text-slate-500">Processing…</div>
            )}
          </figure>
        </section>
      </div>
    </main>
  );
}
