/**
 * Live balance tuning knobs.
 *
 * The defaults reproduce the shipped balance exactly (every multiplier is 1).
 * A run may carry per-campaign overrides on `SimState.balanceTuning`, edited
 * from the pause-menu Balance tab and persisted with the save.
 *
 * Balance math lives in pure functions that do not receive SimState, so the
 * resolved tuning is exposed through a module-level active value. The game
 * store (and the daily tick) call `setActiveBalanceTuning` before invoking
 * simulation code; tests that never set it observe the defaults.
 */
export interface BalanceTuning {
  /** 0–2.5: how sharply capability gains bend down past ~52. 0 = off (legacy curve). */
  progressionSteepness: number
  /** 0.25–3: multiplier on training PF-day targets (slower = costlier runs). */
  trainingWorkMult: number
  /** 0.5–2.5: multiplier on minimum training calendar days. */
  trainingCalendarMult: number
  /** 0.25–3: multiplier on post-training (SFT/RLHF/process/tools) PF targets. */
  postTrainWorkMult: number
  /** 0.25–2.5: multiplier on serving token capacity. */
  serveCapacityMult: number
  /** 0–0.6: floor for the serve memory-fit derate; lets huge models host degraded. */
  serveMinMemFit: number
  /** 0.25–3: multiplier on daily model-hosting opex. */
  hostingCostMult: number
  /** 0.25–3: multiplier on training cash burn. */
  trainingCostMult: number
  /** 0.25–2.5: multiplier on data collected from traffic. */
  dataCollectionMult: number
  /** 0.5–1.75: multiplier on corpus quality gain when processing data. */
  dataQualityMult: number
  /** 0.25–2.5: multiplier on synthetic data effectiveness. */
  syntheticEfficiencyMult: number
  /** 0.25–2.5: multiplier on synthetic candidate tokens generated per PF. */
  syntheticVolumeMult: number
  /** 0.25–2.5: multiplier on high-quality share of accepted synthetic tokens. */
  syntheticHqShareMult: number
  /** 0.25–2.5: multiplier on product/API revenue. */
  incomeMult: number
  /** 0.25–2.5: multiplier on operating expenses (fleet/hosting/staff). */
  expenseMult: number
  /** 0.5–1.6: multiplier on distillation retention. */
  distillRetentionMult: number
}

export const DEFAULT_BALANCE_TUNING: BalanceTuning = {
  progressionSteepness: 1,
  trainingWorkMult: 1,
  trainingCalendarMult: 1,
  postTrainWorkMult: 1,
  serveCapacityMult: 1,
  serveMinMemFit: 0.22,
  hostingCostMult: 1,
  trainingCostMult: 1,
  dataCollectionMult: 1,
  dataQualityMult: 1,
  syntheticEfficiencyMult: 1,
  syntheticVolumeMult: 1,
  syntheticHqShareMult: 1,
  incomeMult: 1,
  expenseMult: 1,
  distillRetentionMult: 1,
}

export interface BalanceTuningSliderMeta {
  key: keyof BalanceTuning
  label: string
  hint: string
  min: number
  max: number
  step: number
  format: (value: number) => string
}

const pct = (value: number) => `${Math.round(value * 100)}%`
const mult = (value: number) => `×${value.toFixed(2)}`

