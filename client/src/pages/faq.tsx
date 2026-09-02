import { useMemo, useState } from "react";
import { ChevronDown, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePageMeta } from "@/hooks/usePageMeta";

const PAGE_TITLE = "FAQ – RealEnhance | AI Real Estate Photo Enhancement New Zealand";
const PAGE_DESCRIPTION =
  "Everything New Zealand real estate agents need to know about RealEnhance — how it works, REA compliance, pricing, and more.";

type FaqAnswer = {
  intro?: string;
  list?: string[];
  outro?: string;
};

type FaqItem = {
  q: string;
  a: FaqAnswer;
};

// Exact content/schema as specified — this is the single source of truth
// for both the visible accordion and the JSON-LD FAQPage schema below, so
// the two can never drift apart.
const FAQ_ITEMS: FaqItem[] = [
  {
    q: "Is AI photo enhancement allowed for real estate listings in New Zealand?",
    a: {
      intro:
        "Yes. The Real Estate Authority (REA) allows digital enhancement of marketing photos provided the images remain a true representation of the property. RealEnhance is specifically designed to improve lighting, clarity, presentation, and weather conditions while preserving the true structure of rooms, walls, and windows — so your listings stay compliant.",
    },
  },
  {
    q: "Does RealEnhance change the structure or layout of rooms?",
    a: {
      intro:
        "No. RealEnhance is built with structural-safe enhancement. Walls, windows, room proportions, and architectural features are preserved. We improve how the photo looks (lighting, clarity, sky, declutter, staging) without altering the physical reality of the property.",
    },
  },
  {
    q: "What types of enhancements can RealEnhance do?",
    a: {
      list: [
        "Improve lighting and exposure",
        "Straighten tilted or distorted shots",
        "Declutter (remove objects, cables, bins, etc.)",
        "Virtual staging for empty interiors",
        "Replace grey or overcast skies with clear conditions",
        "Overall image quality, colour, and sharpness",
      ],
      outro: "All while keeping the original structure intact.",
    },
  },
  {
    q: "Can I use RealEnhance on both interior and exterior photos?",
    a: {
      intro: "Yes. RealEnhance works on both interior and exterior images. Virtual staging is available for interiors only.",
    },
  },
  {
    q: "Are my original photos kept?",
    a: {
      intro:
        "Yes. Your original files are always preserved. Enhanced versions are delivered as separate files so you never lose the source images.",
    },
  },
  {
    q: "How does the free trial work?",
    a: {
      intro:
        "After signing up and confirming your email, you receive 3 free image enhancements. No credit card is required to start the trial.",
    },
  },
  {
    q: "What are the monthly plans and what do they include?",
    a: {
      list: [
        "Starter – $149 NZD/month → approximately 5–8 listings / ~75 images",
        "Pro – $249 NZD/month → approximately 8–15 listings / ~150 images (Most Popular)",
        "Agency – $449 NZD/month → approximately 15–30 listings / ~300 images",
      ],
      outro:
        "Plans are based on ~10–15 images per listing. Allowances reset monthly on your billing date. Unlimited users per agency are included.",
    },
  },
  {
    q: "Can I buy images without a subscription?",
    a: {
      intro: "Yes. You can purchase one-off packs at any time:",
      list: ["Hero Pack – 7 images for $19", "Listing Pack – 20 images for $49"],
      outro: "Additional image bundles (20, 50, or 100 images) are also available and remain valid for 30 days from purchase.",
    },
  },
  {
    q: "How quickly do I get the enhanced images?",
    a: {
      intro: "Most enhancements are completed in minutes. You can run full listing batches in one go without waiting for manual editors.",
    },
  },
  {
    q: "Is RealEnhance suitable for Trade Me and realestate.co.nz listings?",
    a: {
      intro:
        "Yes. The enhanced images are designed for professional listing use on Trade Me, realestate.co.nz, agency websites, and social media.",
    },
  },
  {
    q: "Who can use RealEnhance?",
    a: {
      intro:
        "RealEnhance is built for New Zealand real estate agents, agencies, and property marketers. Unlimited users can be added under one agency account at no extra cost.",
    },
  },
  {
    q: "How is payment handled?",
    a: {
      intro: "All payments are processed securely via Stripe. Pricing is in New Zealand dollars (NZD).",
    },
  },
  {
    q: "What happens if I need more images than my plan includes?",
    a: {
      intro:
        "You can purchase additional image bundles at any time. These are used after your monthly allowance is exhausted and are valid for 30 days from purchase.",
    },
  },
  {
    q: "Does RealEnhance store or train on my photos?",
    a: {
      intro:
        "Your photos are processed to deliver the enhancements you request. Originals are preserved and we do not use customer images to train public models. Full details are available in our Privacy Policy.",
    },
  },
  {
    q: "Can I cancel or change my plan?",
    a: {
      intro: "Yes. You can upgrade, downgrade, or cancel your subscription at any time. Changes take effect at the next billing cycle.",
    },
  },
];

