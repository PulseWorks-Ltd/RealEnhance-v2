// shared/src/bundles.ts
// Image bundle pack configuration for one-time purchases

export type BundleCode = "BUNDLE_25" | "BUNDLE_20" | "BUNDLE_50" | "BUNDLE_100";

export interface ImageBundle {
  code: BundleCode;
  images: number;
  priceNZD: number;
  name: string;
  description: string;
  stripePriceIdByCurrency?: {
    nzd?: string;
    aud?: string;
  };
}

export const STRIPE_ADDON_PRICES = {
  small: {
    nzd: process.env.STRIPE_ADDON_SMALL,
    aud: process.env.STRIPE_ADDON_SMALL_AUD,
  },
  standard: {
    nzd: process.env.STRIPE_ADDON_STANDARD,
    aud: process.env.STRIPE_ADDON_STANDARD_AUD,
  },
  large: {
    nzd: process.env.STRIPE_ADDON_LARGE,
    aud: process.env.STRIPE_ADDON_LARGE_AUD,
  },
} as const;

export const IMAGE_BUNDLES: Record<BundleCode, ImageBundle> = {
  BUNDLE_25: {
    code: "BUNDLE_25",
    images: 25,
    priceNZD: 20,
    name: "Legacy 25 Image Bundle",
    description: "Legacy bundle retained for historical compatibility",
  },
  BUNDLE_20: {
    code: "BUNDLE_20",
    images: 20,
    priceNZD: 49,
    name: "Small Pack",
    description: "20 enhanced images - top up your balance quickly",
    stripePriceIdByCurrency: {
      nzd: STRIPE_ADDON_PRICES.small.nzd,
      aud: STRIPE_ADDON_PRICES.small.aud,
    },
  },
  BUNDLE_50: {
    code: "BUNDLE_50",
    images: 50,
    priceNZD: 99,
    name: "Standard Pack",
    description: "50 enhanced images - ideal for steady monthly volume",
    stripePriceIdByCurrency: {
      nzd: STRIPE_ADDON_PRICES.standard.nzd,
      aud: STRIPE_ADDON_PRICES.standard.aud,
    },
  },
  BUNDLE_100: {
    code: "BUNDLE_100",
    images: 100,
    priceNZD: 179,
    name: "Large Pack",
    description: "100 enhanced images - best value for high-volume needs",
    stripePriceIdByCurrency: {
      nzd: STRIPE_ADDON_PRICES.large.nzd,
      aud: STRIPE_ADDON_PRICES.large.aud,
    },
  }
};

export function getBundleStripePriceId(code: BundleCode, currency: "nzd" | "aud" = "nzd"): string | undefined {
  return IMAGE_BUNDLES[code]?.stripePriceIdByCurrency?.[currency];
}

export function getBundleByCode(code: string): ImageBundle | null {
  return IMAGE_BUNDLES[code as BundleCode] || null;
}

export function getAllBundles(): ImageBundle[] {
  return Object.values(IMAGE_BUNDLES);
}
