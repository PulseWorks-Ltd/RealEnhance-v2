export function safeSigma(sigma: number | undefined): number {
  if (!sigma || sigma < 0.3) return 0.3;
  return sigma;
}