function answerToPlainText(a: FaqAnswer): string {
  return [a.intro, ...(a.list ?? []), a.outro].filter(Boolean).join(" ");
}

function buildFaqSchema(items: FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: answerToPlainText(item.a),
      },
    })),
  };
}

function FaqAccordionItem({
  item,
  isOpen,
  onToggle,
  panelId,
  buttonId,
}: {
  item: FaqItem;
  isOpen: boolean;
  onToggle: () => void;
  panelId: string;
  buttonId: string;
}) {
  return (
    <div className={`rounded-xl border bg-white transition-colors ${isOpen ? "border-emerald-200 shadow-sm" : "border-slate-200"}`}>
      <h2 className="text-base">
        <button
          type="button"
          id={buttonId}
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left font-semibold text-slate-900 hover:text-emerald-700 transition-colors"
        >
          <span>{item.q}</span>
          <ChevronDown
            className={`w-5 h-5 shrink-0 text-slate-400 transition-transform duration-200 ${isOpen ? "rotate-180 text-emerald-600" : ""}`}
            aria-hidden="true"
          />
        </button>
      </h2>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        className={`grid transition-all duration-300 ease-in-out ${isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="overflow-hidden">
          <div className="px-5 pb-5 text-sm text-slate-600 leading-relaxed space-y-3">
            {item.a.intro && <p>{item.a.intro}</p>}
            {item.a.list && (
              <ul className="list-disc pl-5 space-y-1.5">
                {item.a.list.map((li) => (
                  <li key={li}>{li}</li>
                ))}
              </ul>
            )}
            {item.a.outro && <p>{item.a.outro}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FaqPage() {
  usePageMeta(PAGE_TITLE, PAGE_DESCRIPTION);
  // Single item open at a time, per spec's stated preference.
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const schema = useMemo(() => buildFaqSchema(FAQ_ITEMS), []);

  return (
    <div className="min-h-screen bg-white font-sans text-slate-600">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />

      <section className="bg-slate-50 py-16 lg:py-20">
        <div className="w-full px-4 sm:px-6 lg:px-10 max-w-3xl mx-auto text-center">
          <h1 className="text-4xl lg:text-5xl font-serif font-bold text-slate-900 leading-tight">
            Frequently Asked Questions
          </h1>
          <p className="mt-5 text-lg text-slate-600 leading-relaxed">
            Everything New Zealand real estate agents need to know about RealEnhance — how it works, compliance, pricing, and more.
          </p>
        </div>
      </section>

      <section className="py-16 lg:py-20">
        <div className="w-full px-4 sm:px-6 lg:px-10 max-w-3xl mx-auto">
          <div className="space-y-3">
            {FAQ_ITEMS.map((item, i) => {
              const isOpen = openIndex === i;
              const panelId = `faq-panel-${i}`;
              const buttonId = `faq-button-${i}`;
              return (
                <FaqAccordionItem
                  key={item.q}
                  item={item}
                  isOpen={isOpen}
                  panelId={panelId}
                  buttonId={buttonId}
                  onToggle={() => setOpenIndex(isOpen ? null : i)}
                />
              );
            })}
          </div>
        </div>
      </section>

      <section className="bg-slate-50 py-20 text-center">
        <div className="w-full px-4 sm:px-6 lg:px-10 max-w-2xl mx-auto">
          <h2 className="text-2xl lg:text-3xl font-serif font-semibold text-slate-900">
            Still have questions?
          </h2>
          <p className="mt-3 text-slate-600">
            Start with 3 free images — no credit card required — or get in touch and we’ll help you out.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
            <a href="/login">
              <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white px-8 h-12 text-base shadow-lg transition-all rounded-md">
                Enhance Your Listing Photos — Free
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </a>
            <a href="mailto:support@realenhance.co.nz" className="text-sm font-medium text-slate-600 hover:text-emerald-700 transition-colors">
              Contact support
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
