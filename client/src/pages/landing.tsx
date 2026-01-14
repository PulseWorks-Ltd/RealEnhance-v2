import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import { ShieldCheck, Sofa, Zap, CheckCircle, Upload, ArrowRight } from 'lucide-react';
import { Button } from "@/components/ui/button";

export default function Landing() {
  return (
    <div className="min-h-screen bg-white font-sans text-slate-600">
      
      {/* 1. HERO SECTION */}
      <section className="bg-white py-20 lg:py-24">
        <div className="container mx-auto px-4 grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          
          {/* Left Col (Copy) */}
          <div className="space-y-8">
            <h1 className="text-4xl lg:text-5xl font-serif font-bold text-slate-900 leading-tight">
              Professional real estate photos — without risking misrepresentation.
            </h1>
            <p className="text-lg lg:text-xl text-slate-600 leading-relaxed max-w-lg">
              Enhance lighting, clarity, and presentation with optional virtual staging that never alters structure, windows, or doors.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4">
               <a href="/login">
                <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white px-8 h-12 text-base shadow-lg transition-all rounded-md">
                  Enhance Your Photos - Free Trial
                </Button>
               </a>
            </div>

            <div className="flex flex-col gap-3 pt-2">
              {[
                "Structural-safe enhancement",
                "Validator-enforced compliance",
                "Originals always preserved"
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-slate-500 font-medium">
                  <CheckCircle className="w-4 h-4 text-emerald-600" />
                  {item}
                </div>
              ))}
            </div>
          </div>

          {/* Right Col (Visual) */}
          <div className="relative">
            <div className="relative rounded-xl overflow-hidden shadow-2xl border-4 border-slate-100 bg-slate-100 aspect-[4/3]">
               <ReactCompareSlider
                itemOne={<ReactCompareSliderImage src="https://placehold.co/800x600/243b53/ffffff?text=Original+Photo" alt="Before" />}
                itemTwo={<ReactCompareSliderImage src="https://placehold.co/800x600/e2e8f0/1e293b?text=Enhanced+Result" alt="After" />}
              />
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur px-4 py-1.5 rounded-full text-xs font-semibold text-slate-700 shadow-sm border border-slate-200 z-10 pointer-events-none">
                Interactive Comparison Demo
              </div>
            </div>
            {/* Decorative element */}
            <div className="absolute -z-10 -bottom-10 -right-10 w-64 h-64 bg-slate-50 rounded-full blur-3xl opacity-60"></div>
          </div>
        </div>
      </section>

      {/* 2. THE "WHY REALENHANCE" (Value Props) */}
      <section className="bg-slate-50 py-20">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: ShieldCheck,
                title: "Structural Protection",
                text: "Every image is checked by structural validators to ensure walls, doors, and room geometry remain unchanged."
              },
              {
                icon: Sofa,
                title: "Listing-Safe Staging",
                text: "Furniture is added intelligently — never covering doors, windows, or architectural features."
              },
              {
                icon: Zap,
                title: "Batch Processing",
                text: "Upload entire listings and receive MLS-ready images in minutes."
              }
            ].map((card, i) => (
              <div key={i} className="bg-white p-8 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow">
                <div className="w-12 h-12 bg-slate-50 rounded-lg flex items-center justify-center mb-6">
                  <card.icon className="w-6 h-6 text-slate-700" />
                </div>
                <h3 className="text-xl font-serif font-semibold text-slate-900 mb-3">{card.title}</h3>
                <p className="text-slate-600 leading-relaxed">{card.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 3. HOW IT WORKS (The "Validator" Logic) */}
      <section className="bg-white py-24">
        <div className="container mx-auto px-4 text-center max-w-4xl">
          <h2 className="text-3xl lg:text-4xl font-serif font-bold text-slate-900 mb-16">
            How we protect your listings.
          </h2>

          <div className="relative">
             {/* Connector Line (Absolute) */}
             <div className="hidden md:block absolute top-1/2 left-0 right-0 h-0.5 bg-slate-100 -translate-y-1/2 z-0"></div>

             <div className="grid md:grid-cols-4 gap-8 relative z-10">
               {[
                 { step: "1", title: "Upload", icon: Upload },
                 { step: "2", title: "Enhance", icon: Zap },
                 { step: "3", title: "Validator Check", icon: ShieldCheck, highlight: true },
                 { step: "4", title: "Download", icon: CheckCircle }
               ].map((item, i) => (
                 <div key={i} className="flex flex-col items-center">
                   <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 border-4 transition-colors ${
                     item.highlight 
                      ? "bg-white border-amber-500 text-amber-600 shadow-xl scale-110" 
                      : "bg-white border-slate-100 text-slate-400"
                   }`}>
                     <item.icon className={`w-6 h-6 ${item.highlight ? "stroke-[2.5px]" : ""}`} />
                   </div>
                   <h4 className={`text-lg font-semibold ${item.highlight ? "text-amber-600" : "text-slate-900"}`}>
                     {item.title}
                   </h4>
                   {item.highlight && (
                     <p className="text-xs text-amber-700/80 mt-2 font-medium bg-amber-50 px-3 py-1 rounded-full">
                       Moat: Blocks Structural Changes
                     </p>
                   )}
                 </div>
               ))}
             </div>
          </div>
          
          <div className="mt-12 p-6 bg-slate-50 rounded-lg border border-slate-100 inline-block">
             <div className="flex items-start gap-4 text-left max-w-lg mx-auto">
               <ShieldCheck className="w-8 h-8 text-slate-400 flex-shrink-0 mt-0.5" />
               <div>
                  <h5 className="font-semibold text-slate-900 text-sm mb-1">Automatic Compliance Gating</h5>
                  <p className="text-sm text-slate-600">
                    If the system detects a potential structural change (like a moved window or painted-over door), the image is blocked automatically and flagged for review.
                  </p>
               </div>
             </div>
          </div>
        </div>
      </section>

      {/* 4. AUDIENCE SECTION */}
      <section className="bg-slate-900 py-24 text-white">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-3 gap-12 divide-y md:divide-y-0 md:divide-x divide-slate-800">
            <div className="px-4">
              <h3 className="text-2xl font-serif font-medium mb-6 text-emerald-400">Real Estate Agents</h3>
              <ul className="space-y-4">
                <li className="flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
                  <span className="text-slate-300">Listing-ready in minutes</span>
                </li>
                <li className="flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
                  <span className="text-slate-300">Better engagement on MLS</span>
                </li>
              </ul>
            </div>
            
            <div className="px-4 py-8 md:py-0">
              <h3 className="text-2xl font-serif font-medium mb-6 text-emerald-400">Property Managers</h3>
              <ul className="space-y-4">
                <li className="flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
                  <span className="text-slate-300">Tenant-safe presentation</span>
                </li>
                <li className="flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
                  <span className="text-slate-300">Cost-effective decluttering</span>
                </li>
              </ul>
            </div>

            <div className="px-4 pt-8 md:pt-0">
              <h3 className="text-2xl font-serif font-medium mb-6 text-emerald-400">Marketing Agencies</h3>
               <ul className="space-y-4">
                <li className="flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
                  <span className="text-slate-300">Scale without hiring editors</span>
                </li>
                <li className="flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
                  <span className="text-slate-300">Consistent brand quality</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* 5. FINAL CTA */}
      <section className="bg-white py-24 text-center">
        <div className="container mx-auto px-4 max-w-3xl">
          <h2 className="text-4xl lg:text-5xl font-serif font-bold text-slate-900 mb-8 leading-tight">
            Ready to enhance your listings — safely?
          </h2>
          <div className="flex flex-col items-center gap-4">
            <a href="/login">
              <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white px-10 h-14 text-lg shadow-xl hover:-translate-y-0.5 transition-all rounded-md">
                Start Enhancing Now
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </a>
            <p className="text-sm text-slate-500 mt-4">
               No credit card required · Originals preserved · 5 Free Credits
            </p>
          </div>
        </div>
      </section>
      
    </div>
  );
}
