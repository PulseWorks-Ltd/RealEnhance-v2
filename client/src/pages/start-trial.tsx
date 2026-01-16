import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

export default function StartTrial() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { refreshUser } = useAuth();

  const [agencyName, setAgencyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agencyName.trim() || !email.trim() || !password.trim() || !promoCode.trim()) {
      toast({ title: "Missing details", description: "Please fill in all fields.", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch("/api/trial/start", {
        method: "POST",
        body: JSON.stringify({ agencyName: agencyName.trim(), email: email.trim(), password, promoCode: promoCode.trim() })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data?.error || "Failed to start trial";
        toast({ title: "Could not start trial", description: msg, variant: "destructive" });
        setLoading(false);
        return;
      }

      await refreshUser();
      toast({ title: "Trial started", description: "Welcome! Your trial is ready to use." });
      navigate("/settings/billing", { replace: true });
    } catch (err: any) {
      toast({ title: "Error", description: err?.message || "Failed to start trial", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto max-w-xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>Start Promo Trial</CardTitle>
          <CardDescription>Enter your details to create your agency and begin your trial.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="text-sm font-medium">Agency Name</label>
              <Input
                required
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
                placeholder="My Agency"
                className="mt-2"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Work Email</label>
              <Input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-2"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Password</label>
              <Input
                required
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Create a password"
                className="mt-2"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Promo Code</label>
              <Input
                required
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                placeholder="Enter your promo code"
                className="mt-2"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Starting..." : "Start Trial"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
