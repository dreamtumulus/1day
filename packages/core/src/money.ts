/** Quantize a USD amount to 8 decimal places, half-away-from-zero. */
export function q8(x: number): number {
  if (!Number.isFinite(x) || Math.abs(x) > Number.MAX_SAFE_INTEGER / 1e8) {
    throw new RangeError("USD amount must be finite and within the supported range");
  }
  return (Math.sign(x) * Math.round(Math.abs(x) * 1e8)) / 1e8;
}
