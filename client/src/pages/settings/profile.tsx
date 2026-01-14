import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/Modal";
import { apiJson } from "@/lib/api";

type PlanTier = "starter" | "pro" | "agency";

type SubscriptionData = {
  agencyId: string;
  planTier: PlanTier;
  planDisplayName: string;
  planCode: string;
  status: "ACTIVE" | "TRIAL" | "PAST_DUE" | "CANCELLED";
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  currentPeriodEnd: string | null;
  billingCountry: string | null;
  billingCurrency: string;
  allowance: { monthlyIncluded: number; used: number; remaining: number };
  usage: { monthKey: string; includedUsed: number; addonUsed: number };
  addOns: { balance: number };
  seatLimit: number | null;
  allowInvites: boolean;
  upgradeOptions: Array<{
    planTier: PlanTier;
    displayName: string;
    monthlyAllowance: number;
    priceId: string;
    price: number;
    priceFormatted: string | null;
    seatLimit: number | null;
    allowInvites: boolean;
  }>;
  canManage: boolean;
};

type PreviewResult = {
  currency: string;
  dueToday: number;
  newMonthly: number;
  prorationLines: Array<{ description: string | null | undefined; amount: number }>;
};

const PLAN_LABELS: Record<PlanTier, string> = {
  starter: "Starter",
  pro: "Pro",
  agency: "Studio",
};

const STATUS_STYLES = {
  ACTIVE: { label: "Active", variant: "default" as const },
  TRIAL: { label: "Trial", variant: "secondary" as const },
  PAST_DUE: { label: "Past Due", variant: "destructive" as const },
  CANCELLED: { label: "Cancelled", variant: "destructive" as const },
};

function formatCurrency(amountInCents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format((amountInCents || 0) / 100);
  } catch {
    return `${currency.toUpperCase()} ${(amountInCents || 0) / 100}`;
  }
}

