// client/src/components/bundle-purchase.tsx
// Bundle purchase UI for admins to buy additional image packs

import React, { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { getCheckoutRedirect } from "@/lib/checkoutRedirect";
import { loadStripe } from "@stripe/stripe-js";
import { Loader2, Package, Sparkles } from "lucide-react";

interface BundleOption {
  code: "BUNDLE_50" | "BUNDLE_100";
  name: string;
  images: number;
  priceNZD: number;
  description: string;
  recommended?: boolean;
}

const BUNDLES: BundleOption[] = [
  {
    code: "BUNDLE_50",
    name: "50 Image Bundle",
    images: 50,
    priceNZD: 49,
    description: "Perfect for a busy month",
  },
  {
    code: "BUNDLE_100",
    name: "100 Image Bundle",
    images: 100,
    priceNZD: 89,
    description: "Best value for high-volume agencies",
    recommended: true,
  },
];

export function BundlePurchase() {
  const { toast } = useToast();
  const [loading, setLoading] = useState<string | null>(null);
  const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY || "");

  const redirectWithStripeSession = async (sessionId: string) => {
    if (!import.meta.env.VITE_STRIPE_PUBLIC_KEY) {
      throw new Error("Stripe publishable key missing for session redirect");
    }

    const stripe = await stripePromise;
    if (!stripe) {
      throw new Error("Stripe failed to initialize for checkout");
    }

    const { error } = await stripe.redirectToCheckout({ sessionId });
    if (error) {
      throw new Error(error.message || "Stripe redirect failed");
    }
  };

  const handlePurchase = async (bundleCode: string) => {
    try {
      if (loading) return; // guard against double clicks
      setLoading(bundleCode);

      const res = await apiFetch("/api/agency/bundles/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleCode }),
      });

      const data = await res.json().catch(() => ({}));
      const redirect = getCheckoutRedirect(data);

      if (redirect.type === "url") {
        window.location.assign(redirect.url);
        return;
      }

      await redirectWithStripeSession(redirect.sessionId);
    } catch (error: any) {
      console.error("Purchase error:", error);
      const description = error?.message
        ? error.message
        : "Network error creating checkout session";
      toast({
        title: "Purchase Failed",
        description,
        variant: "destructive",
      });
    } finally {
      setLoading(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Package className="h-5 w-5" />
          <CardTitle>Additional Images</CardTitle>
        </div>
        <CardDescription>
          Need more enhanced images this month? Purchase a one-time image bundle
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {BUNDLES.map((bundle) => (
            <div
              key={bundle.code}
              className={`relative border rounded-lg p-4 hover:border-primary transition-colors ${
                bundle.recommended ? "border-primary shadow-sm" : ""
              }`}
            >
              {bundle.recommended && (
                <Badge className="absolute -top-2 -right-2 bg-primary">
                  <Sparkles className="h-3 w-3 mr-1" />
                  Best Value
                </Badge>
              )}

              <div className="space-y-3">
                <div>
                  <h3 className="font-semibold text-lg">{bundle.name}</h3>
                  <p className="text-sm text-muted-foreground">{bundle.description}</p>
                </div>

                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold">${bundle.priceNZD}</span>
                  <span className="text-sm text-muted-foreground">NZD</span>
                </div>

                <div className="space-y-1 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Images included:</span>
                    <span className="font-medium">{bundle.images} images</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Price per image:</span>
                    <span className="font-medium">
                      ${(bundle.priceNZD / bundle.images).toFixed(2)} NZD
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Expires:</span>
                    <span className="font-medium">End of month</span>
                  </div>
                </div>

                <Button
                  onClick={() => handlePurchase(bundle.code)}
                  disabled={loading !== null}
                  className="w-full"
                  variant={bundle.recommended ? "default" : "outline"}
                >
                  {loading === bundle.code ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Redirecting...
                    </>
                  ) : (
                    `Purchase ${bundle.images} Images`
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 p-3 bg-muted rounded-md text-sm text-muted-foreground">
          <strong>Note:</strong> Bundle images expire at the end of the purchase month and are consumed
          after your monthly allowance. Secure payment powered by Stripe.
        </div>
      </CardContent>
    </Card>
  );
}
