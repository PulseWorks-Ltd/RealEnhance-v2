import { useEffect } from "react";

export default function AuthComplete() {
  useEffect(() => {
    try {
      // Notify the opener (main app) that auth succeeded
      if (window.opener && typeof window.opener.postMessage === "function") {
        window.opener.postMessage({ type: "auth:success" }, window.location.origin);
      }
    } catch (e) {
      // ignore
    }
    // Attempt to close this popup; if blocked, navigate back home in this window
    const timer = setTimeout(() => {
      try { window.close(); } catch {}
      if (!window.closed) {
        try { window.location.replace("/home"); } catch { window.location.href = "/home"; }
      }
    }, 30);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <p>Signing you in…</p>
    </div>
  );
}
