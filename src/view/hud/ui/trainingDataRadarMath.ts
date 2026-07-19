import { DATA_DOMAINS } from '../../../sim/balance/data'
import type { DataDomain } from '../../../sim/types'

export function normalizedRadarWeights(weights: Record<DataDomain, number>): Record<DataDomain, number> {
  const total = DATA_DOMAINS.reduce((sum, domain) => sum + Math.max(0, weights[domain] ?? 0), 0) || 1
  return Object.fromEntries(
    DATA_DOMAINS.map((domain) => [domain, Math.max(0, weights[domain] ?? 0) / total]),
  ) as Record<DataDomain, number>
}

export function rebalanceRadarWeight(
  weights: Record<DataDomain, number>,
  changed: DataDomain,
  nextShare: number,
): Record<DataDomain, number> {
  const current = normalizedRadarWeights(weights)
  const target = Math.max(0.01, Math.min(0.7, nextShare))
  const otherTotal = Math.max(0.0001, 1 - current[changed])
  const remaining = 1 - target
  return Object.fromEntries(
    DATA_DOMAINS.map((domain) => [
      domain,
      domain === changed ? target : (current[domain] / otherTotal) * remaining,
    ]),
  ) as Record<DataDomain, number>
}
