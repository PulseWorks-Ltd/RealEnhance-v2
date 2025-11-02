// client/src/pages/landing.tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/context/AuthContext";

export default function Landing() {
  const { ensureSignedIn } = useAuth();

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-gradient-to-br from-brand-primary to-brand-accent dark:from-purple-900 dark:to-blue-900">
      <main className="container mx-auto px-4 py-16">
        {/* Hero */}
        <div className="text-center mb-16">
          <h1 className="text-5xl font-bold mb-6 bg-gradient-to-r from-brand-primary to-brand-accent bg-clip-text text-transparent">
            Polish Your Photos with AI
          </h1>
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Transform your images with professional-grade enhancement and optional virtual staging.
            Get started with 5 free credits when you sign up.
          </p>

          <div className="flex items-center justify-center gap-3">
            <Button
              onClick={() => ensureSignedIn()}
              size="lg"
              className="bg-gradient-to-r from-brand-primary to-brand-accent text-white px-8 py-4 text-lg hover:opacity-90"
              data-testid="button-login"
            >
             Get Started — Sign In
            </Button>

            {/* Radix Slot requires exactly one element child with no surrounding whitespace */}
            <Button variant="outline" size="lg" asChild><a href="/app">Open App</a></Button>
          </div>

          <Button className="bg-brand-highlight text-white hover:brightness-110">
           Limited Offer
          </Button>

          <p className="mt-3 text-xs text-neutral-600">
            No credit card required • Keep originals safe • Fast downloads
          </p>
        </div>

        {/* Features */}
        <div id="features" className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          <Card>
            <CardContent className="p-6 text-center">
              <div className="w-16 h-16 bg-purple-100 dark:bg-purple-900 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-2xl">✨</span>
              </div>
              <h3 className="text-xl font-semibold mb-3">One-click Polish</h3>
              <p className="text-muted-foreground">
                Clean lighting, white balance, and distortion for a crisp editorial look.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6 text-center">
              <div className="w-16 h-16 bg-brand-light dark:bg-blue-900 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-2xl">🏠</span>
              </div>
              <h3 className="text-xl font-semibold mb-3">Virtual Staging</h3>
              <p className="text-muted-foreground">
                Tasteful, window-aware furniture placement—no covering doors or key features.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6 text-center">
              <div className="w-16 h-16 bg-brand-accent dark:bg-brand-accent rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-2xl">⚡</span>
              </div>
              <h3 className="text-xl font-semibold mb-3">Batch Speed</h3>
              <p className="text-muted-foreground">
                Upload sets and export consistently sized, MLS-friendly results fast.
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
