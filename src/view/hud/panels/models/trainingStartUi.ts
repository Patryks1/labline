import type { SimAlert, TrainingJob } from '../../../../sim/types'

export interface TrainingStartNotice {
  tone?: 'danger' | 'warning'
}

export function trainingDataGuidanceText(opts: {
  selectedMTok: number
  rawStrongTargetMTok: number
  rawStrongTargetMet: boolean
  effectiveDataRatio: number
  qualityRetention: number
  diversityRetention: number
  holdoutRetention: number
}): { headline: string; reductions: string } {
  const headline = `${opts.rawStrongTargetMet ? 'Ready' : 'Needs more data'} · ${formatGuidanceTokens(opts.selectedMTok)} selected · ${opts.effectiveDataRatio.toFixed(1)}× effective`
  return {
    headline,
    // Keep the detailed multipliers available to the owning component as a
    // tooltip/accessible description, but out of the primary scan path. The
    // old sentence was both noisy and difficult to read in the narrow panel.
    reductions: '',
  }
}

function formatGuidanceTokens(mTok: number): string {
  return mTok >= 1000
    ? `${(mTok / 1000).toFixed(mTok >= 100_000 ? 0 : 2)}B`
    : `${Math.round(mTok)}M`
}

/** Warnings are advisory; only an explicit hard notice blocks launch. */
export function hasHardTrainingStartNotice(
  notices: readonly TrainingStartNotice[],
): boolean {
  return notices.some((notice) => notice.tone !== 'warning')
}

/** Recover a same-screen explanation when authoritative start validation rejects. */
export function trainingStartFailureMessage(opts: {
  beforeJobIds: readonly string[]
  beforeAlertId?: string
  alertChanged?: boolean
  jobs: readonly Pick<TrainingJob, 'id'>[]
  latestAlert?: Pick<SimAlert, 'id' | 'message'>
}): string | null {
  const before = new Set(opts.beforeJobIds)
  if (opts.jobs.some((job) => !before.has(job.id))) return null
  if (
    opts.latestAlert &&
    (opts.alertChanged || opts.latestAlert.id !== opts.beforeAlertId)
  ) {
    return opts.latestAlert.message
  }
  return 'Training did not start. Review the hard requirements and try again.'
}