export const BALANCE_TUNING_GROUPS: ReadonlyArray<{
  id: string
  label: string
  sliders: readonly BalanceTuningSliderMeta[]
}> = [
  {
    id: 'progression',
    label: 'Progression',
    sliders: [
      {
        key: 'progressionSteepness',
        label: 'Capability curve steepness past 52',
        hint: 'Higher = each capability point above ~52 costs progressively more scale, data and research. 0 restores the legacy flat curve.',
        min: 0,
        max: 2.5,
        step: 0.05,
        format: mult,
      },
      {
        key: 'distillRetentionMult',
        label: 'Distillation retention',
        hint: 'Scales how much teacher capability a student keeps (base curve already depends on the size gap, data and RNG).',
        min: 0.5,
        max: 1.6,
        step: 0.02,
        format: mult,
      },
    ],
  },
  {
    id: 'training',
    label: 'Training',
    sliders: [
      {
        key: 'trainingWorkMult',
        label: 'Training compute (PF-days)',
        hint: 'Scales the PF-day target of every new run — higher means longer, more expensive training.',
        min: 0.25,
        max: 3,
        step: 0.05,
        format: pct,
      },
      {
        key: 'trainingCalendarMult',
        label: 'Training calendar floor',
        hint: 'Scales the minimum calendar days a run must integrate before it is fully mature.',
        min: 0.5,
        max: 2.5,
        step: 0.05,
        format: pct,
      },
      {
        key: 'postTrainWorkMult',
        label: 'Post-training compute',
        hint: 'Scales SFT/RLHF/process/tools PF targets (these already grow with model size and data).',
        min: 0.25,
        max: 3,
        step: 0.05,
        format: pct,
      },
      {
        key: 'trainingCostMult',
        label: 'Training cash burn',
        hint: 'Scales the daily cash burn of active training runs.',
        min: 0.25,
        max: 3,
        step: 0.05,
        format: pct,
      },
    ],
  },
  {
    id: 'serving',
    label: 'Serving & hosting',
    sliders: [
      {
        key: 'serveCapacityMult',
        label: 'Serving capacity',
        hint: 'Scales token throughput per PF of inference compute.',
        min: 0.25,
        max: 2.5,
        step: 0.05,
        format: pct,
      },
      {
        key: 'serveMinMemFit',
        label: 'Oversubscription floor',
        hint: 'When a hosted model does not fit fleet HBM/RAM, serving still runs at this minimum fraction instead of collapsing toward zero. Higher = easier giant-model hosting.',
        min: 0,
        max: 0.6,
        step: 0.01,
        format: pct,
      },
      {
        key: 'hostingCostMult',
        label: 'Model hosting opex',
        hint: 'Scales the daily cost of keeping public models resident (weights, KV cache, endpoint upkeep).',
        min: 0.25,
        max: 3,
        step: 0.05,
        format: pct,
      },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    sliders: [
      {
        key: 'dataCollectionMult',
        label: 'Traffic data collection',
        hint: 'Scales new corpus collected from served traffic.',
        min: 0.25,
        max: 2.5,
        step: 0.05,
        format: pct,
      },
      {
        key: 'dataQualityMult',
        label: 'Corpus quality gain',
        hint: 'Scales how fast processed data improves in quality.',
        min: 0.5,
        max: 1.75,
        step: 0.05,
        format: pct,
      },
      {
        key: 'syntheticEfficiencyMult',
        label: 'Synthetic data efficiency',
        hint: 'Scales how much effective signal generated tokens carry when training.',
        min: 0.25,
        max: 2.5,
        step: 0.05,
        format: pct,
      },
      {
        key: 'syntheticVolumeMult',
        label: 'Synthetic generation volume',
        hint: 'Scales attempted synthetic tokens per research PF. Size still sets PF per token; this is the global tap.',
        min: 0.25,
        max: 2.5,
        step: 0.05,
        format: pct,
      },
      {
        key: 'syntheticHqShareMult',
        label: 'Synthetic high-Q share',
        hint: 'Scales how much of accepted synthetic data is high quality. Capability still gates the base curve.',
        min: 0.25,
        max: 2.5,
        step: 0.05,
        format: pct,
      },
    ],
  },
  {
    id: 'capital',
    label: 'Capital',
    sliders: [
      {
        key: 'incomeMult',
        label: 'Product revenue',
        hint: 'Scales API and subscription revenue at settlement.',
        min: 0.25,
        max: 2.5,
        step: 0.05,
        format: pct,
      },
      {
        key: 'expenseMult',
        label: 'Operating expenses',
        hint: 'Scales daily fleet, hosting and staff operating costs.',
        min: 0.25,
        max: 2.5,
        step: 0.05,
        format: pct,
      },
    ],
  },
]

function clampKey(key: keyof BalanceTuning, value: number): number {
  for (const group of BALANCE_TUNING_GROUPS) {
    const meta = group.sliders.find((slider) => slider.key === key)
    if (meta) {
      const clamped = Math.max(meta.min, Math.min(meta.max, value))
      return Math.round(clamped / meta.step) * meta.step
    }
  }
  return value
}

/** Merge partial overrides onto defaults, clamped to slider ranges. */
export function resolveBalanceTuning(
  overrides?: Partial<BalanceTuning> | null,
): BalanceTuning {
  const out = { ...DEFAULT_BALANCE_TUNING }
  if (!overrides) return out
  for (const key of Object.keys(DEFAULT_BALANCE_TUNING) as (keyof BalanceTuning)[]) {
    const value = overrides[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = clampKey(key, value)
    }
  }
  return out
}

let active: BalanceTuning = DEFAULT_BALANCE_TUNING
let activeRevision = 0

/** Set the tuning subsequent balance calls observe (store/tick entry points). */
export function setActiveBalanceTuning(
  overrides?: Partial<BalanceTuning> | null,
): BalanceTuning {
  active = resolveBalanceTuning(overrides)
  activeRevision += 1
  return active
}

/** Currently active tuning (defaults unless a run overrode it). */
export function activeBalanceTuning(): BalanceTuning {
  return active
}

/** Bumps on every setActiveBalanceTuning call; include in memoization keys. */
export function activeBalanceTuningRevision(): number {
  return activeRevision
}
