/** Quantize a USD amount to 8 decimal places, half-away-from-zero. */
export function q8(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return (Math.sign(x) * Math.round(Math.abs(x) * 1e8)) / 1e8;
}
