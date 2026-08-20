/**
 * Secular cloud list-price drift. GPU rental rises with the demand wave;
 * owned campuses pull ahead once utilization is high.
 */

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** Year-4 cap: 1.5× list. */
export const CLOUD_PRICE_ESCALATION_CAP = 0.5
export const CLOUD_PRICE_ESCALATION_DAY_SCALE = 2_900
export const CLOUD_PRICE_ESCALATION_DEMAND = 0.15

export function cloudListPriceEscalation(
  day: number,
  demandPressure: number,
): number {
  const drift =
    Math.max(0, day) / CLOUD_PRICE_ESCALATION_DAY_SCALE +
    clamp01(demandPressure) * CLOUD_PRICE_ESCALATION_DEMAND
  return 1 + Math.min(CLOUD_PRICE_ESCALATION_CAP, drift)
}
