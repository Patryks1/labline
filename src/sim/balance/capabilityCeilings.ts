/**
 * Game calibration bands for general capability. These are not claims about
 * real-world benchmark equivalence. Domain specialists may exceed the general
 * score in one or two domains, but not the general hard max.
 */
export const GENERAL_CAPABILITY_BANDS = [
  { label: "70M", paramsB: 0.07, min: 7, max: 15 },
  { label: "400M", paramsB: 0.4, min: 12, max: 23 },
  { label: "1B", paramsB: 1, min: 18, max: 32 },
  { label: "7B", paramsB: 7, min: 34, max: 55 },
  { label: "70B", paramsB: 70, min: 55, max: 76 },
  { label: "400B", paramsB: 400, min: 72, max: 89 },
  { label: "1T+", paramsB: 1_000, min: 82, max: 96 },
] as const;

export function generalCapabilityBand(paramsB: number): {
  min: number;
  max: number;
} {
  const n = Math.max(0.001, paramsB);
  const bands = GENERAL_CAPABILITY_BANDS;
  if (n <= bands[0]!.paramsB) return { min: bands[0]!.min, max: bands[0]!.max };
  const last = bands[bands.length - 1]!;
  if (n >= last.paramsB) return { min: last.min, max: last.max };
  for (let i = 1; i < bands.length; i++) {
    const hi = bands[i]!;
    const lo = bands[i - 1]!;
    if (n <= hi.paramsB) {
      const t = (Math.log(n) - Math.log(lo.paramsB)) /
        (Math.log(hi.paramsB) - Math.log(lo.paramsB));
      return {
        min: lo.min + (hi.min - lo.min) * t,
        max: lo.max + (hi.max - lo.max) * t,
      };
    }
  }
  return { min: last.min, max: last.max };
}

export function generalCapabilityHardMax(paramsB: number): number {
  return generalCapabilityBand(paramsB).max;
}

/** Combined research efficiency: 1 − Π(1 − improvement). */
export function stackedEfficiency(improvements: readonly number[]): number {
  let remaining = 1;
  for (const raw of improvements) {
    const improvement = Math.max(0, Math.min(0.95, raw));
    remaining *= 1 - improvement;
  }
  return 1 - remaining;
}
