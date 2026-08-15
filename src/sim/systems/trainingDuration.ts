export { minimumTrainingCalendarDays } from '../balance/training'

/** Legacy export retained for callers outside the player-training path. */
export const MIN_TRAINING_DAYS = 30

/**
 * Calendar integration and validation do not disappear when a run has ample
 * compute. Unlike the old duration floor, this never changes physical work.
 */
/** @deprecated Calendar duration must not inflate PF-day work. */
export function enforceMinTrainingDuration(
  targetPfDays: number,
  _dailyThroughputPf?: number,
  _minDays?: number,
): number {
  return Math.max(0, targetPfDays)
}
