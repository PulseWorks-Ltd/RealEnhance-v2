// client/src/pages/home.tsx
import BatchProcessor from "@/components/batch-processor";
import { CreditPacks } from "@/components/credit-packs";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground" data-testid="home-page">
      {/* Brand hero backdrop */}
      <div className="bg-gradient-to-b from-brand-light/70 to-transparent">
      <main className="container mx-auto px-4 py-8 max-w-6xl">
        {/* Hero Section */}
        <section className="mb-8 text-center" data-testid="hero-section">
          <img
            src="/logo.svg"
            alt="RealEnhance"
            className="w-32 mx-auto mb-4 rounded-lg object-contain"
          />
          <h2 className="text-4xl font-bold mb-4">
            Transform Your Photos with{" "}
            <span className="bg-gradient-to-r from-brand-primary to-brand-accent bg-clip-text text-transparent relative">
            AI Magic
           <span className="absolute -top-1 -right-1 text-yellow-300 text-lg">✨</span>
          </span>
          </h2>
          <p className="text-muted-foreground text-lg mb-8 max-w-2xl mx-auto">
            Upload your images and let our AI enhance them with professional-quality
            improvements. Perfect for real estate and professional photography.
          </p>
        </section> 

        {/* Batch Processor - Main Interface */}
        <BatchProcessor />

        {/* Credit Packs */}
        <div className="mt-24 pt-12 border-t border-border/50">
          <CreditPacks />
        </div>
  </main>
  </div>
 
      {/* Footer */}
      <footer className="border-t border-border bg-card/50 mt-16" data-testid="footer">
        <div className="container mx-auto px-4 py-8">
          <div className="grid md:grid-cols-4 gap-6">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <img
                  src="/logo.svg"
                  alt="RealEnhance"
                  className="w-8 h-8 rounded-lg object-contain"
                />
                <h4 className="font-semibold bg-gradient-to-r from-brand-primary to-brand-accent bg-clip-text text-transparent">
                  RealEnhance
               </h4>
              </div>
              <p className="text-muted-foreground text-sm">
                AI-powered photo enhancement for professionals and businesses.
              </p>
            </div>

            <div>
              <h5 className="font-semibold mb-3">Features</h5>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>AI Enhancement</li>
                <li>Free Smart Refining</li>
                <li>Professional Presets</li>
                <li>Before/After Comparison</li>
              </ul>
            </div>

            <div>
              <h5 className="font-semibold mb-3">Support</h5>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><a href="#" className="hover:text-brand-primary"> Center</a></li>
                <li><a href="#" className="hover:text-brand-primary">Contact Us</a></li>
                <li><a href="#" className="hover:text-brand-primary">API Docs</a></li>
                <li><a href="#" className="hover:text-brand-primary">Status</a></li>
              </ul>
            </div>

            <div>
              <h5 className="font-semibold mb-3">Legal</h5>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><a href="#" className="hover:text-brand-primary">Privacy Policy</a></li>
                <li><a href="#" className="hover:text-brand-primary">Terms of Service</a></li>
                <li><a href="#" className="hover:text-brand-primary">Cookie Policy</a></li>
              </ul>
            </div>
          </div>

          <div className="border-t border-border pt-6 mt-6 text-center">
            <p className="text-muted-foreground text-sm mb-2">
              © 2024 RealEnhance. All rights reserved.
            </p>
            <p className="text-muted-foreground text-xs">
              All edited images include Google’s invisible SynthID watermark for authenticity verification.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
