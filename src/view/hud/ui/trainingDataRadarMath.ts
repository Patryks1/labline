import type { DataDomain } from '../../../sim/types'

export function rebalanceTrainingDataDomain(
  allocationsMTok: Record<DataDomain, number>,
  domain: DataDomain,
  valueMTok: number,
  capMTok = Number.POSITIVE_INFINITY,
) {
  return {
    ...allocationsMTok,
    [domain]: Math.max(0, Math.min(Math.max(0, capMTok), valueMTok)),
  }
}

export function trainingDataDomainCapMTok(
  realAvailableMTok: number,
  includedSyntheticMTok: number,
  syntheticMultiplier: number,
): number {
  const real = Math.max(0, realAvailableMTok)
  const existingSynthetic = Math.max(0, includedSyntheticMTok)
  const expansion = Math.max(0, Math.min(7, syntheticMultiplier))
  return expansion > 0
    ? Math.min(
        real * 8,
        Math.max(real * (1 + expansion), real + existingSynthetic),
      )
    : real
}
