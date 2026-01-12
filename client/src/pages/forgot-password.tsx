import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export default function ForgotPassword() {
  const { requestPasswordReset } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await requestPasswordReset(email.trim());
      setSubmitted(true);
      toast({
        title: "Check your email",
        description: "If an account exists for that email, we've sent a reset link.",
      });
      setTimeout(() => navigate("/login"), 8000);
    } catch (err: any) {
      // Even on error, show the same generic message to avoid enumeration
      setSubmitted(true);
      toast({
        title: "Check your email",
        description: "If an account exists for that email, we've sent a reset link.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-brand-primary/90 via-brand-primary/75 to-brand-accent/80" />
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-center">Reset your password</CardTitle>
          <CardDescription className="text-center">
            Enter your email and we'll send you a reset link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading || submitted}>
              {loading ? "Sending..." : submitted ? "Email sent" : "Send reset link"}
            </Button>
            <div className="text-center text-sm">
              Remembered it? <a href="/login" className="text-primary underline-offset-4 hover:underline">Back to sign in</a>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
