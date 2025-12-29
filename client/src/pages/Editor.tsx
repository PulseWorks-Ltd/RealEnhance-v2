// client/src/pages/Editor.tsx
import React, { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

// Small helper for query params
function useQuery() {
  return useMemo(() => new URLSearchParams(window.location.search), []);
}

export default function Editor() {
  const navigate = useNavigate();
  const query = useQuery();

  // Example: read params from ?id=...&src=...
  const initialId = query.get("id") ?? "";
  const initialSrc = query.get("src") ?? "";

  const [imageId, setImageId] = useState(initialId);
  const [srcUrl, setSrcUrl] = useState(initialSrc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If you previously used useParams("/editor/:id"), you can use useRoute:
  // const [match, params] = useRoute("/editor/:id");
  // const imageIdFromRoute = match ? params.id : "";

  useEffect(() => {
    setError(null);
  }, [imageId, srcUrl]);

  const goHome = () => navigate("/");

  const handleProcess = async () => {
    try {
      setBusy(true);
      setError(null);

      // TODO: call your API here to kick off processing
      // await clientApi.process({ imageId, srcUrl });

      // Navigate to results with query params (replaces Navigate / useNavigate)
      const params = new URLSearchParams();
      if (imageId) params.set("jobId", imageId);
      if (srcUrl) params.set("src", srcUrl);
      navigate(`/results?${params.toString()}`);
    } catch (e: any) {
      setError(e?.message ?? "Failed to process image");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen w-full bg-brand-light text-slate-800 p-6">
      <div className="mx-auto w-full max-w-4xl">
        <header className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Editor</h1>
          <button
            onClick={goHome}
            className="rounded-lg bg-slate-900 text-white px-4 py-2 hover:bg-slate-800"
          >
            Back to Home
          </button>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <div className="text-sm text-slate-600 mb-1">Image ID</div>
            <input
              value={imageId}
              onChange={(e) => setImageId(e.target.value)}
              placeholder="e.g. abc123"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </label>

          <label className="block">
            <div className="text-sm text-slate-600 mb-1">Source URL</div>
            <input
              value={srcUrl}
              onChange={(e) => setSrcUrl(e.target.value)}
              placeholder="https://…"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </label>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {error}
          </div>
        )}

        <div className="mt-6">
          <button
            onClick={handleProcess}
            disabled={busy || (!imageId && !srcUrl)}
            className="rounded-lg bg-brand-accent text-white px-5 py-2 disabled:opacity-60 hover:bg-brand-accent"
          >
            {busy ? "Processing…" : "Process"}
          </button>
        </div>
      </div>
    </main>
  );
}
