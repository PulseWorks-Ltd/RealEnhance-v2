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

interface AgencyMember {
  id: string;
  email: string;
  name: string;
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
  planTier: string;
  maxSeats: number;
  activeSeats: number;
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

  const isAdminOrOwner = agencyInfo && (agencyInfo.userRole === "owner" || agencyInfo.userRole === "admin");

  useEffect(() => {
    loadAgencyData();
  }, []);

  const loadAgencyData = async () => {
    try {
      setLoading(true);

      // Load agency info
      const infoRes = await apiFetch("/api/agency/info");
      if (infoRes.ok && infoRes.data) {
        setAgencyInfo(infoRes.data);

        // Load members if admin or owner
        if (infoRes.data.userRole === "owner" || infoRes.data.userRole === "admin") {
          const membersRes = await apiFetch("/api/agency/members");
          if (membersRes.ok && membersRes.data) {
            setMembers(membersRes.data);
          }

          // Load invites
          const invitesRes = await apiFetch("/api/agency/invites");
          if (invitesRes.ok && invitesRes.data) {
            setInvites(invitesRes.data);
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
        toast({
          title: "Invite sent",
          description: `Invitation sent to ${inviteEmail}`,
        });
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

  if (!agencyInfo) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle>No Agency</CardTitle>
            <CardDescription>You are not part of an agency account.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <h1 className="text-3xl font-bold">Agency Settings</h1>

      {/* Monthly Usage Card */}
      {usage && usage.hasAgency && (
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
            />
          </CardContent>
        </Card>
      )}

      {/* Agency Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>{agencyInfo.name}</CardTitle>
          <CardDescription>Plan: {agencyInfo.planTier}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Seat Usage</span>
              <Badge variant={agencyInfo.activeSeats > agencyInfo.maxSeats ? "destructive" : "secondary"}>
                {agencyInfo.activeSeats} / {agencyInfo.maxSeats} seats
              </Badge>
            </div>
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
                    <div className="font-medium">{member.name}</div>
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
