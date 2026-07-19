import { RACK_SKU_CATALOG } from '../balance/rackSkus'
import { ECONOMY } from '../balance/economy'
import type { SimState } from '../types'
import { energyPriceForState } from './map'

export interface CapacityEconomicsQuote {
  utilization: number
  cloudAnnualCostPerPf: number
  ownedAnnualOperatingPerPf: number
  ownedCapexPerPf: number
  annualSavingsPerPf: number
  paybackMonths: number
  route: 'cloud' | 'owned' | 'borderline'
}

/**
 * Like-for-like cloud-versus-owned comparison per installed PF. Cloud is paid
 * only when used; owned hardware carries fixed maintenance even while idle.
 */
export function quoteCapacityEconomics(
  state: SimState,
  options: {
    utilization: number
    cloudPricePerPfDay: number
    rackSkuId?: string
    siteCapexPerPf?: number
    annualMaintenanceRate?: number
  },
): CapacityEconomicsQuote {
  const utilization = Math.max(0, Math.min(1, options.utilization))
  const sku =
    RACK_SKU_CATALOG.find((candidate) => candidate.id === (options.rackSkuId ?? 'rack_h100')) ??
    RACK_SKU_CATALOG[0]!
  const hardwareCapexPerPf = sku.price / Math.max(0.001, sku.flopsPf)
  const ownedCapexPerPf = hardwareCapexPerPf + Math.max(0, options.siteCapexPerPf ?? 25_000)
  const maintenancePerYear =
    ownedCapexPerPf * Math.max(0, options.annualMaintenanceRate ?? 0.04)
  const energyPerDayAtFullUse =
    (sku.mw / Math.max(0.001, sku.flopsPf)) *
    Math.max(1.05, state.player.pue) *
    24 *
    energyPriceForState(state) *
    (ECONOMY.onsiteGenerationCostShare ?? 0.6)
  const cloudAnnualCostPerPf =
    Math.max(0, options.cloudPricePerPfDay) * utilization * 365
  const ownedAnnualOperatingPerPf =
    maintenancePerYear + energyPerDayAtFullUse * utilization * 365
  const annualSavingsPerPf = cloudAnnualCostPerPf - ownedAnnualOperatingPerPf
  const paybackMonths =
    annualSavingsPerPf > 0
      ? (ownedCapexPerPf / annualSavingsPerPf) * 12
      : Number.POSITIVE_INFINITY
  const [, targetHigh] = state.industryDataPack.infrastructure.ownedPaybackMonths
  const route =
    utilization < 0.5 || paybackMonths > targetHigh
      ? 'cloud'
      : utilization >= 0.65 && paybackMonths <= targetHigh
        ? 'owned'
        : 'borderline'
  return {
    utilization,
    cloudAnnualCostPerPf,
    ownedAnnualOperatingPerPf,
    ownedCapexPerPf,
    annualSavingsPerPf,
    paybackMonths,
    route,
  }
}
