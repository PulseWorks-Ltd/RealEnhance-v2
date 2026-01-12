import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuth } from "@/context/AuthContext";
import { useNavigate } from "react-router-dom";

interface AuthUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  credits: number;
}

export function ProfileDropdown() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  const authUser = user as AuthUser;
  const email = authUser.email || 'User';
  const displayName = (authUser as any).displayName || `${authUser.firstName || ''} ${authUser.lastName || ''}`.trim() || email;

  // Better user display: handle edge cases more gracefully
  const initial = (authUser.firstName || authUser.lastName || email || "?").trim()[0]?.toUpperCase() ?? "U";
  const initials = authUser.firstName && authUser.lastName
    ? `${authUser.firstName[0]}${authUser.lastName[0]}`.toUpperCase()
    : initial;

  const handleSignOut = async () => {
    await signOut();
  };

  const handleAgencySettings = () => {
    navigate("/agency");
  };

  const handleProfile = () => {
    navigate("/settings/profile");
  };

  const handleEnhancedHistory = () => {
    navigate("/enhanced-history");
  };

  const handleChangePassword = () => {
    navigate("/change-password");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="button-profile">
        <Avatar className="h-8 w-8 cursor-pointer">
          <AvatarImage src={authUser.profileImageUrl || ""} />
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>{displayName || email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleEnhancedHistory} data-testid="button-enhanced-history">
          📸 Enhanced History
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleProfile} data-testid="button-profile-settings">
          👤 Profile Settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleChangePassword} data-testid="button-change-password">
          🔒 Change Password
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleAgencySettings} data-testid="button-agency-settings">
          🏢 Agency Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut} data-testid="button-signout">
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}