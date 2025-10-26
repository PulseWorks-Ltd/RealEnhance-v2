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
import { useLocation } from "wouter";

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
  const [, setLocation] = useLocation();

  if (!user) return null;

  const authUser = user as AuthUser;
  const email = authUser.email || 'User';
  
  // Better user display: handle edge cases more gracefully
  const initial = (authUser.firstName || authUser.lastName || email || "?").trim()[0]?.toUpperCase() ?? "U";
  const initials = authUser.firstName && authUser.lastName 
    ? `${authUser.firstName[0]}${authUser.lastName[0]}`.toUpperCase()
    : initial;

  const handleSignOut = async () => {
    await signOut();
  };

  const handleViewHistory = () => {
    setLocation("/my-photos");
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
        <DropdownMenuLabel>{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleViewHistory} data-testid="button-view-history">
          📸 Previously Enhanced Photos
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut} data-testid="button-signout">
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}