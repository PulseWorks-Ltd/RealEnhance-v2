import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";

const heroImage =
  "https://images.unsplash.com/photo-1505691938895-1758d7feb511?auto=format&fit=crop&w=1800&q=80"; // Replace with approved RealEnhance hero image when available

export default function Signup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [inviteInfo, setInviteInfo] = useState<{ email: string; agencyName: string } | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const { signUpWithEmail, ensureSignedIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/home";
  const inviteToken = searchParams.get("token");

  // Load invite info if token present
  useEffect(() => {
    if (inviteToken) {
      loadInviteInfo();
    }
  }, [inviteToken]);

  const loadInviteInfo = async () => {
    try {
      const res = await apiFetch(`/api/agency/invite/info?token=${inviteToken}`);
      if (res.ok) {
        const data = await res.json();
        setInviteInfo({ email: data.email, agencyName: data.agencyName });
        setEmail(data.email); // Pre-fill email
      }
    } catch (err) {
      console.error("Failed to load invite info:", err);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setError("");

    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required");
      return;
    }

    if (!email.trim()) {
      setError("Email is required");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);

    try {
      // If invite token present, use invite signup flow
      if (inviteToken) {
        const res = await apiFetch("/api/agency/invite/accept", {
          method: "POST",
          body: JSON.stringify({
            token: inviteToken,
            name: `${firstName} ${lastName}`.trim(),
            password,
          }),
        });

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to accept invite");
        }

        // Invite accepted, user created and logged in
        navigate("/home");
      } else {
        // Regular signup flow
        await signUpWithEmail(email, password, firstName.trim(), lastName.trim());
        navigate(redirectTo);
      }
    } catch (err: any) {
      setError(err.message || "Signup failed");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      await ensureSignedIn();
      navigate(redirectTo);
    } catch (err: any) {
      setError(err.message || "Google signup failed");
    }
  };

  const baseInputClasses = useMemo(
    () =>
      "h-11 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 transition",
    []
  );

  const inputTone = (hasError: boolean, isValid: boolean) => {
    if (hasError) {
      return `${baseInputClasses} border-rose-500 text-rose-700 focus:ring-rose-500 focus:border-rose-500`;
    }
    if (isValid) {
      return `${baseInputClasses} border-emerald-500 focus:ring-emerald-500 focus:border-emerald-500`;
    }
    return baseInputClasses;
  };

  const firstNameValid = firstName.trim().length > 1;
  const lastNameValid = lastName.trim().length > 1;
  const emailValid = email.trim().length > 0;
  const passwordValid = password.length >= 8;
  const passwordsMatch = confirmPassword === password && confirmPassword.length > 0;

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-slate-50">
      <div className="hidden md:block md:w-1/2 relative overflow-hidden">
        <img
          src={heroImage}
          alt="Modern living room staged for premium listing"
          className="absolute inset-0 h-full w-full object-cover ken-burns"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
        <div className="absolute bottom-0 left-0 p-10 space-y-3 text-white max-w-xl">
          <img src="/Logo-light.png" alt="RealEnhance" className="h-10 w-auto drop-shadow" />
          <div className="space-y-1">
            <p className="text-sm uppercase tracking-[0.3em] text-emerald-200">RealEnhance</p>
            <p className="text-2xl font-semibold leading-snug">Studio-grade real estate photos in minutes.</p>
            <p className="text-sm text-slate-100/80">"The fastest way to elevate listings."</p>
          </div>
        </div>
      </div>

      <div className="w-full md:w-1/2 flex items-center justify-center p-6 sm:p-10 md:p-12 bg-white">
        <div className="w-full max-w-md space-y-8 animate-in fade-in slide-in-from-right-2 duration-300">
          <div className="space-y-3">
            <img src="/Logo-dark.png" alt="RealEnhance" className="h-9 w-auto" />
            <div className="space-y-1">
              <h1 className="text-3xl font-bold text-slate-900">
                {inviteInfo ? "Accept invitation" : "Create your account"}
              </h1>
              <p className="text-sm text-slate-500">
                {inviteInfo ? `Join ${inviteInfo.agencyName} on RealEnhance.` : "Start enhancing your listings in minutes."}
              </p>
            </div>
          </div>

          <Card className="border border-slate-200/70 shadow-2xl backdrop-blur bg-white/95">
            <CardContent className="p-6 space-y-6">
              {inviteInfo && (
                <div className="p-3 rounded-lg bg-emerald-50 text-emerald-800 text-sm border border-emerald-100">
                  <p className="font-semibold">You've been invited to join {inviteInfo.agencyName}</p>
                  <p className="text-xs text-emerald-900/80 mt-1">Create your account to collaborate instantly.</p>
                </div>
              )}

              {error && (
                <div className="p-3 rounded-lg bg-rose-50 text-rose-700 text-sm border border-rose-100" role="alert">
                  {error}
                </div>
              )}

              <form onSubmit={handleEmailSubmit} className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="firstName" className="text-sm font-medium text-slate-700">
                      First Name
                    </Label>
                    <Input
                      id="firstName"
                      type="text"
                      placeholder="Jordan"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      required
                      disabled={loading}
                      className={inputTone(submitted && !firstNameValid, firstNameValid)}
                      aria-invalid={submitted && !firstNameValid}
                    />
                    {submitted && !firstNameValid ? (
                      <p className="text-xs text-rose-600" role="alert">
                        First name is required
                      </p>
                    ) : firstNameValid ? (
                      <p className="text-xs text-emerald-600">Thanks, looks good.</p>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lastName" className="text-sm font-medium text-slate-700">
                      Last Name
                    </Label>
                    <Input
                      id="lastName"
                      type="text"
                      placeholder="Rivera"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      required
                      disabled={loading}
                      className={inputTone(submitted && !lastNameValid, lastNameValid)}
                      aria-invalid={submitted && !lastNameValid}
                    />
                    {submitted && !lastNameValid ? (
                      <p className="text-xs text-rose-600" role="alert">
                        Last name is required
                      </p>
                    ) : lastNameValid ? (
                      <p className="text-xs text-emerald-600">Looks great.</p>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email" className="text-sm font-medium text-slate-700">
                    Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={loading || !!inviteInfo}
                    readOnly={!!inviteInfo}
                    className={inputTone(submitted && !emailValid, emailValid)}
                    aria-invalid={submitted && !emailValid}
                  />
                  {inviteInfo ? (
                    <p className="text-xs text-slate-500">Email provided by your invitation.</p>
                  ) : submitted && !emailValid ? (
                    <p className="text-xs text-rose-600" role="alert">
                      Please enter a valid email
                    </p>
                  ) : emailValid ? (
                    <p className="text-xs text-emerald-600">We'll keep you posted here.</p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password" className="text-sm font-medium text-slate-700">
                    Password
                  </Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    disabled={loading}
                    className={inputTone(submitted && !passwordValid, passwordValid)}
                    aria-invalid={submitted && !passwordValid}
                  />
                  {submitted && !passwordValid ? (
                    <p className="text-xs text-rose-600" role="alert">
                      Must be at least 8 characters
                    </p>
                  ) : passwordValid ? (
                    <p className="text-xs text-emerald-600">Secure password length met.</p>
                  ) : (
                    <p className="text-xs text-slate-500">Use at least 8 characters.</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword" className="text-sm font-medium text-slate-700">
                    Confirm Password
                  </Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={8}
                    disabled={loading}
                    className={inputTone(submitted && !passwordsMatch, passwordsMatch)}
                    aria-invalid={submitted && !passwordsMatch}
                  />
                  {submitted && !passwordsMatch ? (
                    <p className="text-xs text-rose-600" role="alert">
                      Passwords need to match
                    </p>
                  ) : passwordsMatch ? (
                    <p className="text-xs text-emerald-600">Passwords match.</p>
                  ) : null}
                </div>

                <Button
                  type="submit"
                  className="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-lg transition-all shadow-sm"
                  disabled={loading}
                >
                  {loading ? "Creating account..." : "Create account"}
                </Button>

                <p className="text-xs text-slate-500 text-center">
                  Trusted by real estate agencies and photographers.
                </p>
              </form>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-slate-200" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-2 text-slate-400">Or continue with</span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full h-11 bg-white border border-slate-200 hover:bg-slate-50 text-slate-900 rounded-lg shadow-sm"
                  onClick={handleGoogleLogin}
                  disabled={loading}
                >
                  <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      fill="#4285F4"
                    />
                    <path
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      fill="#34A853"
                    />
                    <path
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      fill="#EA4335"
                    />
                  </svg>
                  Continue with Google
                </Button>
              </div>

              <div className="text-center text-sm text-slate-600">
                Already have an account?{" "}
                <a
                  href="/login"
                  className="text-emerald-700 hover:text-emerald-800 font-semibold"
                >
                  Sign in
                </a>
              </div>

              <p className="text-xs text-center text-slate-500">
                Free to get started - no credit card required.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
