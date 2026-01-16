import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { UsageSummary } from "@/components/usage-bar";
import { useUsage } from "@/hooks/use-usage";
import { BundlePurchase } from "@/components/bundle-purchase";
import { BillingSection } from "@/components/BillingSection";
import { PageHeader } from "@/components/ui/page-header";
import { Loader2, Building2, Sparkles } from "lucide-react";

interface AgencyInfo {
  agencyId: string;
  name: string;
  planTier: "starter" | "pro" | "agency";
  subscriptionStatus: "ACTIVE" | "TRIAL" | "PAST_DUE" | "CANCELLED";
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  billingCountry?: "NZ" | "AU" | "ZA";
  billingCurrency?: "nzd" | "aud" | "zar" | "usd";
  currentPeriodEnd?: string;
  activeUsers?: number;
  userRole: "owner" | "admin" | "member";
  subscription?: {
    planTier: "starter" | "pro" | "agency";
    planName: string;
    status: "ACTIVE" | "TRIAL" | "PAST_DUE" | "CANCELLED";
    currentPeriodEnd?: string | null;
    billingCurrency?: string | null;
    billingCountry?: string | null;
    allowance: {
      monthlyIncluded: number;
      used: number;
      remaining: number;
      addonBalance: number;
      monthKey: string;
    };
  };
  trial?: {
    status: "none" | "pending" | "active" | "expired" | "converted";
    expiresAt?: string | null;
    creditsTotal: number;
    creditsUsed: number;
    remaining: number;
  };
}

