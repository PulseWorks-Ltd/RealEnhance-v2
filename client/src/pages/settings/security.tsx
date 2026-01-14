import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export default function SecuritySettings() {
  const { user, loading, refreshUser, setPassword, changePassword } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPasswordValue] = useState("");
  const [newPassword, setNewPasswordValue] = useState("");
  const [confirmPassword, setConfirmPasswordValue] = useState("");
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasPassword = user?.authProvider === "email" || user?.authProvider === "both";
  const isOAuthOnly = user?.authProvider === "google";

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters long");
      return;
    }

    setChanging(true);
    try {
      await setPassword(newPassword);
      await refreshUser();
      toast({ title: "Password set successfully" });
      setNewPasswordValue("");
      setConfirmPasswordValue("");
    } catch (err: any) {
      setError(err.message || "Failed to set password");
    } finally {
      setChanging(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters long");
      return;
    }

    setChanging(true);
    try {
      await changePassword(currentPassword, newPassword);
      await refreshUser();
      toast({ title: "Password changed successfully" });
      setCurrentPasswordValue("");
      setNewPasswordValue("");
      setConfirmPasswordValue("");
    } catch (err: any) {
      setError(err.message || "Failed to change password");
    } finally {
      setChanging(false);
    }
  };

  if (loading) {
    return <div className="container mx-auto p-6 max-w-3xl">Loading...</div>;
  }

  if (!user) {
    navigate("/login?redirect=/settings/security");
    return null;
  }

  return (
    <div className="container mx-auto p-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Security Settings</CardTitle>
          <CardDescription>
            {isOAuthOnly && "Set a password to enable email/password login in addition to Google."}
            {hasPassword && "Change your account password."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm mb-4">
              {error}
            </div>
          )}

          {isOAuthOnly && (
            <form className="space-y-4" onSubmit={handleSetPassword}>
              <div className="space-y-2">
                <Label htmlFor="newPassword">New Password</Label>
                <Input
                  id="newPassword"
                  type="password"
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={(e) => setNewPasswordValue(e.target.value)}
                  disabled={changing}
                  required
                  minLength={8}
                />
                <p className="text-xs text-muted-foreground">Must be at least 8 characters</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPasswordValue(e.target.value)}
                  disabled={changing}
                  required
                  minLength={8}
                />
              </div>

              <Button type="submit" disabled={changing}>
                {changing ? "Setting Password..." : "Set Password"}
              </Button>

              <p className="text-sm text-muted-foreground">
                After setting a password, you'll be able to log in with either Google or your email and password.
              </p>
            </form>
          )}

          {hasPassword && (
            <form className="space-y-4" onSubmit={handleChangePassword}>
              <div className="space-y-2">
                <Label htmlFor="currentPassword">Current Password</Label>
                <Input
                  id="currentPassword"
                  type="password"
                  placeholder="••••••••"
                  value={currentPassword}
                  onChange={(e) => setCurrentPasswordValue(e.target.value)}
                  disabled={changing}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="newPasswordChange">New Password</Label>
                <Input
                  id="newPasswordChange"
                  type="password"
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={(e) => setNewPasswordValue(e.target.value)}
                  disabled={changing}
                  required
                  minLength={8}
                />
                <p className="text-xs text-muted-foreground">Must be at least 8 characters</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPasswordChange">Confirm New Password</Label>
                <Input
                  id="confirmPasswordChange"
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPasswordValue(e.target.value)}
                  disabled={changing}
                  required
                  minLength={8}
                />
              </div>

              <Button type="submit" disabled={changing}>
                {changing ? "Changing Password..." : "Change Password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
