import { useAuth } from "@/context/AuthContext";

/**
 * Agency membership is now optional.
 * Existing agency users keep their current behavior, and individual users can
 * stay in the product without being redirected to create an agency.
 */
export function RequireAgency({ children }: { children: React.ReactNode }) {
  useAuth();
  return <>{children}</>;
}
