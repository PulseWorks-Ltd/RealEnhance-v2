// client/src/pages/landing.tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/context/AuthContext";

export default function Landing() {
  const { ensureSignedIn } = useAuth();

  return (
    <div className="relative min-h-[calc(100vh-4rem)] overflow-hidden">
      {/* Soft brand gradient background */}
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-brand-primary/90 via-brand-primary/75 to-brand-accent/80" />
      {/* Subtle vignette to improve contrast over the gradient */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.08),transparent_60%)]" />

      <main className="container mx-auto px-4 py-16">
        {/* Hero */}
        <div className="text-center mb-20">
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-white drop-shadow-sm mb-4">
            Polish Your Photos with AI
          </h1>
          <p className="text-base md:text-xl text-white/85 max-w-2xl mx-auto mb-8">
            Transform your images with professional-grade enhancement and optional virtual staging.
            Get started with 5 free credits when you sign up.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button
              onClick={() => ensureSignedIn()}
              size="lg"
              variant="brand"
              className="px-7 py-4 text-base md:text-lg shadow-sm"
              data-testid="button-login"
            >
              Get Started — Sign In
            </Button>

            {/* asChild anchor wrapped inline to avoid whitespace */}
            <Button
              variant="outline"
              size="lg"
              className="border-white/70 text-white hover:bg-white/10"
              asChild
            ><a href="/home">Open App</a></Button>
          </div>

          <div className="mt-4">
            <span className="inline-flex items-center gap-2 rounded-full bg-brand-highlight text-white px-3 py-1 text-xs font-medium shadow-sm">
              Limited Offer
            </span>
            <p className="mt-3 text-xs text-white/80">
              No credit card required • Keep originals safe • Fast downloads
            </p>
          </div>
        </div>

        {/* Features */}
        <div id="features" className="grid md:grid-cols-3 gap-6 md:gap-8 max-w-6xl mx-auto">
          <Card className="shadow-sm">
            <CardContent className="p-6 text-center">
              <div className="w-14 h-14 md:w-16 md:h-16 bg-brand-light rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-xl md:text-2xl">✨</span>
              </div>
              <h3 className="text-lg md:text-xl font-semibold mb-2">One‑click Polish</h3>
              <p className="text-sm md:text-base text-muted-foreground">
                Clean lighting, white balance, and distortion for a crisp editorial look.
              </p>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardContent className="p-6 text-center">
              <div className="w-14 h-14 md:w-16 md:h-16 bg-brand-light rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-xl md:text-2xl">🏠</span>
              </div>
              <h3 className="text-lg md:text-xl font-semibold mb-2">Virtual Staging</h3>
              <p className="text-sm md:text-base text-muted-foreground">
                Tasteful, window‑aware furniture placement—no covering doors or key features.
              </p>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardContent className="p-6 text-center">
              <div className="w-14 h-14 md:w-16 md:h-16 bg-brand-light rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-xl md:text-2xl">⚡</span>
              </div>
              <h3 className="text-lg md:text-xl font-semibold mb-2">Batch Speed</h3>
              <p className="text-sm md:text-base text-muted-foreground">
                Upload sets and export consistently sized, MLS‑friendly results fast.
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
