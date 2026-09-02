import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";
import { ArrowRight, CloudSun, Sun, Trash2, Sofa, Crop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePageMeta } from "@/hooks/usePageMeta";

const PAGE_TITLE = "Real Before & After Examples – RealEnhance | AI Real Estate Photo Enhancement";
const PAGE_DESCRIPTION =
  "See real before-and-after examples of RealEnhance in action — sky replacement, lighting and quality, decluttering, and virtual staging — all while preserving the true structure of the property.";

const sliderImageClassName = "h-full w-full object-contain object-center";

type ExamplePair = {
  id: string;
  label: string;
  beforeSrc: string;
  afterSrc: string;
  beforeAlt: string;
  afterAlt: string;
  bullets: string[];
};

type Category = {
  id: string;
  icon: typeof Sun;
  title: string;
  does: string;
  doesNot: string;
  pairs: ExamplePair[];
};

const CATEGORIES: Category[] = [
  {
    id: "sky-weather",
    icon: CloudSun,
    title: "Sky Replacement & Weather Improvement",
    does: "RealEnhance replaces flat, grey or overcast skies with clear, bright conditions and balances exterior exposure so an exterior photo shows the property at its best, on any day it was shot.",
    doesNot: "It never adds, removes, or moves any part of the building, fencing, landscaping, or surrounding structures — only the sky and overall exposure change.",
    pairs: [
      {
        id: "exterior-01",
        label: "Exterior — grey sky to clear sky",
        beforeSrc: "/landing-samples/example-exterior-image-01.jpg",
        afterSrc: "/landing-samples/example-exterior-image-01-enhanced.jpg",
        beforeAlt: "Baseline exterior real estate photo with a flat, overcast sky",
        afterAlt: "Same exterior photo after RealEnhance replaces the overcast sky with clear conditions and balances exposure",
        bullets: [
          "Flat, grey sky replaced with clear, bright conditions",
          "Improved exterior brightness and colour balance",
          "Roofline, fencing, landscaping and building details unchanged",
        ],
      },
    ],
  },
  {
    id: "lighting-quality",
    icon: Sun,
    title: "Lighting, Colour & Overall Quality",
    does: "Dark or flat interior photos are brightened, exposure is balanced across shadows and highlights, and colour, contrast and sharpness are improved so the room looks professionally photographed.",
    doesNot: "Wall positions, window placement, room proportions and fixed fittings are always preserved — only how the existing photo is lit and rendered changes.",
    pairs: [
      {
        id: "lounge",
        label: "Living room — dark and flat to bright and inviting",
        beforeSrc: "/landing-samples/lounge-example-baseline.png",
        afterSrc: "/landing-samples/lounge-example-enhanced.jpg",
        beforeAlt: "Baseline living room photo with dim, flat lighting",
        afterAlt: "Same living room after RealEnhance brightens the lighting, improves colour and adds realistic staging",
        bullets: [
          "Dim, flat lighting brightened into a warm, natural exposure",
          "Improved colour, contrast and overall clarity",
          "Furnished with realistic staging while the room's true layout stays identical",
        ],
      },
    ],
  },
  {
    id: "declutter",
    icon: Trash2,
    title: "Declutter & Object Removal",
    does: "Everyday clutter — dishes, cables, bins, toys and other distractions — is removed from benches, floors and furniture so buyers can focus on the space itself.",
    doesNot: "Only loose objects and clutter are removed. Cabinetry, benchtops, appliances, walls and layout are never altered, resized, or repositioned.",
    pairs: [
      {
        id: "kaipuke-kitchen",
        label: "Kitchen island — cluttered counter to market-ready",
        beforeSrc: "/landing-samples/kaipuke-declutter-baseline.jpg",
        afterSrc: "/landing-samples/kaipuke-declutter-enhanced.jpg",
        beforeAlt: "Baseline kitchen photo with a cluttered island bench covered in dishes, bottles and everyday items",
        afterAlt: "Same kitchen after RealEnhance clears the island bench and brightens the overall photo",
        bullets: [
          "Dishes, bottles and everyday clutter removed from the island bench",
          "Throw and toys removed from the foreground sofa",
          "Brighter, sharper overall image with the same cabinetry, layout and fittings",
        ],
      },
      {
        id: "messy-living",
        label: "Living room — cluttered to clean and market-ready",
        beforeSrc: "/landing-samples/messy-living-room.png",
        afterSrc: "/landing-samples/messy-living-room-enhanced.png",
        beforeAlt: "Baseline living room photo cluttered with everyday objects and loose items",
        afterAlt: "Same living room after RealEnhance removes clutter and distractions",
        bullets: [
          "Distracting objects and everyday clutter removed",
          "Cleaner, more appealing presentation of the existing space",
          "Room structure, walls and windows unchanged throughout",
        ],
      },
    ],
  },
  {
    id: "staging",
    icon: Sofa,
    title: "Virtual Staging (Interiors Only)",
    does: "Empty interior rooms are furnished with realistic, well-proportioned staging — furniture, rugs, artwork and styling — so buyers can visualise how the space could be used.",
    doesNot: "Virtual staging is available for interiors only, is always clearly a staging enhancement, and never changes a room's walls, windows, doors or true proportions.",
    pairs: [
      {
        id: "bedroom-1",
        label: "Bedroom — empty to furnished",
        beforeSrc: "/landing-samples/bedroom-example-baseline.png",
        afterSrc: "/landing-samples/bedroom-example-enhanced.png",
        beforeAlt: "Baseline empty bedroom photo with no furniture",
        afterAlt: "Same bedroom after RealEnhance adds realistic furniture and styling",
        bullets: [
          "Bed, bedside tables and styling added true to scale",
          "Room proportions, windows and doors preserved exactly",
          "Natural lighting balanced to suit the new staging",
        ],
      },
      {
        id: "openplan",
        label: "Open-plan living, dining & kitchen — empty to furnished",
        beforeSrc: "/landing-samples/openplan-staging-baseline.jpg",
        afterSrc: "/landing-samples/openplan-staging-enhanced.jpg",
        beforeAlt: "Baseline empty open-plan living, dining and kitchen area",
        afterAlt: "Same open-plan space after RealEnhance adds a sofa, armchair, dining table and styling",
        bullets: [
          "Separate living and dining zones furnished appropriately for each area",
          "Furniture scaled and positioned to keep walkways clear",
          "Built-in shelving, kitchen joinery and windows left completely untouched",
        ],
      },
      {
        id: "bedroom-2",
        label: "Bedroom — empty to furnished, different layout",
        beforeSrc: "/landing-samples/bedroom2-staging-baseline.jpg",
        afterSrc: "/landing-samples/bedroom2-staging-enhanced.jpg",
        beforeAlt: "Baseline empty bedroom photo with roller blinds and curtains",
        afterAlt: "Same bedroom after RealEnhance adds a bed, bedside tables and artwork",
        bullets: [
          "Bed positioned clear of the window and both blinds",
          "Bedside tables, lamps, rug and artwork added for a lived-in feel",
          "Window coverings and room layout preserved exactly as shown",
        ],
      },
    ],
  },
];

