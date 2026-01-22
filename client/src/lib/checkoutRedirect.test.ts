import { describe, expect, it } from "vitest";
import { getCheckoutRedirect } from "./checkoutRedirect";

describe("getCheckoutRedirect", () => {
  it("returns checkoutUrl when present", () => {
    const data = { checkoutUrl: "https://checkout.stripe.com/c/pay/test123" };
    const res = getCheckoutRedirect(data);
    expect(res).toEqual({ type: "url", url: data.checkoutUrl });
  });

  it("falls back to legacy url", () => {
    const data = { url: "https://legacy.example/checkout" };
    const res = getCheckoutRedirect(data);
    expect(res).toEqual({ type: "url", url: data.url });
  });

  it("returns sessionId when url missing", () => {
    const data = { sessionId: "cs_test_123" };
    const res = getCheckoutRedirect(data);
    expect(res).toEqual({ type: "sessionId", sessionId: data.sessionId });
  });

  it("throws when payload missing redirect info", () => {
    expect(() => getCheckoutRedirect({})).toThrow(/missing redirect/i);
  });
});