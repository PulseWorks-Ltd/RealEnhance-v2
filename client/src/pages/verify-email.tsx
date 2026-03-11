import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const token = useMemo(() => searchParams.get("token") || "", [searchParams]);

  const [status, setStatus] = useState<"verifying" | "success" | "error">("verifying");
  const [message, setMessage] = useState("Verifying your email address...");

  useEffect(() => {
    const run = async () => {
      if (!token) {
        setStatus("error");
        setMessage("Verification token is missing.");
        return;
      }

      try {
        const res = await apiFetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
          method: "GET",
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "Verification failed");
        }

        setStatus("success");
        setMessage("Your email is verified. Redirecting to your dashboard...");
        await refreshUser();
        setTimeout(() => navigate("/home", { replace: true }), 1200);
      } catch (err: any) {
        setStatus("error");
        setMessage(err?.message || "Verification link is invalid or expired.");
      }
    };

    run();
  }, [token, navigate, refreshUser]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Email Verification</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-600">{message}</p>
          {status === "error" && (
            <Button className="w-full" onClick={() => navigate("/home")}>
              Go to Dashboard
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