function BeforeAfterPair({ pair, eager }: { pair: ExamplePair; eager?: boolean }) {
  return (
    <figure className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="h-80 sm:h-[26rem] bg-slate-100 p-3 sm:p-4">
        <ReactCompareSlider
          className="h-full w-full rounded-lg overflow-hidden"
          itemOne={
            <ReactCompareSliderImage
              src={pair.beforeSrc}
              alt={pair.beforeAlt}
              className={sliderImageClassName}
              loading={eager ? "eager" : "lazy"}
            />
          }
          itemTwo={
            <ReactCompareSliderImage
              src={pair.afterSrc}
              alt={pair.afterAlt}
              className={sliderImageClassName}
              loading={eager ? "eager" : "lazy"}
            />
          }
        />
      </div>
      <figcaption className="p-5 sm:p-6">
        <h3 className="text-base font-semibold text-slate-900">{pair.label}</h3>
        <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
          {pair.bullets.map((b) => (
            <li key={b} className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
              {b}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

export default function ExamplesPage() {
  usePageMeta(PAGE_TITLE, PAGE_DESCRIPTION);

  return (
    <div className="min-h-screen bg-white font-sans text-slate-600">
      {/* HERO */}
      <section className="bg-slate-50 py-16 lg:py-20">
        <div className="w-full px-4 sm:px-6 lg:px-10 max-w-3xl mx-auto text-center">
          <h1 className="text-4xl lg:text-5xl font-serif font-bold text-slate-900 leading-tight">
            See RealEnhance in action
          </h1>
          <p className="mt-5 text-lg text-slate-600 leading-relaxed">
            Real before-and-after examples from real listing photos — interior and exterior, on both houses and apartments. Every enhancement below preserves the true structure, walls, and windows of the property.
          </p>
          <div className="mt-8">
            <a href="/login">
              <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white px-8 h-12 text-base shadow-lg transition-all rounded-md">
                Start Free Trial — 3 images, no credit card
              </Button>
            </a>
          </div>

          {/* Quick section nav */}
          <nav aria-label="Enhancement categories" className="mt-10 flex flex-wrap items-center justify-center gap-2">
            {CATEGORIES.map((cat) => (
              <a
                key={cat.id}
                href={`#${cat.id}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-1.5 text-sm font-medium text-slate-700 hover:border-emerald-300 hover:text-emerald-700 transition-colors"
              >
                <cat.icon className="w-3.5 h-3.5" aria-hidden="true" />
                {cat.title}
              </a>
            ))}
          </nav>
        </div>
      </section>

      {/* CATEGORY SECTIONS */}
      {CATEGORIES.map((cat, catIndex) => (
        <section
          key={cat.id}
          id={cat.id}
          className={`py-16 lg:py-20 scroll-mt-20 ${catIndex % 2 === 1 ? "bg-slate-50" : "bg-white"}`}
        >
          <div className="w-full px-4 sm:px-6 lg:px-10 max-w-5xl mx-auto">
            <div className="max-w-2xl mb-10">
              <div className="inline-flex items-center gap-2 text-emerald-700 mb-3">
                <cat.icon className="w-5 h-5" aria-hidden="true" />
                <span className="text-xs font-semibold uppercase tracking-wide">Enhancement type</span>
              </div>
              <h2 className="text-2xl lg:text-3xl font-serif font-semibold text-slate-900">
                {cat.title}
              </h2>
              <p className="mt-3 text-slate-600 leading-relaxed">{cat.does}</p>
              <p className="mt-2 text-sm text-slate-500 leading-relaxed">
                <span className="font-medium text-slate-600">What it doesn't do: </span>
                {cat.doesNot}
              </p>
            </div>

            <div className={`grid gap-8 ${cat.pairs.length > 1 ? "lg:grid-cols-2" : "grid-cols-1"}`}>
              {cat.pairs.map((pair, i) => (
                <BeforeAfterPair key={pair.id} pair={pair} eager={catIndex === 0 && i === 0} />
              ))}
            </div>
          </div>
        </section>
      ))}

      {/* STRAIGHTEN & ALIGN — honest note, no fabricated example */}
      <section className="py-16 bg-white">
        <div className="w-full px-4 sm:px-6 lg:px-10 max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 text-emerald-700 mb-3">
            <Crop className="w-5 h-5" aria-hidden="true" />
            <span className="text-xs font-semibold uppercase tracking-wide">Also included</span>
          </div>
          <h2 className="text-xl lg:text-2xl font-serif font-semibold text-slate-900">
            Straighten & Align
          </h2>
          <p className="mt-3 text-slate-600 leading-relaxed">
            RealEnhance also corrects tilted shots and vertical distortion so walls and lines look natural — without changing the room's true proportions. We're adding a dedicated before-and-after example for this soon.
          </p>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="bg-slate-50 py-24 text-center">
        <div className="container mx-auto px-4 max-w-3xl">
          <h2 className="text-4xl lg:text-5xl font-serif font-bold text-slate-900 mb-4 leading-tight">
            Ready to enhance your own listings?
          </h2>
          <p className="text-lg text-slate-600 mb-8">
            Start with 3 free images. No credit card required.
          </p>
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
      </section>
    </div>
  );
}
