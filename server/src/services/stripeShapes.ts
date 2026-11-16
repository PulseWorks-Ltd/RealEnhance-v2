// server/src/services/stripeShapes.ts
// Stripe moved some fields in its 2025 API versions (2025-03-31 "basil"
// onward; the stripe package we use defaults to 2025-12-15 "clover"):
//  - a subscription's billing period dates now live on its items, not on the
//    subscription itself;
//  - an invoice's subscription id now lives under invoice.parent.
// Code that read only the old places silently got nothing, so the app never
// learnt when an agency's billing month started or renewed (Nov 2026). These
// helpers read either shape.

export function subPeriodStart(sub: any): number | undefined {
  const v = sub?.current_period_start ?? sub?.items?.data?.[0]?.current_period_start;
  return typeof v === "number" && v > 0 ? v : undefined;
}

export function subPeriodEnd(sub: any): number | undefined {
  const v = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return typeof v === "number" && v > 0 ? v : undefined;
}

export function invoiceSubscriptionId(invoice: any): string | null {
  const v = invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription ?? null;
  if (!v) return null;
  return typeof v === "string" ? v : (v.id ?? null);
}
