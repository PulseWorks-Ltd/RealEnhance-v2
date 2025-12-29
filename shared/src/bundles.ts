// shared/src/bundles.ts
// Image bundle pack configuration for one-time purchases

export type BundleCode = "BUNDLE_50" | "BUNDLE_100";

export interface ImageBundle {
  code: BundleCode;
  images: number;
  priceNZD: number;
  name: string;
  description: string;
}

export const IMAGE_BUNDLES: Record<BundleCode, ImageBundle> = {
  BUNDLE_50: {
    code: "BUNDLE_50",
    images: 50,
    priceNZD: 49,
    name: "50 Image Bundle",
    description: "50 enhanced images - perfect for a busy month"
  },
  BUNDLE_100: {
    code: "BUNDLE_100",
    images: 100,
    priceNZD: 89,
    name: "100 Image Bundle",
    description: "100 enhanced images - best value for high-volume agencies"
  }
};

export function getBundleByCode(code: string): ImageBundle | null {
  return IMAGE_BUNDLES[code as BundleCode] || null;
}

export function getAllBundles(): ImageBundle[] {
  return Object.values(IMAGE_BUNDLES);
}
