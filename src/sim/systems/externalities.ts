import { createRng, hashSeed, seededId } from '../rng'
import type {
  ExternalityAccount,
  ExternalityIncident,
  LabState,
  SimState,
} from '../types'
import { computeLabSnapshot, getLab, labIds, updateLab } from './labEngine'

const CARBON_PRICE_PER_TON = 85
const WATER_PRICE_PER_M3 = 1.8

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function monthKey(state: SimState): string {
  return `${state.calendar.year}-${String(state.calendar.month).padStart(2, '0')}`
}

function dataRightsRisk(lab: LabState): number {
  const assets = lab.data.assets ?? []
  const total = assets.reduce((sum, asset) => sum + Math.max(0, asset.volumeMTok), 0)
  if (total <= 0) return 0
  return clamp01(
    assets.reduce((risk, asset) => {
      const rightsRisk =
        asset.rights === 'restricted' ? 0.72 : asset.rights === 'licensed' ? 0.12 : 0.03
      return (
        risk +
        Math.max(0, asset.volumeMTok) *
          (rightsRisk + asset.contaminationRisk * 0.22)
      )
    }, 0) / total,
  )
}

function modelAuditRisk(lab: LabState): number {
  const released = lab.models.filter((model) => model.shipped || model.release === 'released')
  if (released.length === 0) return 0
  return clamp01(
    released.reduce((sum, model) => {
      const safety = model.capabilities?.safety ?? model.quality.safety ?? 50
      const reliability = model.capabilities?.reliability ?? model.quality.reliability ?? 50
      return sum + (100 - safety) / 180 + (100 - reliability) / 240
    }, 0) / released.length,
  )
}

function freshAccount(state: SimState, lab: LabState, rawPf: number): ExternalityAccount {
  return {
    labId: lab.id,
    monthKey: monthKey(state),
    energyMWh: 0,
    carbonTons: 0,
    waterM3: 0,
    // Budgets scale with useful capacity but retain a meaningful fixed startup
    // allowance. Efficient systems therefore get more work from each quota.
    carbonBudgetTons: 120 + rawPf * 5.5,
    waterBudgetM3: 600 + rawPf * 28,
    complianceCost: 0,
    rightsRisk: dataRightsRisk(lab),
    auditRisk: modelAuditRisk(lab),
    lastAuditDay: null,
    violations: 0,
  }
}

function addIncident(
  state: SimState,
  incident: ExternalityIncident,
): SimState {
  return {
    ...state,
    externalities: {
      accounts: state.externalities?.accounts ?? {},
      incidents: [incident, ...(state.externalities?.incidents ?? [])].slice(0, 160),
    },
    alerts: [
      {
        id: incident.id,
        day: state.day,
        severity: incident.fine > 1_000_000 ? ('danger' as const) : ('warn' as const),
        message: incident.description,
      },
      ...state.alerts,
    ].slice(0, 40),
    news: [`Day ${state.day}: ${incident.description}`, ...state.news].slice(0, 64),
  }
}

function chargeLab(
  state: SimState,
  labId: string,
  amount: number,
  trustLoss = 0,
): SimState {
  if (amount <= 0 && trustLoss <= 0) return state
  return updateLab(state, labId, (lab) => ({
    ...lab,
    cash: lab.cash - amount,
    brandTrust: Math.max(0, lab.brandTrust - trustLoss),
    finance: {
      ...lab.finance,
      cash: lab.cash - amount,
      dayExternalityCost: (lab.finance.dayExternalityCost ?? 0) + amount,
      dayTotalOut: lab.finance.dayTotalOut + amount,
      dayNet: lab.finance.dayNet - amount,
      lifetimeNet: lab.finance.lifetimeNet - amount,
    },
  }))
}

/**
 * Optional advanced rules. Standard mode is an exact no-op. Advanced mode
 * applies the same metering, quota, audit, and fine formulas to every lab.
 */
