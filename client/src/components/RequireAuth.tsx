import { useAuthGuard } from "@/hooks/useAuthGuard";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isReady, isAuthed, redirectToLogin } = useAuthGuard();

  if (!isReady)
    return (
      <div className="p-8 text-center text-muted-foreground">
        Checking your session…
      </div>
    );

  if (!isAuthed) {
    redirectToLogin();
    return (
      <div className="p-8 text-center text-muted-foreground">
        Redirecting to sign in…
      </div>
    );
  }

  return <>{children}</>;
}
