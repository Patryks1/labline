/** Shared calendar-duration floor for player, rival, and safety training runs. */

/** Minimum calendar days for any base training / safety campaign run. */
export const MIN_TRAINING_DAYS = 30

/**
 * Scale PF-day work so estimated duration at the given throughput is at least
 * `MIN_TRAINING_DAYS`. Forecasts stay honest because targetPfDays grows with
 * allocated compute rather than clamping daily progress.
 */
export function enforceMinTrainingDuration(
  targetPfDays: number,
  dailyThroughputPf: number,
  minDays: number = MIN_TRAINING_DAYS,
): number {
  const target = Math.max(0, targetPfDays)
  const throughput = Math.max(0, dailyThroughputPf)
  if (!(throughput > 1e-9)) return Math.max(target, minDays)
  return Math.max(target, throughput * minDays)
}