function UpgradeModal({
  open,
  subscription,
  onClose,
  onChanged,
}: {
  open: boolean;
  subscription: SubscriptionData | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [selectedPriceId, setSelectedPriceId] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanTier | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [effective, setEffective] = useState<"immediate" | "next_renewal">("immediate");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setSelectedPriceId(null);
    setSelectedPlan(null);
    setPreview(null);
    setEffective("immediate");
    setSaving(false);
    setPreviewLoading(false);
  };

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    const first = subscription?.upgradeOptions?.[0];
    if (first) {
      setSelectedPriceId(first.priceId);
      setSelectedPlan(first.planTier);
    }
  }, [open, subscription]);

  useEffect(() => {
    const priceId = selectedPriceId;
    if (!open || !priceId) return;
    setPreviewLoading(true);
    apiJson<PreviewResult>(`/api/billing/subscription/preview-change?newPriceId=${encodeURIComponent(priceId)}`)
      .then((p) => setPreview(p))
      .catch((err: any) => {
        toast({ title: "Preview failed", description: err?.message || "Unable to load proration", variant: "destructive" });
        setPreview(null);
      })
      .finally(() => setPreviewLoading(false));
  }, [open, selectedPriceId, toast]);

  const options = subscription?.upgradeOptions || [];

  const handleChange = async () => {
    if (!selectedPriceId) return;
    setSaving(true);
    try {
      await apiJson("/api/billing/subscription/change-plan", {
        method: "POST",
        body: JSON.stringify({ newPriceId: selectedPriceId, effective }),
      });
      toast({ title: "Plan change started", description: effective === "immediate" ? "Proration will be applied today." : "Will take effect at your next renewal." });
      onChanged();
      onClose();
    } catch (err: any) {
      toast({ title: "Change failed", description: err?.message || "Could not change plan", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="Upgrade plan" maxWidth="2xl">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Select a higher tier and review proration before confirming.</p>

        <div className="grid gap-3">
          {options.map((opt) => {
            const selected = selectedPriceId === opt.priceId;
            return (
              <button
                key={opt.priceId}
                onClick={() => {
                  setSelectedPriceId(opt.priceId);
                  setSelectedPlan(opt.planTier);
                }}
                className={`flex items-center justify-between rounded-lg border p-3 text-left transition ${selected ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-primary"}`}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{opt.displayName}</span>
                    <Badge variant="secondary">{opt.monthlyAllowance} images / mo</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {opt.priceFormatted || "Pricing not available for your currency"}
                  </p>
                </div>
                <div className="text-sm text-muted-foreground">{selected ? "Selected" : "Select"}</div>
              </button>
            );
          })}
          {!options.length && (
            <div className="text-sm text-muted-foreground">No higher tiers available.</div>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">When to apply</p>
          <div className="flex gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="effective"
                value="immediate"
                checked={effective === "immediate"}
                onChange={() => setEffective("immediate")}
              />
              Immediate (prorated today)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="effective"
                value="next_renewal"
                checked={effective === "next_renewal"}
                onChange={() => setEffective("next_renewal")}
              />
              Next renewal (no proration)
            </label>
          </div>
        </div>

        <div className="rounded-md border p-3 bg-muted/30">
          <p className="text-sm font-medium mb-2">Proration preview</p>
          {previewLoading && <p className="text-sm text-muted-foreground">Loading preview...</p>}
          {!previewLoading && preview && (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between"><span>Due today</span><span>{formatCurrency(preview.dueToday, preview.currency)}</span></div>
              <div className="flex justify-between"><span>New monthly</span><span>{formatCurrency(preview.newMonthly, preview.currency)}</span></div>
              {!!preview.prorationLines.length && (
                <div className="text-xs text-muted-foreground pt-1">
                  {preview.prorationLines.map((line, idx) => (
                    <div key={idx} className="flex justify-between">
                      <span>{line.description || "Proration"}</span>
                      <span>{formatCurrency(line.amount, preview.currency)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {!previewLoading && !preview && (
            <p className="text-sm text-muted-foreground">Select a plan to see the preview.</p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleChange} disabled={!selectedPriceId || saving || previewLoading}>
            {saving ? "Updating..." : `Change to ${selectedPlan ? PLAN_LABELS[selectedPlan] : "plan"}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function ProfileSettings() {
  const { user, loading, updateProfile } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionData | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate(`/login?redirect=/settings/profile`);
      return;
    }
    if (user) {
      setFirstName(user.firstName || "");
      setLastName(user.lastName || "");
    }
  }, [user, loading, navigate]);

  const fetchSubscription = useCallback(async () => {
    if (!user?.agencyId) return;
    setSubLoading(true);
    setSubError(null);
    try {
      const data = await apiJson<SubscriptionData>("/api/billing/subscription");
      setSubscription(data);
    } catch (err: any) {
      setSubError(err?.message || "Failed to load subscription");
    } finally {
      setSubLoading(false);
    }
  }, [user?.agencyId]);

  useEffect(() => {
    if (user?.agencyId) {
      fetchSubscription();
    }
  }, [user?.agencyId, fetchSubscription]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required");
      return;
    }
    setSaving(true);
    try {
      await updateProfile({ firstName: firstName.trim(), lastName: lastName.trim() });
      toast({ title: "Profile updated" });
    } catch (err: any) {
      setError(err.message || "Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  const statusConfig = useMemo(() => (subscription ? STATUS_STYLES[subscription.status] : null), [subscription]);
  const canUpgrade = useMemo(() => {
    if (!subscription) return false;
    return !!subscription.stripeSubscriptionId && subscription.canManage && subscription.upgradeOptions.length > 0;
  }, [subscription]);

  return (
    <div className="container mx-auto p-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Profile Settings</CardTitle>
          <CardDescription>Update your personal details.</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm mb-3">
              {error}
            </div>
          )}
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name</Label>
                <Input
                  id="firstName"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  disabled={saving}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name</Label>
                <Input
                  id="lastName"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  disabled={saving}
                  required
                />
              </div>
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Subscription</CardTitle>
            <CardDescription>View your current plan and upgrade.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {subLoading && <p className="text-sm text-muted-foreground">Loading subscription...</p>}
            {subError && !subLoading && (
              <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{subError}</div>
            )}

            {subscription && !subLoading && (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-muted-foreground">Current plan</p>
                    <p className="text-xl font-semibold">{subscription.planDisplayName}</p>
                    <p className="text-xs text-muted-foreground">{PLAN_LABELS[subscription.planTier]} · {subscription.allowance.monthlyIncluded} images / month</p>
                    <p className="text-xs text-muted-foreground">Add-on balance: {subscription.addOns.balance} images</p>
                  </div>
                  {statusConfig && (
                    <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">Usage this month</p>
                    <p className="font-semibold">{subscription.usage.includedUsed} / {subscription.allowance.monthlyIncluded}</p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">Add-ons available</p>
                    <p className="font-semibold">{subscription.addOns.balance}</p>
                  </div>
                </div>

                {subscription.currentPeriodEnd && (
                  <p className="text-xs text-muted-foreground">Renews on {new Date(subscription.currentPeriodEnd).toLocaleDateString()}</p>
                )}

                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    onClick={() => setUpgradeOpen(true)}
                    disabled={!canUpgrade}
                  >
                    {canUpgrade ? "Upgrade plan" : "Upgrade unavailable"}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <UpgradeModal
        open={upgradeOpen}
        subscription={subscription}
        onClose={() => setUpgradeOpen(false)}
        onChanged={fetchSubscription}
      />
    </div>
  );
}
