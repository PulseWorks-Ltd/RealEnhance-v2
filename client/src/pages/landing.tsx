import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import {
  ShieldCheck,
  Sofa,
  Zap,
  CheckCircle,
  Upload,
  ArrowRight,
  Sun,
  Crop,
  Trash2,
  CloudSun,
  Wand2,
  Users,
  FileCheck,
  MapPin,
} from 'lucide-react';
import { Button } from "@/components/ui/button";

export default function Landing() {
  const landingSliderImageClassName = 'h-full w-full object-contain object-center';

  // Real before/after pairs shipped with the app — covers 4 of the 5
  // enhancement categories with genuine sample images (no "tilted →
  // straightened" pair exists yet, so that category is represented in the
  // Features grid below instead of faked here with a placeholder).
  const beforeAfterExamples = [
    {
      type: 'exterior-sky',
      label: 'Sky & Weather Improvement',
      gradient: 'from-sky-500 to-blue-600',
      description: 'Grey, overcast skies replaced with clear, bright conditions that show the property at its best — the exterior itself is never altered.',
      beforeSrc: '/landing-samples/example-exterior-image-01.jpg',
      afterSrc: '/landing-samples/example-exterior-image-01-enhanced.jpg',
    },
    {
      type: 'lounge',
      label: 'Lighting & Mood Enhancement',
      gradient: 'from-emerald-500 to-teal-600',
      description: 'Dark, flat rooms become bright, warm, livable spaces. Furniture, layout, and styling are added naturally — without altering the structure of the room.',
      beforeSrc: '/landing-samples/lounge-example-baseline.png',
      afterSrc: '/landing-samples/lounge-example-enhanced.jpg',
    },
    {
      type: 'messy-living-room',
      label: 'Declutter & Restyle',
      gradient: 'from-orange-500 to-rose-600',
      description: 'Cluttered, lived-in spaces become clean, market-ready rooms. We remove distractions so buyers can clearly see the property’s potential.',
      beforeSrc: '/landing-samples/messy-living-room.png',
      afterSrc: '/landing-samples/messy-living-room-enhanced.png',
    },
    {
      type: 'bedroom',
      label: 'Virtual Staging',
      gradient: 'from-blue-500 to-violet-600',
      description: 'From empty room to inviting, buyer-ready space. We add realistic furnishings and styling while preserving the room’s true layout and proportions.',
      beforeSrc: '/landing-samples/bedroom-example-baseline.png',
      afterSrc: '/landing-samples/bedroom-example-enhanced.png',
    },
  ] as const;

  const features = [
    {
      icon: Sun,
      title: 'Lighting & Exposure',
      text: 'Brighten dark rooms, balance harsh sunlight and recover detail in shadows and highlights.',
    },
    {
      icon: Crop,
      title: 'Straighten & Align',
      text: 'Correct tilted shots and vertical distortion so walls and lines look natural.',
    },
    {
      icon: Trash2,
      title: 'Declutter',
      text: 'Remove distracting objects, cables, bins and clutter for cleaner, more appealing images.',
    },
    {
      icon: Sofa,
      title: 'Virtual Staging (Interiors)',
      text: 'Furnish empty rooms with realistic staging so buyers can visualise the space.',
    },
    {
      icon: CloudSun,
      title: 'Sky & Weather Improvement',
      text: 'Replace grey or overcast skies with clear, bright conditions that show the property at its best.',
    },
    {
      icon: Wand2,
      title: 'Overall Quality',
      text: 'Sharpen detail, improve colour and clarity so every image looks professional.',
    },
  ] as const;

  const monthlyPlans = [
    {
      name: 'Starter',
      price: '$149',
      cadence: '/mo',
      coverage: 'Covers ~5–8 listings per month (~75 images)',
      audience: 'Ideal for occasional use',
      highlight: false,
    },
    {
      name: 'Pro',
      price: '$249',
      cadence: '/mo',
      coverage: 'Covers ~8–15 listings per month (~150 images)',
      audience: 'Best for agencies running multiple listings each week',
      highlight: true,
    },
    {
      name: 'Agency',
      price: '$449',
      cadence: '/mo',
      coverage: 'Covers ~15–30 listings per month (~300 images)',
      audience: 'Designed for teams using this across most or all listings',
      highlight: false,
    },
  ] as const;

  const oneOffPacks = [
    { name: 'Hero Pack', images: '7 images', price: '$19' },
    { name: 'Listing Pack', images: '20 images', price: '$49' },
  ] as const;

  const bundles: {
    name: string;
    images: string;
    price: string;
    perImage: string;
    highlight: boolean;
    badge?: string;
  }[] = [
    { name: 'Small Pack', images: '20 images', price: '$49 NZD', perImage: '$2.45 per image', highlight: false },
    { name: 'Standard Pack', images: '50 images', price: '$99 NZD', perImage: '$1.98 per image', highlight: true, badge: 'Best Value' },
    { name: 'Large Pack', images: '100 images', price: '$179 NZD', perImage: '$1.79 per image', highlight: false },
  ];

  const trustPoints = [
    {
      icon: ShieldCheck,
      title: 'REA-aware design',
      text: 'Enhancements preserve true room structure, walls and windows so you stay compliant.',
    },
    {
      icon: FileCheck,
      title: 'Originals always preserved',
      text: 'Your source files are never overwritten.',
    },
    {
      icon: Zap,
      title: 'Fast & simple',
      text: 'No need to pick and choose complex edits. Run full listing batches in one go.',
    },
    {
      icon: Users,
      title: 'Unlimited users',
      text: 'Share access across your agency at no extra cost.',
    },
    {
      icon: MapPin,
      title: 'NZ-focused',
      text: 'Pricing in NZD, support for local agents, and understanding of Trade Me / realestate.co.nz listing standards.',
    },
  ] as const;

  const faqs = [
    {
      q: 'Is my original photo ever overwritten?',
      a: 'No. Your original files are always preserved and can be downloaded or re-processed at any time — RealEnhance only ever works from a copy.',
    },
    {
      q: 'Will RealEnhance change my listing’s structure?',
      a: 'No. Every enhancement is checked by an automatic validator that blocks and flags any image where walls, windows, or the room’s true layout appear to have changed.',
    },
    {
      q: 'Do I need a credit card to start?',
      a: 'No credit card is required. You get 3 free images after sign-up and email confirmation.',
    },
    {
      q: 'What happens if I run out of my monthly image allowance?',
      a: 'You can purchase an additional image bundle at any time — bundle images are used automatically once your monthly allowance is exhausted.',
    },
    {
      q: 'How many people from my agency can use one plan?',
      a: 'Unlimited users are included on every monthly plan at no extra cost.',
    },
    {
      q: 'Is payment secure?',
      a: 'Yes. All payments are processed securely through Stripe — RealEnhance never stores your card details.',
    },
  ] as const;

  return (
    <div className="min-h-screen bg-white font-sans text-slate-600">

      {/* 1. HERO SECTION */}
      <section className="bg-white min-h-[70vh] flex items-center py-12 lg:py-16">
        <div className="max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-5 gap-10 items-center w-full px-6">

          {/* Left Col (Copy) */}
          <div className="lg:col-span-2 max-w-2xl space-y-8">
            <h1 className="text-5xl md:text-6xl font-semibold text-slate-900 leading-tight">
              Professional real estate photos — without risking misrepresentation.
            </h1>
            <p className="text-lg lg:text-xl text-slate-600 leading-relaxed max-w-2xl">
              Enhance lighting, clarity and presentation while preserving walls, windows and true room structure. Built for New Zealand agents who need better photos that stay compliant with REA guidelines.
            </p>

            <div className="flex flex-col sm:flex-row gap-4">
              <a href="/login">
                <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white px-8 h-12 text-base shadow-lg transition-all rounded-md">
                  Enhance Your Listing Photos — Free
                </Button>
              </a>
            </div>
            <p className="text-xs text-slate-500 mt-3">
              No credit card required • 3 free images after sign-up and email confirmation • Originals always preserved
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
          <div className="lg:col-span-3 relative flex items-center justify-center">
            <div className="relative w-full rounded-2xl shadow-xl overflow-hidden border border-slate-200 bg-slate-100">
              <div className="h-[420px] p-4 lg:h-[520px] xl:h-[600px]">
                <ReactCompareSlider
                  className="h-full w-full"
                  itemOne={<ReactCompareSliderImage src="/landing-samples/example-exterior-image-01.jpg" alt="Example Exterior Image 01 before enhancement" className={landingSliderImageClassName} />}
                  itemTwo={<ReactCompareSliderImage src="/landing-samples/example-exterior-image-01-enhanced.jpg" alt="Example Exterior Image 01 enhanced result" className={landingSliderImageClassName} />}
                />
              </div>
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
            <div className="absolute -z-10 -bottom-10 -right-10 w-64 h-64 bg-slate-50 rounded-full blur-3xl opacity-60"></div>
          </div>
        </div>
      </section>

      {/* 2. BEFORE & AFTER SECTION */}
      <section id="examples" className="bg-white pb-14 mt-16 scroll-mt-20">
        <div className="w-full px-4 sm:px-6 lg:px-10">
          <div className="text-center space-y-2 mb-8 max-w-2xl mx-auto">
            <h2 className="text-2xl lg:text-3xl font-serif font-semibold text-slate-900">
              Before & After: Real Listing Enhancements
            </h2>
            <p className="text-slate-600">
              See how RealEnhance transforms everyday property photos into listing-ready images — without changing the structure or layout of the property.
            </p>
            <p className="text-sm text-slate-500 mt-2">
              Click any example to try it with your own photos →
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            {beforeAfterExamples.map((sample) => (
              <a
                key={sample.type}
                href="/login"
                className="group relative overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 shadow-sm hover:shadow-lg transition-all duration-200 hover:scale-[1.03]"
              >
                <div className="relative h-72 bg-slate-100 p-4">
                  <ReactCompareSlider
                    className="h-full w-full"
                    itemOne={<ReactCompareSliderImage src={sample.beforeSrc} alt={`${sample.label} before`} className={landingSliderImageClassName} />}
                    itemTwo={<ReactCompareSliderImage src={sample.afterSrc} alt={`${sample.label} after`} className={landingSliderImageClassName} />}
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
                    <div className="font-bold text-slate-900 text-base">{sample.label}</div>
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

      {/* 3. FEATURES GRID */}
      <section id="features" className="bg-slate-50 py-20 scroll-mt-20">
        <div className="w-full px-4 sm:px-6 lg:px-10">
          <div className="text-center max-w-2xl mx-auto mb-12 space-y-2">
            <h2 className="text-2xl lg:text-3xl font-serif font-semibold text-slate-900">
              Everything your listing photos need — in one place
            </h2>
            <p className="text-slate-600">
              Upload any property photo. RealEnhance improves the image while keeping the true structure of the room or exterior intact.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((card, i) => (
              <div key={i} className="p-6 rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow-md hover:border-emerald-200 hover:translate-y-[-2px] transition-all grid grid-cols-[auto,1fr] items-start gap-x-5 gap-y-2">
                <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0 row-span-2 mt-0.5">
                  <card.icon className="w-6 h-6 text-emerald-600" />
                </div>
                <h3 className="text-base font-semibold text-slate-900">{card.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{card.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 4. HOW IT WORKS */}
      <section className="bg-white py-24">
        <div className="w-full px-4 sm:px-6 lg:px-10 text-center">
          <h2 className="text-3xl lg:text-4xl font-serif font-bold text-slate-900 mb-16">
            Three simple steps
          </h2>

          <div className="relative max-w-4xl mx-auto">
            <div className="hidden md:block absolute top-8 left-0 right-0 h-0.5 bg-slate-100 z-0"></div>

            <div className="grid md:grid-cols-3 gap-10 relative z-10">
              {[
                { step: "1", title: "Upload your original photos", icon: Upload },
                { step: "2", title: "Choose the enhancements you need", icon: Zap },
                { step: "3", title: "Download listing-ready images in minutes", icon: CheckCircle },
              ].map((item, i) => (
                <div key={i} className="flex flex-col items-center">
                  <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 border-4 bg-white border-emerald-100 text-emerald-600">
                    <item.icon className="w-6 h-6" />
                  </div>
                  <h4 className="text-lg text-slate-900 font-medium max-w-[220px]">
                    {item.title}
                  </h4>
                </div>
              ))}
            </div>
          </div>

          <p className="mt-12 text-sm text-slate-500 max-w-md mx-auto">
            Original files are always kept. You stay in full control.
          </p>
        </div>
      </section>

      {/* 5. PRICING SECTION */}
      <section id="pricing" className="bg-slate-50 py-24 scroll-mt-20">
        <div className="w-full px-4 sm:px-6 lg:px-10">
          <div className="text-center max-w-2xl mx-auto mb-14 space-y-2">
            <h2 className="text-2xl lg:text-3xl font-serif font-semibold text-slate-900">
              Simple, transparent pricing for New Zealand agents
            </h2>
            <p className="text-slate-600">
              Choose a monthly plan based on your listing volume, or buy one-off image packs with no subscription required.
            </p>
          </div>

          {/* Monthly Plans */}
          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {monthlyPlans.map((plan) => (
              <div
                key={plan.name}
                className={`relative rounded-2xl border bg-white p-8 flex flex-col ${
                  plan.highlight
                    ? "border-emerald-500 shadow-xl md:-translate-y-2"
                    : "border-slate-200 shadow-sm"
                }`}
              >
                {plan.highlight && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-emerald-600 text-white text-xs font-semibold px-3 py-1 rounded-full shadow-sm">
                    Most Popular
                  </span>
                )}
                <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-4xl font-bold text-slate-900">{plan.price}</span>
                  <span className="text-slate-500 text-sm">{plan.cadence} NZD</span>
                </div>
                <p className="mt-4 text-sm text-slate-700 font-medium">{plan.coverage}</p>
                <p className="mt-1 text-sm text-slate-500">{plan.audience}</p>
                <a href="/login" className="mt-8">
                  <Button
                    className={`w-full ${
                      plan.highlight
                        ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                        : "bg-white border border-slate-300 text-slate-800 hover:bg-slate-50"
                    }`}
                  >
                    Get Started
                  </Button>
                </a>
              </div>
            ))}
          </div>

          <ul className="mt-8 max-w-3xl mx-auto grid sm:grid-cols-2 gap-x-8 gap-y-2 text-sm text-slate-600">
            {[
              "Based on ~10–15 images per listing",
              "Plans reset monthly on your billing date",
              "Unlimited users per agency",
              "Purchase additional image bundles anytime",
            ].map((note) => (
              <li key={note} className="flex items-start gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                {note}
              </li>
            ))}
          </ul>

          {/* One-off packs */}
          <div className="mt-20 max-w-3xl mx-auto text-center">
            <h3 className="text-xl font-serif font-semibold text-slate-900">One-Off Packs</h3>
            <p className="text-sm text-slate-500 mt-1">No subscription required — pay once, use anytime.</p>
            <div className="mt-6 grid sm:grid-cols-2 gap-6">
              {oneOffPacks.map((pack) => (
                <div key={pack.name} className="rounded-xl border border-slate-200 bg-white p-6 text-left shadow-sm">
                  <div className="flex items-baseline justify-between">
                    <h4 className="font-semibold text-slate-900">{pack.name}</h4>
                    <span className="text-2xl font-bold text-slate-900">{pack.price}</span>
                  </div>
                  <p className="text-sm text-slate-500 mt-1">{pack.images}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Additional bundles */}
          <div className="mt-16 max-w-5xl mx-auto text-center">
            <h3 className="text-xl font-serif font-semibold text-slate-900">Additional Image Bundles</h3>
            <p className="text-sm text-slate-500 mt-1">For subscribers who need extra images this month.</p>
            <div className="mt-6 grid sm:grid-cols-3 gap-6">
              {bundles.map((bundle) => (
                <div
                  key={bundle.name}
                  className={`relative rounded-xl border bg-white p-6 text-left ${
                    bundle.highlight ? "border-emerald-500 shadow-md" : "border-slate-200 shadow-sm"
                  }`}
                >
                  {bundle.badge && (
                    <span className="absolute -top-3 right-4 bg-emerald-600 text-white text-[11px] font-semibold px-2.5 py-0.5 rounded-full shadow-sm">
                      {bundle.badge}
                    </span>
                  )}
                  <h4 className="font-semibold text-slate-900">{bundle.name}</h4>
                  <p className="text-sm text-slate-500 mt-1">{bundle.images} · 30 days validity</p>
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-slate-900">{bundle.price}</span>
                    <span className="text-xs text-slate-500">{bundle.perImage}</span>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-6 text-xs text-slate-500 max-w-xl mx-auto">
              Bundle images are used after your monthly allowance is exhausted. Secure payment powered by Stripe.
            </p>
          </div>

          <div className="mt-14 text-center">
            <a href="/login">
              <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white px-8 h-12 text-base shadow-lg transition-all rounded-md">
                Start Free Trial (3 images)
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* 6. WHY REALENHANCE / TRUST SECTION */}
      <section className="bg-slate-900 py-24 text-white">
        <div className="w-full px-4 sm:px-6 lg:px-10">
          <h2 className="text-2xl lg:text-3xl font-serif font-semibold text-center mb-14">
            Built for New Zealand real estate professionals
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-8 max-w-6xl mx-auto">
            {trustPoints.map((point) => (
              <div key={point.title} className="flex flex-col items-start gap-3">
                <div className="w-11 h-11 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                  <point.icon className="w-5 h-5 text-emerald-400" />
                </div>
                <h3 className="font-semibold text-white text-sm">{point.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{point.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 7. FAQ */}
      <section id="faq" className="bg-white py-24 scroll-mt-20">
        <div className="w-full px-4 sm:px-6 lg:px-10 max-w-3xl mx-auto">
          <h2 className="text-2xl lg:text-3xl font-serif font-semibold text-slate-900 text-center mb-10">
            Frequently asked questions
          </h2>
          <div className="space-y-3">
            {faqs.map((item) => (
              <details
                key={item.q}
                className="group rounded-xl border border-slate-200 bg-white open:border-emerald-200 open:shadow-sm transition-colors"
              >
                <summary className="cursor-pointer list-none flex items-center justify-between gap-4 px-5 py-4 font-medium text-slate-900 text-sm sm:text-base">
                  {item.q}
                  <ArrowRight className="w-4 h-4 text-slate-400 shrink-0 transition-transform group-open:rotate-90" />
                </summary>
                <p className="px-5 pb-4 text-sm text-slate-600 leading-relaxed">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* 8. FINAL CTA */}
      <section className="bg-slate-50 py-24 text-center">
        <div className="container mx-auto px-4 max-w-3xl">
          <h2 className="text-4xl lg:text-5xl font-serif font-bold text-slate-900 mb-4 leading-tight">
            Ready to improve your next listing?
          </h2>
          <p className="text-lg text-slate-600 mb-8">
            Start with 3 free images. No credit card required.
          </p>
          <div className="flex flex-col items-center gap-4">
            <a href="/login">
              <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white px-10 h-14 text-lg shadow-xl hover:-translate-y-0.5 transition-all rounded-md">
                Enhance Your Listing Photos — Free
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </a>
            <p className="text-sm text-slate-500 mt-4">
              No credit card required · 3 free images after sign-up and email confirmation · Originals preserved
            </p>
          </div>
        </div>
      </section>

    </div>
  );
}
