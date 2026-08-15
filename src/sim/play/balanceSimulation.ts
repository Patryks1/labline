/**
 * In-game balance simulation runner.
 *
 * Clones the live SimState and fast-forwards it with `tickDay`, collecting
 * daily telemetry (cash, capability, serving, training) into a compact report
 * for the pause-menu Balance tab. The live game state is never mutated: the
 * sim works on a deep clone taken at entry.
 */
import { tickDay } from '../tick'
import type { SimState } from '../types'

export interface BalanceSimulationSample {
  day: number
  cash: number
  /** Best player model capability (0 if none). */
  topCapability: number
  servedMTok: number
  demandMTok: number
  unservedRatio: number
  activeTrainingJobs: number
}

export interface BalanceSimulationReport {
  daysSimulated: number
  startDay: number
  endCash: number
  startCash: number
  firstCashNegativeDay: number | null
  endTopCapability: number
  avgUnservedRatio: number
  /** Telemetry captured every ~7 days plus the final day. */
  samples: BalanceSimulationSample[]
  /** Human-readable findings. */
  warnings: string[]
  /** Set if the sim threw; report stays partial. */
  error?: string
}

const MAX_SIM_DAYS = 400
const SAMPLE_EVERY_DAYS = 7
const PROGRESS_EVERY_DAYS = 5

function cloneState(state: SimState): SimState {
  try {
    return structuredClone(state)
  } catch {
    return JSON.parse(JSON.stringify(state)) as SimState
  }
}

function topCapabilityOf(state: SimState): number {
  let top = 0
  for (const model of state.player.models) {
    if (model.capability > top) top = model.capability
  }
  return top
}

function activeTrainingJobCount(state: SimState): number {
  return (state.player.trainingJobs ?? []).filter((job) => !job.failed && !job.paused).length
}

function sampleOf(state: SimState): BalanceSimulationSample {
  return {
    day: state.day,
    cash: state.player.cash,
    topCapability: topCapabilityOf(state),
    servedMTok: state.lastMarket.servedMTok,
    demandMTok: state.lastMarket.playerDemandMTok,
    unservedRatio: state.lastMarket.unservedRatio,
    activeTrainingJobs: activeTrainingJobCount(state),
  }
}

export function runBalanceSimulation(
  state: SimState,
  days: number,
  opts?: { onProgress?: (doneDays: number, totalDays: number) => boolean | void },
): BalanceSimulationReport {
  const totalDays = Math.max(1, Math.min(MAX_SIM_DAYS, Math.floor(days)))
  let sim = cloneState(state)

  const report: BalanceSimulationReport = {
    daysSimulated: 0,
    startDay: sim.day,
    startCash: sim.player.cash,
    endCash: sim.player.cash,
    firstCashNegativeDay: null,
    endTopCapability: topCapabilityOf(sim),
    avgUnservedRatio: 0,
    samples: [],
    warnings: [],
  }

  let unservedSum = 0
  for (let done = 1; done <= totalDays; done++) {
    try {
      sim = tickDay(sim)
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err)
      break
    }
    report.daysSimulated = done
    const cash = sim.player.cash
    report.endCash = cash
    report.endTopCapability = topCapabilityOf(sim)
    unservedSum += Math.max(0, sim.lastMarket.unservedRatio)
    if (report.firstCashNegativeDay === null && cash < 0) {
      report.firstCashNegativeDay = sim.day
    }
    if (done % SAMPLE_EVERY_DAYS === 0 || done === totalDays) {
      report.samples.push(sampleOf(sim))
    }
    if (done % PROGRESS_EVERY_DAYS === 0 || done === totalDays) {
      if (opts?.onProgress?.(done, totalDays) === false) break
    }
  }

  report.avgUnservedRatio =
    report.daysSimulated > 0 ? unservedSum / report.daysSimulated : 0

  if (report.firstCashNegativeDay !== null) {
    report.warnings.push(
      `Cash went negative on day ${report.firstCashNegativeDay}.`,
    )
  }
  if (report.avgUnservedRatio > 0.15) {
    report.warnings.push(
      `Serving cannot meet demand (avg ${Math.round(report.avgUnservedRatio * 100)}% unserved).`,
    )
  }
  if (activeTrainingJobCount(sim) === 0) {
    report.warnings.push('No models in training at the end of the run.')
  }
  if (report.endTopCapability <= 0) {
    report.warnings.push('No models shipped — capability is still 0.')
  }

  return report
}
