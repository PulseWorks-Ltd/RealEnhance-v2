import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Clock, Crown, Loader2, Mail, Shield, User, Users } from "lucide-react";

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
  activeUsers?: number;
  userRole: "owner" | "admin" | "member";
}

const roleIcons = {
  owner: Crown,
  admin: Shield,
  member: User,
};

export default function AgencySettingsPage() {
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [agencyInfo, setAgencyInfo] = useState<AgencyInfo | null>(null);
  const [members, setMembers] = useState<AgencyMember[]>([]);
  const [invites, setInvites] = useState<AgencyInvite[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [agencyName, setAgencyName] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const loadAgencyData = async () => {
    try {
      setLoading(true);

      if (!user?.agencyId) {
        setAgencyInfo(null);
        setMembers([]);
        setInvites([]);
        return;
      }

      const infoRes = await apiFetch("/api/agency/info");
      if (!infoRes.ok) {
        if (infoRes.status === 404) {
          setAgencyInfo(null);
          return;
        }
        try {
          const errBody = await infoRes.json();
          if (errBody?.error === "ORG_NOT_FOUND" || errBody?.code === "ORG_NOT_FOUND") {
            setAgencyInfo(null);
            return;
          }
        } catch {
          /* ignore parse failure */
        }
        throw new Error(`Failed to load agency info (${infoRes.status})`);
      }

      const infoData = await infoRes.json();
      if (!infoData?.agency) {
        setAgencyInfo(null);
        return;
      }

      const role = user?.role || "member";
      const info: AgencyInfo = {
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
        userRole: role,
      };

      setAgencyInfo(info);

      // Fetch members for all roles so members can view the roster
      try {
        const membersRes = await apiFetch("/api/agency/members");
        if (membersRes.ok) {
          const membersData = await membersRes.json();
          setMembers(membersData.members || membersData || []);
        }
      } catch (err) {
        console.error("Failed to load members:", err);
      }

      // Invites remain restricted to admins/owners
      if (role === "owner" || role === "admin") {
        try {
          const invitesRes = await apiFetch("/api/agency/invites");
          if (invitesRes.ok) {
            const invitesData = await invitesRes.json();
            setInvites(invitesData.invites || invitesData || []);
          }
        } catch (err) {
          console.error("Failed to load invites:", err);
        }
      } else {
        setInvites([]);
      }
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

  useEffect(() => {
    loadAgencyData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) {
      toast({ title: "Error", description: "Please enter an email address", variant: "destructive" });
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
          toast({ title: "Success", description: `Invitation sent to ${inviteEmail}` });
        }
        setInviteEmail("");
        loadAgencyData();
      } else {
        toast({ title: "Failed to send invite", description: res.error || "Unknown error", variant: "destructive" });
      }
    } catch (error) {
      toast({ title: "Error", description: "Failed to send invitation", variant: "destructive" });
    }
  };

  const handleToggleUser = async (userId: string, enable: boolean) => {
    try {
      const endpoint = enable ? `/api/agency/users/${userId}/enable` : `/api/agency/users/${userId}/disable`;
      const res = await apiFetch(endpoint, { method: "POST" });

      if (res.ok) {
        toast({ title: "Success", description: `Team member ${enable ? "enabled" : "disabled"} successfully` });
        loadAgencyData();
      } else {
        toast({ title: "Error", description: res.error || "Failed to update team member", variant: "destructive" });
      }
    } catch (error) {
      toast({ title: "Error", description: "Failed to update team member status", variant: "destructive" });
    }
  };

  const handleCreateAgency = async () => {
    if (!agencyName.trim()) {
      toast({ title: "Error", description: "Please enter an organization name", variant: "destructive" });
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
        toast({ title: "Success", description: "Organization created successfully!" });
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
        navigate("/agency", { replace: true });
        loadAgencyData();
      } else {
        const errorData = await res.json().catch(() => ({}));
        toast({ title: "Failed to create organization", description: errorData.error || "Unknown error", variant: "destructive" });
      }
    } catch (error) {
      toast({ title: "Error", description: "Failed to create organization", variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const isAdminOrOwner = agencyInfo && (agencyInfo.userRole === "owner" || agencyInfo.userRole === "admin");

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Agency" description="Manage your organization and team" />
        <div className="flex flex-col items-center justify-center py-12">
          <Loader2 className="w-8 h-8 text-muted-foreground animate-spin mb-3" />
          <p className="text-sm text-muted-foreground">Loading organization info...</p>
        </div>
      </div>
    );
  }

  if (!agencyInfo) {
    return (
      <div className="space-y-6">
        <PageHeader title="Get Started" description="Create your organization to manage your team" />
        <Card className="max-w-md mx-auto">
          <CardHeader className="text-center">
            <div className="w-12 h-12 rounded-full bg-action-50 flex items-center justify-center mx-auto mb-3">
              <Building2 className="w-6 h-6 text-action-600" />
            </div>
            <CardTitle>Create Your Organization</CardTitle>
            <CardDescription>Set up your organization to invite team members</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Organization Name</label>
              <Input placeholder="e.g., Smith Real Estate" value={agencyName} onChange={(e) => setAgencyName(e.target.value)} />
            </div>
            <Button variant="brand" onClick={handleCreateAgency} disabled={creating} className="w-full">
              {creating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Users className="w-4 h-4 mr-2" />
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
      <PageHeader title="Agency" description={`Manage ${agencyInfo.name}'s details and team`} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-muted-foreground" />
            {agencyInfo.name}
          </CardTitle>
          <CardDescription>
            {agencyInfo.planTier.charAt(0).toUpperCase() + agencyInfo.planTier.slice(1)} Plan
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {agencyInfo.activeUsers !== undefined && (
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">Team Size</span>
                <span className="text-sm font-medium">
                  {agencyInfo.activeUsers} {agencyInfo.activeUsers === 1 ? "member" : "members"}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">Your Role</span>
              <Badge variant={agencyInfo.userRole === "owner" ? "default" : "secondary"}>
                {agencyInfo.userRole.charAt(0).toUpperCase() + agencyInfo.userRole.slice(1)}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {isAdminOrOwner && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5 text-muted-foreground" />
              Invite Team Member
            </CardTitle>
            <CardDescription>Send an invitation to add a new team member</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-3">
              <Input type="email" placeholder="colleague@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="flex-1" />
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as "admin" | "member")}>
                <SelectTrigger className="w-full sm:w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={handleInvite}>Send Invite</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isAdminOrOwner && invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-muted-foreground" />
              Pending Invitations
            </CardTitle>
            <CardDescription>
              {invites.length} invitation{invites.length !== 1 ? "s" : ""} awaiting response
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {invites.map((invite) => (
                <div key={invite.token} className="flex items-center justify-between p-3 bg-surface-subtle rounded-lg border border-border">
                  <div>
                    <p className="font-medium text-foreground">{invite.email}</p>
                    <p className="text-sm text-muted-foreground">
                      {invite.role.charAt(0).toUpperCase() + invite.role.slice(1)} · Expires {new Date(invite.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <StatusBadge status="pending" label="Pending" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {members.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5 text-muted-foreground" />
              Team Members
            </CardTitle>
            <CardDescription>{members.length} team member{members.length !== 1 ? "s" : ""}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {members.map((member) => {
                const RoleIcon = roleIcons[member.role];
                return (
                  <div key={member.id} className="flex items-center justify-between p-3 bg-surface-subtle rounded-lg border border-border">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                        <RoleIcon className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-foreground truncate">
                          {member.displayName || member.name || member.email.split("@")[0]}
                        </p>
                        <p className="text-sm text-muted-foreground truncate">{member.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                        {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                      </Badge>
                      <StatusBadge status={member.isActive ? "success" : "error"} label={member.isActive ? "Active" : "Disabled"} />
                      {member.role !== "owner" && agencyInfo.userRole === "owner" && (
                        <Button size="sm" variant={member.isActive ? "outline" : "default"} onClick={() => handleToggleUser(member.id, !member.isActive)}>
                          {member.isActive ? "Disable" : "Enable"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
