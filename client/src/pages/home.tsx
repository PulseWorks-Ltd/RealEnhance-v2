// client/src/pages/home.tsx
import BatchProcessor from "@/components/batch-processor";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

export default function Home() {
  const { user, markWelcomeSeen } = useAuth();
  const { toast } = useToast();
  const [dismissingWelcome, setDismissingWelcome] = useState(false);
  const [resendingVerification, setResendingVerification] = useState(false);
  const [hasSelectedImages, setHasSelectedImages] = useState(false);
  const [allowContentScroll, setAllowContentScroll] = useState(false);
  const [agencyOnboarding, setAgencyOnboarding] = useState<{
    promoCreditsGranted: boolean;
  } | null>(null);

  const isAgencyOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";
  const shouldShowWelcome = !!user
    && user.hasSeenWelcome === false
    && isAgencyOwnerOrAdmin
    && agencyOnboarding?.promoCreditsGranted === true;
  const isUnverified = !!user && user.emailVerified !== true;

  useEffect(() => {
    let cancelled = false;

    const loadAgencyOnboarding = async () => {
      if (!user?.agencyId || !(user.role === "owner" || user.role === "admin")) {
        setAgencyOnboarding(null);
        return;
      }

      try {
        const res = await apiFetch("/api/agency/info");
        if (!res.ok) {
          if (!cancelled) setAgencyOnboarding(null);
          return;
        }

        const data = await res.json();
        if (!cancelled) {
          setAgencyOnboarding({
            promoCreditsGranted: data?.agency?.promoCreditsGranted === true,
          });
        }
      } catch {
        if (!cancelled) setAgencyOnboarding(null);
      }
    };

    loadAgencyOnboarding();
    return () => {
      cancelled = true;
    };
  }, [user?.agencyId, user?.role]);

  const dismissWelcome = async () => {
    try {
      setDismissingWelcome(true);
      await markWelcomeSeen();
    } finally {
      setDismissingWelcome(false);
    }
  };

  const resendVerification = async () => {
    try {
      setResendingVerification(true);
      const res = await apiFetch("/api/auth/resend-verification", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to resend verification email");
      }
      toast({
        title: "Verification Email Sent",
        description: "Please check your inbox for a new verification link.",
      });
    } catch (err: any) {
      toast({
        title: "Unable to Resend",
        description: err?.message || "Could not resend verification email right now.",
        variant: "destructive",
      });
    } finally {
      setResendingVerification(false);
    }
  };

  return (
    <div
      className={`w-full h-full min-h-0 flex flex-col ${allowContentScroll ? "overflow-y-auto" : "overflow-hidden"}`}
      data-testid="home-page"
    >
      {shouldShowWelcome && (
        <Card className="mx-auto mb-3 w-full max-w-4xl border-emerald-200 bg-emerald-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg text-emerald-900">Welcome to RealEnhance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-emerald-900">
              Your account includes 20 free image enhancements.
            </p>
            <p className="text-sm text-emerald-800">Upload your first property photo to start.</p>
            <div className="flex gap-2">
              <Button onClick={dismissWelcome} disabled={dismissingWelcome}>
                Upload Your First Image
              </Button>
              <Button variant="outline" onClick={dismissWelcome} disabled={dismissingWelcome}>
                Skip
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isUnverified && (
        <div className="mx-auto mb-2 w-full max-w-4xl px-4 sm:px-6 lg:px-8">
          <Alert>
            <AlertDescription>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div>Please verify your email to enable downloads and billing features.</div>
                  <div className="text-xs text-slate-600 mt-1">
                    Didn&apos;t receive the verification email?
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={resendVerification} disabled={resendingVerification}>
                  {resendingVerification ? "Sending..." : "Resend verification email"}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        </div>
      )}

      {!hasSelectedImages && (
      <div className="mx-auto pt-2 pb-0 mb-2 max-w-4xl px-4 text-center sm:px-6 lg:px-8 shrink-0">
        <h1 className="bg-gradient-to-b from-slate-900 to-slate-700 bg-clip-text text-lg sm:text-xl font-extrabold tracking-tight text-transparent">
          Turn Every Listing into a Show-Home
        </h1>
        <p className="mt-1 text-sm text-slate-500 hidden sm:block">
          Transform your full property gallery into market-ready assets in under 2 minutes
        </p>
      </div>
      )}
      
      {/* Batch Processor - Main Interface */}
      <div className="flex-1 min-h-0 relative">
        <BatchProcessor
          onFilesSelectedChange={setHasSelectedImages}
          onScrollStateChange={setAllowContentScroll}
        />
      </div>
    </div>
  );
}
