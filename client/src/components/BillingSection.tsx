// client/src/components/BillingSection.tsx
// Stripe billing management UI

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

interface BillingSectionProps {
  agency: {
    agencyId: string;
    name: string;
    planTier: "starter" | "pro" | "agency" | null;
    subscriptionStatus: "ACTIVE" | "TRIAL" | "PAST_DUE" | "CANCELLED";
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    billingCountry?: "NZ" | "AU" | "ZA";
    billingCurrency?: "nzd" | "aud" | "zar" | "usd";
    currentPeriodEnd?: string;
  };
  canManage?: boolean;
  onUpgradeComplete?: () => void;
}

interface UpgradeOption {
  planTier: "starter" | "pro" | "agency";
  displayName: string;
  monthlyAllowance: number;
  priceId: string;
  price: number;
  priceFormatted: string | null;
  seatLimit: number | null;
  allowInvites: boolean;
}

interface PlanDisplayOption {
  value: "starter" | "pro" | "agency";
  displayName: string;
  monthlyPriceNZD: number;
  monthlyAllowance: number;
}

interface SubscriptionInfo {
  planTier: "starter" | "pro" | "agency" | null;
  planDisplayName: string;
  stripeSubscriptionId: string | null;
  status: "ACTIVE" | "TRIAL" | "PAST_DUE" | "CANCELLED";
  currentPeriodEnd: string | null;
  billingCountry: string | null;
  billingCurrency: BillingSectionProps["agency"]["billingCurrency"];
  upgradeOptions: UpgradeOption[];
  canManage: boolean;
}

interface PromoRedeemSuccess {
  code: string;
  expiresAt: string | null;
  creditsTotal: number;
}

const PLAN_NAMES: Record<string, string> = {
  starter: "Starter",
  pro: "Pro",
  agency: "Agency",
};

const PLAN_DISPLAY_OPTIONS: PlanDisplayOption[] = [
  {
    value: "starter",
    displayName: "Starter",
    monthlyPriceNZD: 149,
    monthlyAllowance: 75,
  },
  {
    value: "pro",
    displayName: "Pro",
    monthlyPriceNZD: 249,
    monthlyAllowance: 150,
  },
  {
    value: "agency",
    displayName: "Agency",
    monthlyPriceNZD: 449,
    monthlyAllowance: 300,
  },
];

function formatPlanDisplayName(planTier: "starter" | "pro" | "agency" | null, planDisplayName?: string | null): string {
  if (!planTier) return "Trial / No Plan";
  if (planDisplayName === "Studio" || planDisplayName === "Agency Plus") return PLAN_NAMES.agency;
  return planDisplayName || PLAN_NAMES[planTier];
}

const STATUS_CONFIG = {
  ACTIVE: { label: "Active", variant: "default" as const, color: "bg-status-success" },
  TRIAL: { label: "Trial", variant: "secondary" as const, color: "bg-status-info" },
  PAST_DUE: { label: "Past Due", variant: "destructive" as const, color: "bg-status-warning" },
  CANCELLED: { label: "Cancelled", variant: "destructive" as const, color: "bg-status-error" },
};

