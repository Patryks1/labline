import { DATA_DOMAINS, normalizeWeights } from '../../../sim/balance/data'
import type { DataDomain } from '../../../sim/types'

export function rebalanceTrainingDataDomain(
  weights: Record<DataDomain, number>,
  domain: DataDomain,
  value: number,
) {
  const next = { ...weights, [domain]: Math.max(0.01, Math.min(0.72, value)) }
  const otherTotal = DATA_DOMAINS.reduce(
    (sum, candidate) => candidate === domain ? sum : sum + weights[candidate],
    0,
  )
  const remaining = 1 - next[domain]
  for (const candidate of DATA_DOMAINS) {
    if (candidate === domain) continue
    next[candidate] = otherTotal > 0
      ? weights[candidate] / otherTotal * remaining
      : remaining / (DATA_DOMAINS.length - 1)
  }
  return normalizeWeights(next)
}
