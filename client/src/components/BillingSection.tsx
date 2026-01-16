// client/src/components/BillingSection.tsx
// Stripe billing management UI

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";

interface BillingSectionProps {
  agency: {
    agencyId: string;
    name: string;
    planTier: "starter" | "pro" | "agency";
    subscriptionStatus: "ACTIVE" | "TRIAL" | "PAST_DUE" | "CANCELLED";
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    billingCountry?: "NZ" | "AU" | "ZA";
    billingCurrency?: "nzd" | "aud" | "zar" | "usd";
    currentPeriodEnd?: string;
  };
  canManage?: boolean;
}

const PLAN_NAMES: Record<string, string> = {
  starter: "Starter",
  pro: "Pro",
  agency: "Studio",
};

const STATUS_CONFIG = {
  ACTIVE: { label: "Active", variant: "default" as const, color: "bg-status-success" },
  TRIAL: { label: "Trial", variant: "secondary" as const, color: "bg-status-info" },
  PAST_DUE: { label: "Past Due", variant: "destructive" as const, color: "bg-status-warning" },
  CANCELLED: { label: "Cancelled", variant: "destructive" as const, color: "bg-status-error" },
};

export function BillingSection({ agency, canManage = true }: BillingSectionProps) {
  const [loading, setLoading] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string>(agency.planTier);
  const [selectedCountry, setSelectedCountry] = useState<string>(agency.billingCountry || "NZ");
  const { toast } = useToast();

  const statusConfig = STATUS_CONFIG[agency.subscriptionStatus];
  const hasSubscription = !!agency.stripeSubscriptionId;
  const manageDisabled = !canManage;

  const handleSubscribe = async () => {
    if (manageDisabled) return;
    setLoading(true);
    try {
      const response = await fetch(api("/api/billing/checkout-subscription"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          planTier: selectedPlan,
          country: selectedCountry,
        }),
      });

      if (!response.ok) {
        let errorMessage = "Failed to create checkout session";
        try {
          const error = await response.json();
          errorMessage = error.message || error.error || errorMessage;
        } catch {
          // Response body might be empty or not JSON
          errorMessage = `Server error: ${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const { url } = await response.json();
      window.location.href = url; // Redirect to Stripe Checkout
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to start subscription",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    if (manageDisabled) return;
    setLoading(true);
    try {
      const response = await fetch(api("/api/billing/portal"), {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        let errorMessage = "Failed to create portal session";
        try {
          const error = await response.json();
          errorMessage = error.message || error.error || errorMessage;
        } catch {
          // Response body might be empty or not JSON
          errorMessage = `Server error: ${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const { url } = await response.json();
      window.location.href = url; // Redirect to Stripe Portal
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to open billing portal",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscription & Billing</CardTitle>
        <CardDescription>
          Manage your subscription plan and billing details
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status Banner */}
        {(agency.subscriptionStatus === "PAST_DUE" || agency.subscriptionStatus === "CANCELLED") && (
          <Alert variant="destructive">
            <AlertDescription>
              {agency.subscriptionStatus === "PAST_DUE" && (
                <>
                  Your subscription payment is overdue. Please update your payment method to continue using RealEnhance.
                </>
              )}
              {agency.subscriptionStatus === "CANCELLED" && (
                <>
                  Your subscription has been cancelled. Resubscribe to continue enhancing images.
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* Current Plan */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Current Plan</p>
            <p className="text-2xl font-bold">{PLAN_NAMES[agency.planTier]}</p>
          </div>
          <Badge variant={statusConfig.variant}>
            {statusConfig.label}
          </Badge>
        </div>

        {/* Period End */}
        {agency.currentPeriodEnd && hasSubscription && (
          <div>
            <p className="text-sm text-muted-foreground">
              Current period ends: {new Date(agency.currentPeriodEnd).toLocaleDateString()}
            </p>
          </div>
        )}

        {/* Billing Region */}
        {agency.billingCountry && (
          <div>
            <p className="text-sm text-muted-foreground">
              Billing region: {agency.billingCountry} ({agency.billingCurrency?.toUpperCase()})
            </p>
          </div>
        )}

        {/* Subscribe Section (if no subscription) */}
        {!hasSubscription && (
          <div className="space-y-4 pt-4 border-t">
            <div>
              <label className="text-sm font-medium">Select Plan</label>
              <Select value={selectedPlan} onValueChange={setSelectedPlan}>
                <SelectTrigger className="w-full mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starter">
                    <div className="flex flex-col items-start">
                      <span className="font-medium">Starter - $129 NZD/mo</span>
                      <span className="text-xs text-muted-foreground">100 enhanced images</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="pro">
                    <div className="flex flex-col items-start">
                      <span className="font-medium">Pro - $249 NZD/mo</span>
                      <span className="text-xs text-muted-foreground">250 enhanced images</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="agency">
                    <div className="flex flex-col items-start">
                      <span className="font-medium">Studio - $499 NZD/mo</span>
                      <span className="text-xs text-muted-foreground">600 enhanced images</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium">Billing Country</label>
              <Select value={selectedCountry} onValueChange={setSelectedCountry}>
                <SelectTrigger className="w-full mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NZ">New Zealand (NZD)</SelectItem>
                  <SelectItem value="AU">Australia (AUD)</SelectItem>
                  <SelectItem value="ZA">South Africa (ZAR)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={handleSubscribe}
              disabled={loading || manageDisabled}
              className="w-full"
              size="lg"
              title={manageDisabled ? "Only agency owners/admins can manage billing" : undefined}
            >
              {loading ? "Loading..." : "Subscribe Now"}
            </Button>
          </div>
        )}

        {/* Manage Subscription (if has subscription) */}
        {hasSubscription && (
          <div className="pt-4 border-t">
            <Button
              onClick={handleManageSubscription}
              disabled={loading || manageDisabled}
              className="w-full"
              variant="outline"
              title={manageDisabled ? "Only agency owners/admins can manage billing" : undefined}
            >
              {loading ? "Loading..." : "Manage Subscription"}
            </Button>
            <p className="text-xs text-muted-foreground mt-2 text-center">
              {manageDisabled
                ? "Contact an agency owner or admin to update billing."
                : "Update payment method, view invoices, or cancel subscription"}
            </p>
          </div>
        )}

        {/* Info */}
        <div className="text-xs text-muted-foreground pt-4 border-t">
          <p>✓ Unlimited users per agency</p>
          <p>✓ Monthly image allowances reset on your billing date</p>
          <p>✓ Purchase additional image bundles anytime</p>
        </div>
      </CardContent>
    </Card>
  );
}