export function tickExternalities(state: SimState): SimState {
  if (state.config.campaignRules.externalityMode !== 'advanced') return state

  let next = state
  const accounts = { ...(state.externalities?.accounts ?? {}) }
  const currentMonth = monthKey(state)

  for (const labId of labIds(next)) {
    const lab = getLab(next, labId)
    const compute = computeLabSnapshot(next, labId)
    const region = next.map.regions.find((candidate) => candidate.id === lab.regionId)
    const actualMWh = compute.powerMw * 24 * Math.max(0.2, Math.min(0.98, lab.utilCap))
    const carbonIntensity = 0.22 + (region?.energyPriceMult ?? 1) * 0.08
    const waterIntensity = 0.72 + (region?.regulationRisk ?? 0.3) * 0.9
    const carbon = actualMWh * carbonIntensity
    const water = actualMWh * waterIntensity
    const existing = accounts[labId]
    const account = !existing || existing.monthKey !== currentMonth
      ? freshAccount(next, lab, compute.rawFlopsPf)
      : { ...existing }
    account.energyMWh += actualMWh
    account.carbonTons += carbon
    account.waterM3 += water
    account.rightsRisk = dataRightsRisk(lab)
    account.auditRisk = modelAuditRisk(lab)

    const baseCompliance = 1_250 + compute.rawFlopsPf * 16
    const carbonOver = Math.max(0, account.carbonTons - account.carbonBudgetTons)
    const waterOver = Math.max(0, account.waterM3 - account.waterBudgetM3)
    const dailyCost =
      baseCompliance +
      carbon * CARBON_PRICE_PER_TON +
      water * WATER_PRICE_PER_M3 +
      carbonOver * CARBON_PRICE_PER_TON * 0.35 +
      waterOver * WATER_PRICE_PER_M3 * 0.5
    account.complianceCost += dailyCost
    accounts[labId] = account
    next = chargeLab(next, labId, dailyCost)

    if (next.calendar.isAccountingDay) {
      const rng = createRng(hashSeed(next.seed, next.day, labId, 'advanced-audit'))
      const candidates: Array<{
        kind: ExternalityIncident['kind']
        risk: number
        fineMult: number
        trustLoss: number
        description: string
      }> = [
        {
          kind: 'data_rights',
          risk: account.rightsRisk * 0.22,
          fineMult: 0.003,
          trustLoss: 3.5,
          description: `${lab.name} receives a data-rights enforcement action after a provenance audit.`,
        },
        {
          kind: 'safety_audit',
          risk: account.auditRisk * 0.18,
          fineMult: 0.002,
          trustLoss: 2.5,
          description: `${lab.name} fails part of an independent deployment-safety audit.`,
        },
        {
          kind: 'carbon_overage',
          risk: carbonOver > 0 ? Math.min(0.9, 0.2 + carbonOver / Math.max(1, account.carbonBudgetTons)) : 0,
          fineMult: 0.001,
          trustLoss: 1.2,
          description: `${lab.name} exceeds its monthly carbon allocation and pays an overage assessment.`,
        },
        {
          kind: 'water_overage',
          risk: waterOver > 0 ? Math.min(0.9, 0.2 + waterOver / Math.max(1, account.waterBudgetM3)) : 0,
          fineMult: 0.001,
          trustLoss: 1.2,
          description: `${lab.name} exceeds its monthly cooling-water allocation and faces restrictions.`,
        },
      ]
      for (const candidate of candidates) {
        if (candidate.risk <= 0 || rng.next() >= candidate.risk) continue
        const current = getLab(next, labId)
        const fine = Math.max(50_000, Math.min(8_000_000, current.finance.valuation * candidate.fineMult))
        const incident: ExternalityIncident = {
          id: seededId('externality', next.seed, next.day, labId, candidate.kind),
          labId,
          day: next.day,
          kind: candidate.kind,
          fine,
          trustLoss: candidate.trustLoss,
          description: candidate.description,
        }
        account.violations += 1
        account.lastAuditDay = next.day
        accounts[labId] = account
        next = chargeLab(next, labId, fine, candidate.trustLoss)
        next = addIncident(next, incident)
      }
    }
  }

  return {
    ...next,
    externalities: {
      accounts,
      incidents: next.externalities?.incidents ?? [],
    },
  }
}
