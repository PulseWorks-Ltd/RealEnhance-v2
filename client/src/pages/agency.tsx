import React, { useState, useEffect } from "react";
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

interface AgencyMember {
  id: string;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  role: "owner" | "admin" | "member";
  isActive: boolean;
}

interface AgencyInvite {
  token: string;
  email: string;
  role: "admin" | "member";
  createdAt: string;
  expiresAt: string;
}

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
  activeUsers?: number; // For informational purposes only
  userRole: "owner" | "admin" | "member";
}

export default function AgencyPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { usage } = useUsage();
  const [agencyInfo, setAgencyInfo] = useState<AgencyInfo | null>(null);
  const [members, setMembers] = useState<AgencyMember[]>([]);
  const [invites, setInvites] = useState<AgencyInvite[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [loading, setLoading] = useState(true);
  const [agencyName, setAgencyName] = useState("");
  const [creating, setCreating] = useState(false);

  const isAdminOrOwner = agencyInfo && (agencyInfo.userRole === "owner" || agencyInfo.userRole === "admin");

  useEffect(() => {
    loadAgencyData();

    // Check for subscription success query parameter
    const params = new URLSearchParams(window.location.search);
    if (params.get("subscription") === "success") {
      toast({
        title: "Subscription Activated!",
        description: "Your subscription has been successfully activated. Welcome aboard!",
      });
      // Clean up URL without page reload
      window.history.replaceState({}, "", "/agency");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAgencyData = async () => {
    try {
      setLoading(true);

      // Load agency info
      const infoRes = await apiFetch("/api/agency/info");
      if (infoRes.ok) {
        const infoData = await infoRes.json();

        // Map backend response to frontend format
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
          userRole: user?.role || "member", // Get role from AuthContext
        };

        setAgencyInfo(agencyInfo);

        // Load members if admin or owner
        if (agencyInfo.userRole === "owner" || agencyInfo.userRole === "admin") {
          try {
            const membersRes = await apiFetch("/api/agency/members");
            if (membersRes.ok) {
              const membersData = await membersRes.json();
              setMembers(membersData.members || membersData || []);
            }
          } catch (err) {
            console.error("Failed to load members:", err);
          }

          // Load invites
          try {
            const invitesRes = await apiFetch("/api/agency/invites");
            if (invitesRes.ok) {
              const invitesData = await invitesRes.json();
              setInvites(invitesData.invites || invitesData || []);
            }
          } catch (err) {
            console.error("Failed to load invites:", err);
          }
        }
      }
    } catch (error) {
      console.error("Failed to load agency data:", error);
      toast({
        title: "Error",
        description: "Failed to load agency information",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) {
      toast({
        title: "Error",
        description: "Please enter an email address",
        variant: "destructive",
      });
      return;
    }

    try {
      const res = await apiFetch("/api/agency/invite", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });

      if (res.ok) {
        const data = await res.json();

        if (data.emailSent === false) {
          toast({
            title: "Invitation Created",
            description: `Invite created for ${inviteEmail}, but email delivery failed. Please share the invite link manually.`,
            variant: "warning",
          });
        } else {
          toast({
            title: "Success",
            description: `Invitation sent to ${inviteEmail}`,
          });
        }

        setInviteEmail("");
        loadAgencyData();
      } else {
        toast({
          title: "Failed to send invite",
          description: res.error || "Unknown error",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to send invitation",
        variant: "destructive",
      });
    }
  };

  const handleToggleUser = async (userId: string, enable: boolean) => {
    try {
      const endpoint = enable ? `/api/agency/users/${userId}/enable` : `/api/agency/users/${userId}/disable`;
      const res = await apiFetch(endpoint, { method: "POST" });

      if (res.ok) {
        toast({
          title: "Success",
          description: `User ${enable ? "enabled" : "disabled"} successfully`,
        });
        loadAgencyData();
      } else {
        toast({
          title: "Error",
          description: res.error || "Failed to update user",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update user status",
        variant: "destructive",
      });
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">Loading agency information...</div>
      </div>
    );
  }

  const handleCreateAgency = async () => {
    if (!agencyName.trim()) {
      toast({
        title: "Error",
        description: "Please enter an agency name",
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
        toast({
          title: "Success",
          description: "Agency created successfully!",
        });
        loadAgencyData();
      } else {
        const errorData = await res.json().catch(() => ({}));
        toast({
          title: "Failed to create agency",
          description: errorData.error || "Unknown error",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create agency",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  if (!agencyInfo) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle>Create Your Agency</CardTitle>
            <CardDescription>Get started by creating your agency account</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium">Agency Name</label>
              <Input
                placeholder="Enter your agency name"
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
                className="mt-2"
              />
            </div>
            <Button onClick={handleCreateAgency} disabled={creating} className="w-full">
              {creating ? "Creating..." : "Create Agency"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <h1 className="text-3xl font-bold">Agency Settings</h1>

      {/* Monthly Usage Card - Admin/Owner only */}
      {isAdminOrOwner && usage && usage.hasAgency && (
        <Card>
          <CardHeader>
            <CardTitle>Monthly Usage</CardTitle>
            <CardDescription>Your plan includes {usage.mainAllowance} enhanced images per month</CardDescription>
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

      {/* Billing & Subscription - Admin/Owner only */}
      {isAdminOrOwner && (
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
        />
      )}

      {/* Bundle Purchase - Admin/Owner only */}
      {isAdminOrOwner && <BundlePurchase />}

      {/* Agency Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>{agencyInfo.name}</CardTitle>
          <CardDescription>Plan: {agencyInfo.planTier}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {agencyInfo.activeUsers !== undefined && (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Team Size</span>
                <Badge variant="secondary">
                  {agencyInfo.activeUsers} active users
                </Badge>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Your Role</span>
              <Badge>{agencyInfo.userRole}</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Invite Section - Admin/Owner only */}
      {isAdminOrOwner && (
        <Card>
          <CardHeader>
            <CardTitle>Invite Team Member</CardTitle>
            <CardDescription>
              Send an invitation to add a new team member to your agency
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <Input
                type="email"
                placeholder="email@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="flex-1"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as "admin" | "member")}
                className="border rounded px-3 py-2"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <Button onClick={handleInvite}>Send Invite</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pending Invites - Admin/Owner only */}
      {isAdminOrOwner && invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pending Invites</CardTitle>
            <CardDescription>{invites.length} invitation(s) pending</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {invites.map((invite) => (
                <div key={invite.token} className="flex items-center justify-between p-3 border rounded">
                  <div>
                    <div className="font-medium">{invite.email}</div>
                    <div className="text-sm text-muted-foreground">
                      Role: {invite.role} • Expires: {new Date(invite.expiresAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Badge variant="outline">Pending</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Members List - Admin/Owner only */}
      {isAdminOrOwner && members.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Team Members</CardTitle>
            <CardDescription>{members.length} member(s)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {members.map((member) => (
                <div key={member.id} className="flex items-center justify-between p-3 border rounded">
                  <div className="flex-1">
                    <div className="font-medium">{member.displayName || member.name || member.email}</div>
                    <div className="text-sm text-muted-foreground">{member.email}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                      {member.role}
                    </Badge>
                    <Badge variant={member.isActive ? "default" : "destructive"}>
                      {member.isActive ? "Active" : "Disabled"}
                    </Badge>
                    {member.role !== "owner" && agencyInfo.userRole === "owner" && (
                      <Button
                        size="sm"
                        variant={member.isActive ? "destructive" : "default"}
                        onClick={() => handleToggleUser(member.id, !member.isActive)}
                      >
                        {member.isActive ? "Disable" : "Enable"}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
