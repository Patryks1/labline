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
  const headline = opts.rawStrongTargetMet
    ? `Raw strong target met · ${formatGuidanceTokens(opts.selectedMTok)} / ${formatGuidanceTokens(opts.rawStrongTargetMTok)}`
    : `Raw strong target · ${formatGuidanceTokens(opts.selectedMTok)} / ${formatGuidanceTokens(opts.rawStrongTargetMTok)}`
  return {
    headline: `${headline} · effective ${opts.effectiveDataRatio.toFixed(2)}:1`,
    reductions: `Quality ×${opts.qualityRetention.toFixed(2)} · diversity ×${opts.diversityRetention.toFixed(2)} · verification holdout ${Math.round((1 - opts.holdoutRetention) * 100)}% (×${opts.holdoutRetention.toFixed(2)})`,
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