export default function AgencyPage() {
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();
  const { usage } = useUsage();
  const navigate = useNavigate();
  const [agencyInfo, setAgencyInfo] = useState<AgencyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [agencyName, setAgencyName] = useState("");
  const [creating, setCreating] = useState(false);

  const isAdminOrOwner = agencyInfo && (agencyInfo.userRole === "owner" || agencyInfo.userRole === "admin");

  const scrollToBilling = () => {
    const el = document.getElementById("billing-section");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    loadAgencyData();

    const params = new URLSearchParams(window.location.search);
    if (params.get("subscription") === "success") {
      toast({
        title: "Subscription Activated!",
        description: "Your subscription has been successfully activated. Welcome aboard!",
      });
      window.history.replaceState({}, "", "/agency");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const loadAgencyData = async () => {
    try {
      setLoading(true);

      if (!user?.agencyId) {
        setAgencyInfo(null);
        setLoading(false);
        return;
      }

      const infoRes = await apiFetch("/api/agency/info");
      if (!infoRes.ok) {
        // Handle expected "no org" states without showing error toast
        if (infoRes.status === 404) {
          setAgencyInfo(null);
          setLoading(false);
          return;
        }
        // Check for ORG_NOT_FOUND error code in response body
        try {
          const errBody = await infoRes.json();
          if (errBody?.error === "ORG_NOT_FOUND" || errBody?.code === "ORG_NOT_FOUND") {
            setAgencyInfo(null);
            setLoading(false);
            return;
          }
        } catch {
          // JSON parse failed, continue to throw
        }
        throw new Error(`Failed to load agency info (${infoRes.status})`);
      }

      const infoData = await infoRes.json();
      if (!infoData?.agency) {
        setAgencyInfo(null);
        return;
      }

      const agencyInfo: AgencyInfo = {
        agencyId: infoData.agency.agencyId,
        name: infoData.agency.name,
        planTier: infoData.agency.planTier,
        subscriptionStatus: infoData.agency.subscriptionStatus,
        stripeCustomerId: infoData.agency.stripeCustomerId,
        stripeSubscriptionId: infoData.agency.stripeSubscriptionId,
        billingCountry: infoData.agency.billingCountry,
        billingCurrency: infoData.agency.billingCurrency,
        currentPeriodEnd: infoData.agency.currentPeriodEnd,
        activeUsers: infoData.activeUsers,
        userRole: user?.role || "member",
        subscription: infoData.subscription
          ? {
              planTier: infoData.subscription.planTier,
              planName: infoData.subscription.planName,
              status: infoData.subscription.status,
              currentPeriodEnd: infoData.subscription.currentPeriodEnd,
              billingCurrency: infoData.subscription.billingCurrency,
              billingCountry: infoData.subscription.billingCountry,
              allowance: infoData.subscription.allowance,
            }
          : undefined,
        trial: infoData.trial
          ? {
              status: infoData.trial.status,
              expiresAt: infoData.trial.expiresAt,
              creditsTotal: infoData.trial.creditsTotal,
              creditsUsed: infoData.trial.creditsUsed,
              remaining: infoData.trial.remaining,
            }
          : undefined,
      };

      setAgencyInfo(agencyInfo);
    } catch (error) {
      console.error("Failed to load agency data:", error);
      if (user?.agencyId) {
        toast({
          title: "Error",
          description: "Failed to load organization information",
          variant: "destructive",
        });
      } else {
        setAgencyInfo(null);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAgency = async () => {
    if (!agencyName.trim()) {
      toast({
        title: "Error",
        description: "Please enter an organization name",
        variant: "destructive",
      });
      return;
    }

    try {
      setCreating(true);
      const res = await apiFetch("/api/agency/create", {
        method: "POST",
        body: JSON.stringify({ name: agencyName.trim(), planTier: "starter" }),
      });

      if (res.ok) {
        const created = await res.json().catch(() => null);
        await refreshUser();
        toast({
          title: "Success",
          description: "Organization created successfully!",
        });
        setAgencyName("");
        if (created?.agency && created?.user) {
          setAgencyInfo({
            agencyId: created.agency.agencyId,
            name: created.agency.name,
            planTier: created.agency.planTier,
            subscriptionStatus: created.agency.subscriptionStatus,
            stripeCustomerId: created.agency.stripeCustomerId,
            stripeSubscriptionId: created.agency.stripeSubscriptionId,
            billingCountry: created.agency.billingCountry,
            billingCurrency: created.agency.billingCurrency,
            currentPeriodEnd: created.agency.currentPeriodEnd,
            activeUsers: created.activeUsers,
            userRole: created.user.role || "owner",
          });
        }
        navigate("/billing#billing-section", { replace: true });
        loadAgencyData();
      } else {
        const errorData = await res.json().catch(() => ({}));
        toast({
          title: "Failed to create organization",
          description: errorData.error || "Unknown error",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create organization",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Billing & Usage"
          description="Manage your subscription, usage, and add-ons"
        />
        <div className="flex flex-col items-center justify-center py-12">
          <Loader2 className="w-8 h-8 text-muted-foreground animate-spin mb-3" />
          <p className="text-sm text-muted-foreground">Loading organization info...</p>
        </div>
      </div>
    );
  }

  // Create agency state
  if (!agencyInfo) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Get Started"
          description="Create your organization to start enhancing property photos"
        />
        <Card className="max-w-md mx-auto">
          <CardHeader className="text-center">
            <div className="w-12 h-12 rounded-full bg-action-50 flex items-center justify-center mx-auto mb-3">
              <Building2 className="w-6 h-6 text-action-600" />
            </div>
            <CardTitle>Create Your Organization</CardTitle>
            <CardDescription>
              Set up your organization to manage billing and invite team members
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Organization Name</label>
              <Input
                placeholder="e.g., Smith Real Estate"
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
              />
            </div>
            <Button
              variant="brand"
              onClick={handleCreateAgency}
              disabled={creating}
              className="w-full"
            >
              {creating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Create Organization
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
        <PageHeader
          title="Billing & Usage"
          description={`Manage ${agencyInfo.name}'s subscription, usage, and add-ons`}
        />

      {/* Trial Banner */}
      {agencyInfo.trial && agencyInfo.trial.status !== "none" && (
        <Card className="border-gold-400 bg-gold-50">
          <CardContent className="py-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-full bg-gold-100">
                  <Sparkles className="w-4 h-4 text-gold-600" />
                </div>
                <div>
                  <p className="font-medium text-foreground">
                    {agencyInfo.trial.status === "active"
                      ? `${agencyInfo.trial.remaining} trial enhancements remaining`
                      : agencyInfo.trial.status === "expired"
                      ? "Your trial has ended"
                      : agencyInfo.trial.status === "converted"
                      ? "You've upgraded! Trial complete."
                      : "Trial status updated"}
                  </p>
                  {agencyInfo.trial.expiresAt && agencyInfo.trial.status === "active" && (
                    <p className="text-sm text-muted-foreground">
                      Expires {new Date(agencyInfo.trial.expiresAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </div>
              <Button variant="brand" onClick={scrollToBilling}>
                Upgrade Now
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {agencyInfo.subscription && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <span>Plan & Images</span>
              <Badge variant={agencyInfo.subscription.status === "ACTIVE" ? "default" : "secondary"}>
                {agencyInfo.subscription.status.toLowerCase()}
              </Badge>
            </CardTitle>
            <CardDescription>
              {agencyInfo.subscription.planName} • {agencyInfo.subscription.allowance.monthKey}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Monthly included</p>
              <p className="text-lg font-semibold">{agencyInfo.subscription.allowance.monthlyIncluded}</p>
              <p className="text-xs text-muted-foreground">
                Used {agencyInfo.subscription.allowance.used} • Remaining {agencyInfo.subscription.allowance.remaining}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Add-on / carry-over</p>
              <p className="text-lg font-semibold">{agencyInfo.subscription.allowance.addonBalance}</p>
              <p className="text-xs text-muted-foreground">Rolls forward from bundles & renewals</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Billing</p>
              <p className="text-lg font-semibold">
                {agencyInfo.subscription.billingCurrency?.toUpperCase() || agencyInfo.billingCurrency?.toUpperCase() || ""}
              </p>
              {agencyInfo.subscription.currentPeriodEnd && (
                <p className="text-xs text-muted-foreground">
                  Renews on {new Date(agencyInfo.subscription.currentPeriodEnd).toLocaleDateString()}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Monthly Usage Card */}
      {usage && usage.hasAgency && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>Monthly Usage</span>
            </CardTitle>
            <CardDescription>
              Your plan includes {usage.mainAllowance} enhanced images per month
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UsageSummary
              mainUsed={usage.mainUsed || 0}
              mainTotal={usage.mainAllowance || 0}
              mainWarning={usage.mainWarning || "none"}
              stagingUsed={usage.stagingUsed}
              stagingTotal={usage.stagingAllowance}
              stagingWarning={usage.stagingWarning}
              planName={usage.planName || ""}
              monthKey={usage.monthKey}
              stagingNote={usage.stagingNote}
              topUsers={usage.topUsers}
            />
          </CardContent>
        </Card>
      )}

      {/* Billing Section */}
      {agencyInfo && (
        <div id="billing-section">
          <BillingSection
            agency={{
              agencyId: agencyInfo.agencyId,
              name: agencyInfo.name,
              planTier: agencyInfo.planTier,
              subscriptionStatus: agencyInfo.subscriptionStatus,
              stripeCustomerId: agencyInfo.stripeCustomerId,
              stripeSubscriptionId: agencyInfo.stripeSubscriptionId,
              billingCountry: agencyInfo.billingCountry,
              billingCurrency: agencyInfo.billingCurrency,
              currentPeriodEnd: agencyInfo.currentPeriodEnd,
            }}
            canManage={isAdminOrOwner}
          />
        </div>
      )}

      {/* Bundle Purchase */}
      {isAdminOrOwner && <BundlePurchase />}

    </div>
  );
}
