// Replit Auth integration - based on javascript_log_in_with_replit blueprint
import { useQuery, useQueryClient } from "@tanstack/react-query";

export function useAuth() {
  const queryClient = useQueryClient();
  
  const { data: user, isLoading } = useQuery({
    queryKey: ["/api/auth/user"],
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    staleTime: 0, // Always refetch to ensure fresh auth state
  });

  const refreshUser = async () => {
    await queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
  };

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    refreshUser,
  };
}