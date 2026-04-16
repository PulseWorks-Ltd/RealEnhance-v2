import { useAuthGuard } from "@/hooks/useAuthGuard";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isReady, isAuthed, authError, redirectToLogin } = useAuthGuard();

  if (!isReady)
    return (
      <div className="p-8 text-center text-muted-foreground">
        Checking your session…
      </div>
    );

  if (!isAuthed) {
    if (authError) {
      return (
        <div className="p-8 text-center text-muted-foreground">
          Unable to verify your session right now. Please retry in a moment.
        </div>
      );
    }

    redirectToLogin();
    return (
      <div className="p-8 text-center text-muted-foreground">
        Redirecting to sign in…
      </div>
    );
  }

  return <>{children}</>;
}
