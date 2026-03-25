import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import { ShieldCheck, Sofa, Zap, CheckCircle, Upload, ArrowRight } from 'lucide-react';
import { Button } from "@/components/ui/button";

export default function Landing() {
  const sampleImages = [
    {
      type: 'bedroom',
      label: 'Stage Empty Rooms',
      gradient: 'from-blue-500 to-violet-600',
      description: 'From empty room to inviting, buyer-ready space. We add realistic furnishings and styling while preserving the room’s true layout and proportions.',
      beforeSrc: '/landing-samples/bedroom-example-baseline.png',
      afterSrc: '/landing-samples/bedroom-example-enhanced.png',
    },
    {
      type: 'lounge',
      label: 'Lighting & Mood Enhancement',
      gradient: 'from-emerald-500 to-teal-600',
      description: 'See how an empty space becomes a warm, livable living area. Furniture, layout, and styling are added naturally—without altering the structure of the room.',
      beforeSrc: '/landing-samples/lounge-example-baseline.png',
      afterSrc: '/landing-samples/lounge-example-enhanced.jpg',
    },
    {
      type: 'messy-living-room',
      label: 'Declutter & Restyle',
      gradient: 'from-orange-500 to-rose-600',
      description: 'Transform cluttered spaces into clean, market-ready rooms. We remove distractions and enhance the space so buyers can clearly see its potential.',
      beforeSrc: '/landing-samples/messy-living-room.png',
      afterSrc: '/landing-samples/messy-living-room-enhanced.png',
    },
  ] as const;

  return (
    <div className="min-h-screen bg-white font-sans text-slate-600">
      
      {/* 1. HERO SECTION */}
      <section className="bg-white py-20 lg:py-24">
        <div className="w-full px-4 sm:px-6 lg:px-10 grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          
          {/* Left Col (Copy) */}
          <div className="space-y-8">
            <h1 className="text-4xl lg:text-5xl font-serif font-bold text-slate-900 leading-tight">
              Professional real estate photos — without risking misrepresentation.
            </h1>
            <p className="text-lg lg:text-xl text-slate-600 leading-relaxed max-w-lg">
              Enhance lighting, clarity, and presentation—while preserving walls, windows, and true room structure.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4">
               <a href="/login">
                <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white px-8 h-12 text-base shadow-lg transition-all rounded-md">
                  Enhance Your Listing Photos — Free
                </Button>
               </a>
            </div>
            <p className="text-xs text-slate-500 mt-3">
              No credit card required • Originals always preserved
            </p>

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
                itemOne={<ReactCompareSliderImage src="/landing-samples/example-exterior-image-01.jpg" alt="Example Exterior Image 01 before enhancement" className="object-cover object-[center_72%]" />}
                itemTwo={<ReactCompareSliderImage src="/landing-samples/example-exterior-image-01-enhanced.jpg" alt="Example Exterior Image 01 enhanced result" className="object-cover object-[center_72%]" />}
              />
              <div className="absolute top-3 left-3 bg-white/80 backdrop-blur px-3 py-1 text-xs font-medium rounded-full shadow-sm pointer-events-none z-10">
                Original
              </div>
              <div className="absolute top-3 right-3 bg-emerald-600 text-white px-3 py-1 text-xs font-medium rounded-full shadow-sm pointer-events-none z-10">
                Enhanced
              </div>
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-xs text-white/80 bg-black/40 px-2 py-1 rounded-md backdrop-blur pointer-events-none z-10">
                Drag to compare
              </div>
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur px-4 py-1.5 rounded-full text-xs font-semibold text-slate-700 shadow-sm border border-slate-200 z-10 pointer-events-none">
                Live Before & After Demo
              </div>
            </div>
            {/* Decorative element */}
            <div className="absolute -z-10 -bottom-10 -right-10 w-64 h-64 bg-slate-50 rounded-full blur-3xl opacity-60"></div>
          </div>
        </div>
      </section>

      {/* 2. SAMPLE GALLERY */}
      <section className="bg-white pb-14 mt-16">
        <div className="w-full px-4 sm:px-6 lg:px-10">
          <div className="text-center space-y-2 mb-8">
            <h2 className="text-2xl lg:text-3xl font-serif font-semibold text-slate-900">
              Before & After: Real Listing Enhancements
            </h2>
            <p className="text-slate-600">
              Real examples of enhancements applied to actual listing photos. See how lighting, clarity, and presentation improve—without altering structure.
            </p>
            <p className="text-sm text-slate-500 mt-2">
              Click any example to try it with your own photos →
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-6">
            {sampleImages.map((sample) => (
              <a
                key={sample.type}
                href="/login"
                className="group relative overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 shadow-sm hover:shadow-lg transition-all duration-200 hover:scale-[1.03]"
              >
                <div className="relative h-96 bg-slate-100">
                  <ReactCompareSlider
                    itemOne={<ReactCompareSliderImage src={sample.beforeSrc} alt={`${sample.label} before`} className={sample.type === 'messy-living-room' ? "object-contain [clip-path:inset(7%_0_7%_0)]" : "object-contain"} />}
                    itemTwo={<ReactCompareSliderImage src={sample.afterSrc} alt={`${sample.label} after`} className="object-contain" />}
                  />
                  <div className="absolute top-3 left-3 bg-white/80 backdrop-blur px-3 py-1 text-xs font-medium rounded-full shadow-sm pointer-events-none z-10">
                    Original
                  </div>
                  <div className="absolute top-3 right-3 bg-emerald-600 text-white px-3 py-1 text-xs font-medium rounded-full shadow-sm pointer-events-none z-10">
                    Enhanced
                  </div>
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-xs text-white/80 bg-black/40 px-2 py-1 rounded-md backdrop-blur pointer-events-none">
                    Drag to compare
                  </div>
                </div>

                <div className="relative p-5 bg-white">
                  <div className="space-y-1 text-center">
                    <div className="font-bold text-slate-900 text-lg">{sample.label}</div>
                    <div className="text-xs text-slate-500">{sample.description}</div>
                  </div>

                  <div className="mt-3 opacity-0 group-hover:opacity-100 transition-all duration-300 transform group-hover:translate-y-0 translate-y-2">
                    <div className={`inline-flex items-center justify-center gap-1.5 w-full py-2 px-3 rounded-lg text-xs font-bold uppercase tracking-wide bg-gradient-to-r ${sample.gradient} text-white shadow-md`}>
                      Try Demo
                      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    </div>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      <p className="text-center text-slate-500 mt-6 max-w-xl mx-auto px-4">
        Built for real estate professionals who need fast, compliant, listing-ready images.
      </p>

      {/* 3. THE "WHY REALENHANCE" (Value Props) */}
      <section className="bg-slate-50 py-20">
        <div className="w-full px-4 sm:px-6 lg:px-10">
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: ShieldCheck,
                title: "Structural Protection",
                text: "Every image is checked to ensure walls, windows, and layout remain unchanged."
              },
              {
                icon: Sofa,
                title: "Listing-Safe Staging",
                text: "Furniture is added naturally—never covering doors, windows, or fixed features."
              },
              {
                icon: Zap,
                title: "Batch Processing",
                text: "Enhance entire listings in minutes with consistent, MLS-ready results."
              }
            ].map((card, i) => (
              <div key={i} className="p-6 rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow-md hover:border-emerald-200 hover:translate-y-[-2px] transition-all grid grid-cols-[auto,1fr] items-center gap-x-5 gap-y-1">
                <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0 row-span-2">
                  <card.icon className="w-6 h-6 text-emerald-600" />
                </div>
                <h3 className="text-base font-semibold text-slate-900">{card.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{card.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 4. HOW IT WORKS (The "Validator" Logic) */}
      <section className="bg-white py-24">
        <div className="w-full px-4 sm:px-6 lg:px-10 text-center">
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
                        ? "bg-white border-emerald-500 text-emerald-600 shadow-xl scale-110" 
                      : "bg-white border-slate-100 text-slate-400"
                   }`}>
                     <item.icon className={`w-6 h-6 ${item.highlight ? "stroke-[2.5px]" : ""}`} />
                   </div>
                     <h4 className={`text-lg ${item.highlight ? "text-emerald-700 font-semibold" : "text-slate-900 font-medium"}`}>
                     {item.title}
                   </h4>
                   {item.highlight && (
                       <span className="text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded-full mt-2">
                         Blocks structural changes
                       </span>
                   )}
                 </div>
               ))}
             </div>
          </div>
          
            <div className="mt-6 bg-white border border-slate-200 rounded-xl shadow-sm p-4 max-w-md mx-auto">
               <div className="flex items-start gap-4 text-left">
               <ShieldCheck className="w-8 h-8 text-slate-400 flex-shrink-0 mt-0.5" />
               <div>
                  <h5 className="font-semibold text-slate-900 text-sm mb-1">Automatic Compliance Gating</h5>
                    <p className="text-sm text-slate-600 leading-relaxed">
                    If the system detects a potential structural change (like a moved window or painted-over door), the image is blocked automatically and flagged for review.
                  </p>
               </div>
             </div>
          </div>
        </div>
      </section>

      {/* 5. AUDIENCE SECTION */}
      <section className="bg-slate-900 py-24 text-white">
        <div className="w-full px-4 sm:px-6 lg:px-10">
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

      {/* 6. FINAL CTA */}
      <section className="bg-white py-24 text-center">
        <div className="container mx-auto px-4 max-w-3xl">
          <h2 className="text-4xl lg:text-5xl font-serif font-bold text-slate-900 mb-8 leading-tight">
            Start enhancing your listings—without risk
          </h2>
          <div className="flex flex-col items-center gap-4">
            <a href="/login">
              <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white px-10 h-14 text-lg shadow-xl hover:-translate-y-0.5 transition-all rounded-md">
                Start Free Enhancement
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