export function BillingSection({ agency, canManage = true, onUpgradeComplete }: BillingSectionProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [loadingSubscription, setLoadingSubscription] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string>(agency.planTier || "starter");
  const [selectedCountry, setSelectedCountry] = useState<string>(agency.billingCountry || "NZ");
  const [promoCode, setPromoCode] = useState("");
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoRedeemSuccess, setPromoRedeemSuccess] = useState<PromoRedeemSuccess | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [upgradeOptions, setUpgradeOptions] = useState<UpgradeOption[]>([]);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const { toast } = useToast();

  const effectiveStatus = subscription?.status || agency.subscriptionStatus;
  const statusConfig = STATUS_CONFIG[effectiveStatus];
  const hasSubscription = !!(agency.stripeSubscriptionId || subscription?.stripeSubscriptionId);
  const manageDisabled = !canManage || (subscription ? !subscription.canManage : false);
  const currentPlanName = formatPlanDisplayName(subscription?.planTier || agency.planTier, subscription?.planDisplayName);
  const currentPeriodEnd = subscription?.currentPeriodEnd || agency.currentPeriodEnd;
  const currentBillingCountry = subscription?.billingCountry || agency.billingCountry;
  const currentBillingCurrency = subscription?.billingCurrency || agency.billingCurrency;

  const handleSubscribe = async () => {
    if (manageDisabled) return;
    if (user?.emailVerified !== true) {
      toast({
        title: "Email Verification Required",
        description: "Please confirm your email address before purchasing a plan.",
        variant: "destructive",
      });
      return;
    }
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
    if (user?.emailVerified !== true) {
      toast({
        title: "Email Verification Required",
        description: "Please confirm your email address before purchasing a plan.",
        variant: "destructive",
      });
      return;
    }
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

  const handleRedeemPromo = async () => {
    if (manageDisabled || promoLoading) return;

    const code = promoCode.trim();
    if (!code) {
      toast({
        title: "Promo code required",
        description: "Enter a promo code to redeem your free Starter month.",
        variant: "destructive",
      });
      return;
    }

    setPromoLoading(true);
    try {
      setPromoRedeemSuccess(null);
      const response = await fetch(api("/api/billing/redeem-promo"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ promoCode: code }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const errorCode = data?.error || "PROMO_REDEEM_FAILED";
        const messageMap: Record<string, string> = {
          INVALID_PROMO: "That promo code is not valid.",
          PROMO_INACTIVE: "That promo code is not active.",
          PROMO_EXPIRED: "That promo code has expired.",
          PROMO_MAXED: "That promo code has reached its redemption limit.",
          TRIAL_ALREADY_CLAIMED: "This user has already claimed a promo trial.",
          AGENCY_ALREADY_USED_TRIAL: "This agency has already used a trial before.",
          AGENCY_PREVIOUSLY_SUBSCRIBED: "This agency has already had a paid subscription and is not eligible.",
        };
        throw new Error(messageMap[errorCode] || errorCode);
      }

      setPromoCode("");
      setPromoRedeemSuccess({
        code: data?.code || code,
        expiresAt: data?.trial?.expiresAt || null,
        creditsTotal: Number(data?.trial?.creditsTotal || 0),
      });
      toast({
        title: "Promo redeemed",
        description: "Your free Starter trial has been applied.",
      });

      await fetchSubscription();
      onUpgradeComplete?.();
    } catch (error: any) {
      toast({
        title: "Promo redemption failed",
        description: error.message || "Unable to redeem promo code",
        variant: "destructive",
      });
    } finally {
      setPromoLoading(false);
    }
  };

  const fetchSubscription = useCallback(async () => {
    try {
      setLoadingSubscription(true);
      const response = await fetch(api("/api/billing/subscription"), {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`Failed to load subscription (${response.status})`);
      }

      const data = await response.json();
      setSubscription({
        planTier: data.planTier,
        planDisplayName: data.planDisplayName,
        stripeSubscriptionId: data.stripeSubscriptionId,
        status: data.status,
        currentPeriodEnd: data.currentPeriodEnd,
        billingCountry: data.billingCountry,
        billingCurrency: data.billingCurrency,
        upgradeOptions: data.upgradeOptions || [],
        canManage: data.canManage,
      });
      setUpgradeOptions(data.upgradeOptions || []);
    } catch (error: any) {
      console.error("Failed to load subscription", error);
      toast({
        title: "Billing unavailable",
        description: error.message || "Could not load subscription details",
        variant: "destructive",
      });
    } finally {
      setLoadingSubscription(false);
    }
  }, [toast, agency.agencyId]);

  const handleUpgrade = async (priceId: string) => {
    if (manageDisabled) return;
    if (user?.emailVerified !== true) {
      toast({
        title: "Email Verification Required",
        description: "Please confirm your email address before purchasing a plan.",
        variant: "destructive",
      });
      return;
    }
    setUpgradeLoading(true);
    try {
      const response = await fetch(api("/api/billing/upgrade"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newPriceId: priceId }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error || "Failed to upgrade plan");
      }

      toast({
        title: "Plan upgraded",
        description: "Plan upgraded successfully.",
      });

      await fetchSubscription();
      setUpgradeOpen(false);
      onUpgradeComplete?.();
    } catch (error: any) {
      toast({
        title: "Upgrade failed",
        description: error.message || "Unable to upgrade plan",
        variant: "destructive",
      });
    } finally {
      setUpgradeLoading(false);
    }
  };

  useEffect(() => {
    fetchSubscription();
  }, [agency.agencyId, fetchSubscription]);

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
            <p className="text-2xl font-bold">{currentPlanName}</p>
          </div>
          <Badge variant={statusConfig.variant}>
            {statusConfig.label}
          </Badge>
        </div>

        {/* Period End */}
        {currentPeriodEnd && hasSubscription && (
          <div>
            <p className="text-sm text-muted-foreground">
              Current period ends: {new Date(currentPeriodEnd).toLocaleDateString()}
            </p>
          </div>
        )}

        {/* Billing Region */}
        {currentBillingCountry && (
          <div>
            <p className="text-sm text-muted-foreground">
              Billing region: {currentBillingCountry} ({currentBillingCurrency?.toUpperCase()})
            </p>
          </div>
        )}

        {promoRedeemSuccess && (
          <Alert>
            <AlertDescription>
              Promo code {promoRedeemSuccess.code} applied. Your Starter trial is active for {promoRedeemSuccess.creditsTotal} images and expires on {promoRedeemSuccess.expiresAt ? new Date(promoRedeemSuccess.expiresAt).toLocaleDateString() : "the configured end date"}.
            </AlertDescription>
          </Alert>
        )}

        <div className="rounded-lg border p-4 space-y-3">
          <div>
            <p className="text-sm font-medium">Have a promo code?</p>
            <p className="text-sm text-muted-foreground">
              Redeem a one-time Starter trial. This is only available if your agency has never used a trial and has never had a paid subscription.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value)}
              placeholder="Enter promo code"
              disabled={manageDisabled || promoLoading}
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleRedeemPromo}
              disabled={manageDisabled || promoLoading}
            >
              {promoLoading ? "Redeeming..." : "Redeem Code"}
            </Button>
          </div>
        </div>

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
                  {PLAN_DISPLAY_OPTIONS.map((plan) => {
                    const perImage = (plan.monthlyPriceNZD / plan.monthlyAllowance).toFixed(2);
                    return (
                      <SelectItem key={plan.value} value={plan.value}>
                        <div className="flex flex-col items-start">
                          <span className="font-medium">{plan.displayName} - ${plan.monthlyPriceNZD} NZD/mo</span>
                          <span className="text-xs text-muted-foreground">
                            {plan.monthlyAllowance} enhanced images (${perImage} per image)
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
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
            {upgradeOptions.length > 0 && (
              <div className="mt-4 space-y-2">
                <Button
                  onClick={() => setUpgradeOpen(true)}
                  disabled={loading || manageDisabled}
                  className="w-full"
                  variant="default"
                  title={manageDisabled ? "Only agency owners/admins can manage billing" : undefined}
                >
                  Upgrade Plan
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  Upgrades apply immediately with prorated charges handled by Stripe.
                </p>
                {manageDisabled && (
                  <p className="text-xs text-muted-foreground text-center">
                    Only owners or admins can upgrade plans.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Info */}
        <div className="text-xs text-muted-foreground pt-4 border-t">
          <p>✓ Unlimited users per agency</p>
          <p>✓ Monthly image allowances reset on your billing date</p>
          <p>✓ Purchase additional image bundles anytime</p>
        </div>
      </CardContent>

      <Dialog open={upgradeOpen} onOpenChange={setUpgradeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upgrade Plan</DialogTitle>
            <DialogDescription>
              Choose a higher tier to unlock more allowance. No credit card data stored, all payments handled through Stripe.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {upgradeOptions.map((option) => (
              <div key={option.planTier} className="border rounded-lg p-4 space-y-1">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{formatPlanDisplayName(option.planTier, option.displayName)}</p>
                    <p className="text-xs text-muted-foreground">{option.monthlyAllowance} images / month</p>
                  </div>
                  <p className="text-sm font-semibold">{option.priceFormatted || `${option.price / 100}`}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  ${(option.price / 100 / option.monthlyAllowance).toFixed(2)} per image
                </p>
                <p className="text-xs text-muted-foreground">
                  {option.seatLimit ? `${option.seatLimit} seats included` : "Unlimited seats"}
                </p>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={upgradeLoading || manageDisabled}
                    onClick={() => handleUpgrade(option.priceId)}
                  >
                    {upgradeLoading ? "Upgrading..." : `Upgrade to ${option.displayName}`}
                  </Button>
                </div>
              </div>
            ))}

            {!loadingSubscription && upgradeOptions.length === 0 && (
              <p className="text-sm text-muted-foreground">No higher tiers available.</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUpgradeOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
