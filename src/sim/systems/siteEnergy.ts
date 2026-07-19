import { hashSeed, seededId } from '../rng'
import type {
  EnergyContract,
  LabId,
  MapRegion,
  RegionInterconnection,
  SimState,
  SiteCapacity,
  SiteProject,
} from '../types'
import { getLab, syncLabIndex, updateLab } from './labEngine'

const MIN_SITE_MW = 1
const MAX_SITE_MW = 500

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value))
}

function labExists(state: SimState, labId: LabId): boolean {
  return labId === state.playerLabId || state.rivals.some((rival) => rival.id === labId)
}

function regionFor(state: SimState, regionId: string): MapRegion | undefined {
  return state.map.regions.find((region) => region.id === regionId)
}

function pushAlert(
  state: SimState,
  severity: 'info' | 'warn' | 'danger',
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: seededId('site-energy-alert', state.seed, state.day, severity, message),
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

function pushNews(state: SimState, message: string): SimState {
  return { ...state, news: [`Day ${state.day}: ${message}`, ...state.news].slice(0, 48) }
}

function adjustLabCash(state: SimState, labId: LabId, delta: number): SimState {
  if (Math.abs(delta) <= 1e-9) return state
  return updateLab(state, labId, (lab) => {
    const cash = lab.cash + delta
    return { ...lab, cash, finance: { ...lab.finance, cash } }
  })
}

function chargeEnergyExpense(state: SimState, labId: LabId, amount: number): SimState {
  if (amount <= 0) return state
  let next = updateLab(state, labId, (lab) => {
    const cash = lab.cash - amount
    const servingShare = Math.max(
      0,
      Math.min(1, lab.allocation.inference),
    )
    const servingCost = amount * servingShare
    const channelRevenue = lab.finance.apiRevenue + lab.finance.subRevenue
    const apiShare =
      channelRevenue > 0 ? lab.finance.apiRevenue / channelRevenue : 0.5
    return {
      ...lab,
      cash,
      finance: {
        ...lab.finance,
        cash,
        dayEnergyCost: lab.finance.dayEnergyCost + amount,
        dayEnergyOther:
          lab.finance.dayEnergyOther + amount - servingCost,
        dayCogs: lab.finance.dayCogs + servingCost,
        apiCogs: lab.finance.apiCogs + servingCost * apiShare,
        subCogs: lab.finance.subCogs + servingCost * (1 - apiShare),
        dayGrossProfit: lab.finance.dayGrossProfit - servingCost,
        dayTotalOut: lab.finance.dayTotalOut + amount,
        dayNet: lab.finance.dayNet - amount,
        lifetimeNet: lab.finance.lifetimeNet - amount,
        lifetimeProductCogs:
          lab.finance.lifetimeProductCogs + servingCost,
      },
    }
  })
  if (labId === next.playerLabId && next.financeHistory.length > 0) {
    next = {
      ...next,
      financeHistory: next.financeHistory.map((sample, index) =>
        index === next.financeHistory.length - 1 && sample.day === next.day
          ? {
              ...sample,
              cash: sample.cash - amount,
              energy: sample.energy + amount,
              productCogs: sample.productCogs + amount * Math.max(
                0,
                Math.min(1, next.player.allocation.inference),
              ),
              net: sample.net - amount,
            }
          : sample,
      ),
    }
  }
  return next
}

/** Stable finite interconnection pools derived from the pinned campaign map. */
export function createRegionInterconnections(
  regions: readonly MapRegion[],
): RegionInterconnection[] {
  return regions.map((region) => {
    const scale = Math.sqrt(Math.max(1, region.width * region.height))
    const regulationFactor = clamp(0.72, 1.08, 1.04 - region.regulationRisk * 0.2)
    const firmCapacityMw = Math.round(clamp(64, 1_200, (48 + scale * 4) * regulationFactor))
    return { regionId: region.id, firmCapacityMw, allocatedMw: 0, queuedMw: 0 }
  })
}

/**
 * Rebuild derived allocation and queue totals without changing finite regional
 * supply. This also gives early v4 saves safe defaults for the new ledgers.
 */
export function normalizeSiteEnergyState(state: SimState): SimState {
  const projects = state.siteProjects ?? []
  const capacities = state.siteCapacities ?? []
  const energyContracts = state.energyContracts ?? []
  const defaults = createRegionInterconnections(state.map.regions)
  const existing = new Map(
    (state.regionInterconnections ?? []).map((grid) => [grid.regionId, grid]),
  )
  const knownProjectIds = new Set(projects.map((project) => project.id))

  const regionInterconnections = defaults.map((fallback) => {
    const saved = existing.get(fallback.regionId)
    const allocatedFromProjects = projects
      .filter(
        (project) =>
          project.regionId === fallback.regionId &&
          (project.status === 'construction' ||
            project.status === 'commissioning' ||
            project.status === 'complete'),
      )
      .reduce(
        (sum, project) => sum + Math.max(0, project.gridAllocatedMw ?? project.targetMw),
        0,
      )
    const allocatedFromOrphanSites = capacities
      .filter(
        (capacity) =>
          capacity.regionId === fallback.regionId &&
          capacity.status === 'active' &&
          !knownProjectIds.has(capacity.projectId),
      )
      .reduce((sum, capacity) => sum + Math.max(0, capacity.firmMw), 0)
    const queuedMw = projects
      .filter(
        (project) =>
          project.regionId === fallback.regionId && project.status === 'grid_queue',
      )
      .reduce((sum, project) => sum + Math.max(0, project.gridQueueMw || project.targetMw), 0)
    return {
      regionId: fallback.regionId,
      firmCapacityMw: Math.max(1, saved?.firmCapacityMw ?? fallback.firmCapacityMw),
      allocatedMw: allocatedFromProjects + allocatedFromOrphanSites,
      queuedMw,
    }
  })

  return {
    ...state,
    siteProjects: projects,
    siteCapacities: capacities,
    energyContracts,
    regionInterconnections,
  }
}

function gridFor(state: SimState, regionId: string): RegionInterconnection | undefined {
  const normalized = normalizeSiteEnergyState(state)
  return normalized.regionInterconnections.find((grid) => grid.regionId === regionId)
}

function normalizedSiteMw(targetMw: number): number {
  return Math.round(clamp(MIN_SITE_MW, MAX_SITE_MW, targetMw || MIN_SITE_MW) * 10) / 10
}

function siteLeadDays(
  state: SimState,
  route: SiteProject['route'],
  labId: LabId,
  regionId: string,
  targetMw: number,
): number {
  const pack = state.industryDataPack
  const range =
    route === 'colocation'
      ? pack.infrastructure.colocationLeadDays
      : pack.infrastructure.ownedLeadDays
  const span = range[1] - range[0] + 1
  return range[0] + (hashSeed(state.seed, route, labId, regionId, targetMw, 'site-lead') % span)
}

function siteCapex(route: SiteProject['route'], targetMw: number): number {
  return Math.round(
    route === 'colocation'
      ? 250_000 + targetMw * 900_000
      : 2_000_000 + targetMw * 7_500_000,
  )
}

export interface SiteProjectRequest {
  labId: LabId
  route: SiteProject['route']
  regionId: string
  targetMw: number
  name?: string
}

export interface SiteProjectQuote {
  project: SiteProject
  canStart: boolean
  reason?: string
  constructionDays: number
  availableGridMw: number
  upfrontCash: number
}

/** Quote a project without reserving grid capacity or cash. */
export function quoteSiteProject(
  state: SimState,
  request: SiteProjectRequest,
): SiteProjectQuote {
  const normalized = normalizeSiteEnergyState(syncLabIndex(state))
  const region = regionFor(normalized, request.regionId)
  const targetMw = normalizedSiteMw(request.targetMw)
  const grid = gridFor(normalized, request.regionId)
  const constructionDays = siteLeadDays(
    normalized,
    request.route,
    request.labId,
    request.regionId,
    targetMw,
  )
  const capexTotal = siteCapex(request.route, targetMw)
  const labKnown = labExists(normalized, request.labId)
  const labCash = labKnown ? getLab(normalized, request.labId).cash : 0
  const canFitRegion = grid != null && targetMw <= grid.firmCapacityMw + 1e-9
  const canStart = region != null && labKnown && canFitRegion && labCash + 1e-9 >= capexTotal
  const reason = !region
    ? 'That infrastructure region does not exist.'
    : !labKnown
      ? 'That lab does not exist.'
      : !canFitRegion
        ? `${region.name} cannot interconnect a single ${targetMw.toFixed(1)} MW project.`
        : labCash + 1e-9 < capexTotal
          ? `The project requires $${capexTotal.toLocaleString()} upfront.`
          : undefined
  const id = seededId(
    'site-project',
    normalized.seed,
    normalized.day,
    request.labId,
    request.route,
    request.regionId,
    targetMw,
    normalized.siteProjects.length,
  )
  return {
    project: {
      id,
      labId: request.labId,
      name:
        request.name?.trim() ||
        `${region?.name ?? request.regionId} ${request.route === 'owned' ? 'Campus' : 'Colocation'}`,
      route: request.route,
      regionId: request.regionId,
      targetMw,
      gridQueueMw: targetMw,
      capexTotal,
      capexPaid: 0,
      startDay: normalized.day,
      completionDay: normalized.day + constructionDays,
      constructionDays,
      gridAllocatedMw: 0,
      status: 'planning',
    },
    canStart,
    reason,
    constructionDays,
    availableGridMw: Math.max(0, (grid?.firmCapacityMw ?? 0) - (grid?.allocatedMw ?? 0)),
    upfrontCash: capexTotal,
  }
}

/** Pay capex and enter the shared regional grid queue. */
export function startSiteProject(
  state: SimState,
  quoteOrProject: SiteProjectQuote | SiteProject,
): SimState {
  const supplied = 'project' in quoteOrProject ? quoteOrProject.project : quoteOrProject
  let next = normalizeSiteEnergyState(syncLabIndex(state))
  if (next.siteProjects.some((project) => project.id === supplied.id)) {
    return pushAlert(next, 'warn', 'That site project is already on the books.')
  }
  const fresh = quoteSiteProject(next, {
    labId: supplied.labId,
    route: supplied.route,
    regionId: supplied.regionId,
    targetMw: supplied.targetMw,
    name: supplied.name,
  })
  if (!fresh.canStart) return pushAlert(next, 'warn', fresh.reason ?? 'The site cannot start.')

  const project: SiteProject = {
    ...fresh.project,
    id: supplied.id,
    status: 'grid_queue',
    startDay: next.day,
    completionDay: next.day + fresh.constructionDays,
    capexPaid: fresh.project.capexTotal,
  }
  next = adjustLabCash(next, project.labId, -project.capexTotal)
  next = normalizeSiteEnergyState({
    ...next,
    siteProjects: [...next.siteProjects, project],
  })
  return pushNews(
    next,
    `${getLab(next, project.labId).name} commits $${project.capexTotal.toLocaleString()} to ${project.name} and enters the ${regionFor(next, project.regionId)?.name ?? project.regionId} grid queue.`,
  )
}

function cancellationRefund(project: SiteProject, day: number): number {
  if (project.status === 'grid_queue') return project.capexPaid * 0.85
  if (project.status === 'construction') {
    const duration = Math.max(1, project.constructionDays ?? project.completionDay - project.startDay)
    const remaining = clamp(0, 1, (project.completionDay - day) / duration)
    return project.capexPaid * (0.2 + remaining * 0.35)
  }
  if (project.status === 'commissioning') return project.capexPaid * 0.12
  return 0
}

/** Cancel an unfinished project, release any grid award, and recover a conservative refund. */
export function cancelSiteProject(state: SimState, projectId: string): SimState {
  let next = normalizeSiteEnergyState(syncLabIndex(state))
  const project = next.siteProjects.find((candidate) => candidate.id === projectId)
  if (!project || project.status === 'cancelled') return next
  if (project.status === 'complete') {
    return pushAlert(next, 'warn', 'A commissioned site must be sold, not cancelled.')
  }
  const refund = Math.floor(cancellationRefund(project, next.day))
  next = adjustLabCash(next, project.labId, refund)
  next = normalizeSiteEnergyState({
    ...next,
    siteProjects: next.siteProjects.map((candidate) =>
      candidate.id === projectId
        ? {
            ...candidate,
            status: 'cancelled' as const,
            gridQueueMw: 0,
            gridAllocatedMw: 0,
            cancelledDay: next.day,
          }
        : candidate,
    ),
  })
  return pushNews(
    next,
    `${getLab(next, project.labId).name} cancels ${project.name} and recovers $${refund.toLocaleString()}.`,
  )
}

function queueOrder(a: SiteProject, b: SiteProject): number {
  return a.startDay - b.startDay || a.id.localeCompare(b.id)
}

/** Resolve finite regional awards, construction, commissioning, and site delivery. */
export function tickSiteProjects(state: SimState): SimState {
  let next = normalizeSiteEnergyState(syncLabIndex(state))
  let projects = next.siteProjects.map((project) => ({ ...project }))
  const news: string[] = []
  const playerCompletions: string[] = []

  for (const grid of [...next.regionInterconnections].sort((a, b) =>
    a.regionId.localeCompare(b.regionId),
  )) {
    let availableMw = Math.max(0, grid.firmCapacityMw - grid.allocatedMw)
    const queued = projects
      .filter(
        (project) => project.regionId === grid.regionId && project.status === 'grid_queue',
      )
      .sort(queueOrder)
    for (const project of queued) {
      if (project.targetMw > availableMw + 1e-9) continue
      const index = projects.findIndex((candidate) => candidate.id === project.id)
      const constructionDays = Math.max(
        project.route === 'colocation' ? 90 : 180,
        project.constructionDays ?? project.completionDay - project.startDay,
      )
      projects[index] = {
        ...project,
        status: 'construction',
        gridQueueMw: 0,
        gridAllocatedMw: project.targetMw,
        constructionDays,
        completionDay: next.day + constructionDays,
      }
      availableMw -= project.targetMw
      news.push(
        `${getLab(next, project.labId).name} receives a ${project.targetMw.toFixed(1)} MW grid award for ${project.name}.`,
      )
    }
  }

  const capacities = [...next.siteCapacities]
  projects = projects.map((project) => {
    if (project.status !== 'construction' && project.status !== 'commissioning') return project
    if (next.day >= project.completionDay) {
      if (!capacities.some((capacity) => capacity.projectId === project.id)) {
        const capacity: SiteCapacity = {
          id: seededId('site-capacity', next.seed, project.id),
          projectId: project.id,
          labId: project.labId,
          route: project.route,
          regionId: project.regionId,
          siteMw: project.targetMw,
          firmMw: project.targetMw,
          commissionedDay: next.day,
          status: 'active',
        }
        capacities.push(capacity)
      }
      news.push(
        `${getLab(next, project.labId).name} commissions ${project.name} with ${project.targetMw.toFixed(1)} MW of firm site capacity.`,
      )
      if (project.labId === next.playerLabId) playerCompletions.push(project.name)
      return { ...project, status: 'complete', completedDay: next.day }
    }
    const constructionDays = Math.max(1, project.constructionDays ?? 180)
    const commissioningDays = clamp(7, 30, Math.round(constructionDays * 0.08))
    if (next.day >= project.completionDay - commissioningDays) {
      return { ...project, status: 'commissioning' }
    }
    return project
  })

  next = normalizeSiteEnergyState({ ...next, siteProjects: projects, siteCapacities: capacities })
  if (news.length > 0) {
    next = { ...next, news: [...news.map((item) => `Day ${next.day}: ${item}`), ...next.news].slice(0, 48) }
  }
  for (const name of playerCompletions) {
    next = pushAlert(next, 'info', `${name} commissioned. Firm site power is now usable.`)
  }
  return next
}

export function labFirmSiteCapacityMw(
  state: SimState,
  labId: LabId,
  regionId?: string,
): number {
  return (state.siteCapacities ?? [])
    .filter(
      (capacity) =>
        capacity.labId === labId &&
        capacity.status === 'active' &&
        (regionId == null || capacity.regionId === regionId),
    )
    .reduce((sum, capacity) => sum + capacity.firmMw, 0)
}

function contractableSiteMw(state: SimState, labId: LabId, regionId: string): number {
  const commissioned = labFirmSiteCapacityMw(state, labId, regionId)
  const pipeline = (state.siteProjects ?? [])
    .filter(
      (project) =>
        project.labId === labId &&
        project.regionId === regionId &&
        (project.status === 'grid_queue' ||
          project.status === 'construction' ||
          project.status === 'commissioning'),
    )
    .reduce((sum, project) => sum + project.targetMw, 0)
  return commissioned + pipeline
}

export interface EnergyContractRequest {
  labId: LabId
  kind: EnergyContract['kind']
  regionId: string
  mw: number
  termDays: number
}

export interface EnergyContractQuote {
  contract: EnergyContract
  canSign: boolean
  reason?: string
  dailyTakeOrPayCost: number
  availableSiteMw: number
}

function normalizedEnergyTerm(kind: EnergyContract['kind'], termDays: number): number {
  const days = Math.max(1, Math.floor(termDays) || 1)
  return kind === 'ppa' ? clamp(365, 3_650, days) : clamp(90, 720, days)
}

/** Quote fixed-price utility or renewable PPA supply against a lab's site pipeline. */
export function quoteEnergyContract(
  state: SimState,
  request: EnergyContractRequest,
): EnergyContractQuote {
  const normalized = normalizeSiteEnergyState(syncLabIndex(state))
  const region = regionFor(normalized, request.regionId)
  const labKnown = labExists(normalized, request.labId)
  const mw = normalizedSiteMw(request.mw)
  const termDays = normalizedEnergyTerm(request.kind, request.termDays)
  const alreadyContracted = normalized.energyContracts
    .filter(
      (contract) =>
        contract.labId === request.labId &&
        contract.regionId === request.regionId &&
        contract.status === 'active',
    )
    .reduce((sum, contract) => sum + contract.mw, 0)
  const availableSiteMw = Math.max(
    0,
    contractableSiteMw(normalized, request.labId, request.regionId) - alreadyContracted,
  )
  const spotPrice =
    normalized.map.energyPricePerMWh * Math.max(0.5, region?.energyPriceMult ?? 1)
  const termDiscount = clamp(0.82, 1, 1 - (termDays - 90) / 12_000)
  const pricePerMWh = Math.max(
    1,
    spotPrice * (request.kind === 'ppa' ? 0.82 : 0.94) * termDiscount,
  )
  const dailyTakeOrPayCost = mw * 24 * pricePerMWh
  const canSign = region != null && labKnown && availableSiteMw + 1e-9 >= mw
  const reason = !region
    ? 'That energy region does not exist.'
    : !labKnown
      ? 'That lab does not exist.'
      : availableSiteMw + 1e-9 < mw
        ? `Only ${availableSiteMw.toFixed(1)} MW of uncontracted site capacity is available.`
        : undefined
  const id = seededId(
    'energy-contract',
    normalized.seed,
    normalized.day,
    request.labId,
    request.kind,
    request.regionId,
    mw,
    termDays,
    normalized.energyContracts.length,
  )
  const counterparty =
    request.kind === 'ppa'
      ? `${region?.name ?? request.regionId} Renewable Cooperative`
      : `${region?.name ?? request.regionId} Grid Utility`
  return {
    contract: {
      id,
      labId: request.labId,
      kind: request.kind,
      takeOrPay: true,
      counterparty,
      regionId: request.regionId,
      cityId: request.regionId,
      cityName: region?.name ?? request.regionId,
      mw,
      pricePerMWh,
      daysLeft: termDays,
      daysTotal: termDays,
      status: 'offered',
      terminationFee: dailyTakeOrPayCost * termDays * 0.2,
    },
    canSign,
    reason,
    dailyTakeOrPayCost,
    availableSiteMw,
  }
}

/** Sign a still-valid quote; power is billed even before the associated site is ready. */
export function signEnergyContract(
  state: SimState,
  quoteOrContract: EnergyContractQuote | EnergyContract,
): SimState {
  const supplied = 'contract' in quoteOrContract ? quoteOrContract.contract : quoteOrContract
  let next = normalizeSiteEnergyState(syncLabIndex(state))
  if (next.energyContracts.some((contract) => contract.id === supplied.id)) {
    return pushAlert(next, 'warn', 'That energy contract is already on the books.')
  }
  const fresh = quoteEnergyContract(next, {
    labId: supplied.labId,
    kind: supplied.kind,
    regionId: supplied.regionId,
    mw: supplied.mw,
    termDays: supplied.daysTotal,
  })
  if (!fresh.canSign) {
    return pushAlert(next, 'warn', fresh.reason ?? 'The energy contract cannot be signed.')
  }
  const contract: EnergyContract = {
    ...fresh.contract,
    id: supplied.id,
    status: 'active',
    signedDay: next.day,
  }
  next = { ...next, energyContracts: [...next.energyContracts, contract] }
  return pushNews(
    next,
    `${getLab(next, contract.labId).name} signs ${contract.mw.toFixed(1)} MW of ${contract.kind.toUpperCase()} power with ${contract.counterparty}.`,
  )
}

/** End a contract and settle the declining 20% break fee against remaining value. */
export function terminateEnergyContract(state: SimState, contractId: string): SimState {
  let next = normalizeSiteEnergyState(syncLabIndex(state))
  const contract = next.energyContracts.find((candidate) => candidate.id === contractId)
  if (!contract || contract.status === 'expired' || contract.status === 'terminated') return next
  const remainingValue = contract.mw * 24 * contract.pricePerMWh * contract.daysLeft
  const fee = contract.status === 'active'
    ? Math.min(contract.terminationFee, remainingValue * 0.2)
    : 0
  next = adjustLabCash(next, contract.labId, -fee)
  next = {
    ...next,
    energyContracts: next.energyContracts.map((candidate) =>
      candidate.id === contractId
        ? { ...candidate, status: 'terminated' as const, daysLeft: 0 }
        : candidate,
    ),
  }
  return pushNews(
    next,
    `${getLab(next, contract.labId).name} terminates its ${contract.kind.toUpperCase()} with a $${Math.round(fee).toLocaleString()} break fee.`,
  )
}

/** Daily take-or-pay settlement, symmetric for the player and every rival. */
export function tickEnergyContracts(state: SimState): SimState {
  let next = normalizeSiteEnergyState(syncLabIndex(state))
  const contracts: EnergyContract[] = []
  const expiries: string[] = []

  for (const original of next.energyContracts) {
    if (original.status !== 'active') {
      contracts.push(original)
      continue
    }
    const invoice = original.mw * 24 * original.pricePerMWh
    next = chargeEnergyExpense(next, original.labId, invoice)
    const daysLeft = Math.max(0, original.daysLeft - 1)
    const contract: EnergyContract = {
      ...original,
      daysLeft,
      status: daysLeft === 0 ? 'expired' : 'active',
    }
    if (contract.status === 'expired') expiries.push(contract.id)
    contracts.push(contract)
  }

  next = { ...next, energyContracts: contracts }
  if (expiries.length > 0) {
    next = {
      ...next,
      news: [
        `Day ${next.day}: ${expiries.length} long-term energy contract${expiries.length === 1 ? '' : 's'} expired.`,
        ...next.news,
      ].slice(0, 48),
    }
  }
  return next
}
