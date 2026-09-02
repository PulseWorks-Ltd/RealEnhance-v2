import { useEffect } from "react";

/**
 * Sets this page's <title> and meta description while mounted, restoring
 * the previous values on unmount. No head-management library (react-helmet
 * or similar) exists anywhere in this app — this is a small, dependency-
 * free stand-in for the handful of routes that need their own title/
 * description instead of the app-wide default in index.html.
 */
export function usePageMeta(title: string, description: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;

    let meta = document.querySelector('meta[name="description"]');
    const previousContent = meta?.getAttribute("content") ?? null;
    let createdMeta = false;
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "description");
      document.head.appendChild(meta);
      createdMeta = true;
    }
    meta.setAttribute("content", description);

    return () => {
      document.title = previousTitle;
      if (!meta) return;
      if (createdMeta) {
        meta.remove();
      } else if (previousContent !== null) {
        meta.setAttribute("content", previousContent);
      }
    };
  }, [title, description]);
}
