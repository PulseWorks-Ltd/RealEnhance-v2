export type CheckoutRedirect =
  | { type: "url"; url: string }
  | { type: "sessionId"; sessionId: string };

/**
 * Normalize checkout redirect payloads from the bundles API.
 * Supports both modern `checkoutUrl` and legacy `url`, and falls back to sessionId.
 */
export function getCheckoutRedirect(data: any): CheckoutRedirect {
  const url = typeof data?.checkoutUrl === "string" && data.checkoutUrl.trim()
    ? data.checkoutUrl.trim()
    : typeof data?.url === "string" && data.url.trim()
      ? data.url.trim()
      : null;

  if (url) {
    return { type: "url", url };
  }

  const sessionId = typeof data?.sessionId === "string" && data.sessionId.trim()
    ? data.sessionId.trim()
    : null;

  if (sessionId) {
    return { type: "sessionId", sessionId };
  }

  throw new Error("Checkout session response missing redirect URL and sessionId");
}
