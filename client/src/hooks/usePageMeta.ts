import { useEffect } from "react";

/** The one public address search engines should list pages under. */
export const SITE_ORIGIN = "https://www.realenhance.co.nz";

/**
 * Sets this page's <title>, meta description and (when `path` is given) its
 * canonical link while mounted, restoring the previous values on unmount.
 * No head-management library (react-helmet or similar) exists anywhere in
 * this app — this is a small, dependency-free stand-in for the handful of
 * routes that need their own title/description instead of the app-wide
 * default in index.html.
 */
export function usePageMeta(title: string, description: string, path?: string) {
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

    // Canonical link: one official address per page, so www/non-www and
    // ?query variants (e.g. /signup?invite=…) aren't listed as duplicates.
    let canonical: HTMLLinkElement | null = null;
    if (path) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      canonical.setAttribute("href", SITE_ORIGIN + path);
      document.head.appendChild(canonical);
    }

    return () => {
      document.title = previousTitle;
      canonical?.remove();
      if (!meta) return;
      if (createdMeta) {
        meta.remove();
      } else if (previousContent !== null) {
        meta.setAttribute("content", previousContent);
      }
    };
  }, [title, description, path]);
}
