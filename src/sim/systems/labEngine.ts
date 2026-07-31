import { createRng, hashSeed } from '../rng'
import type {
  Allocation,
  CanonicalLabField,
  ComputeContract,
  FabProject,
  LabFinance,
  LabId,
  LabIntent,
  LabState,
  PlayerState,
  RivalLab,
  RivalPublicEstimate,
  SimState,
  StaffHeadcount,
  WorldMarkets,
} from '../types'
import { RACK_SKU_CATALOG } from '../balance/rackSkus'
import { RESEARCH_NODES } from '../balance/research'
import { labContractCapacityPf } from './computeContracts'
import { resolveRackSku } from './racks'
import { campusBonusesForLab } from './campus'
import { fleetPowerDraw, powerDerateForSupply } from './computePower'
import {
  labFacilityEnergyTotals,
  isDcAnchor,
  isDcKind,
  resolveLabPowerMw,
} from './map'
import { mapTileAtAny } from './worldAccess'
import {
  hardwareTokPerSecFromPf,
  labInferCapacityWorkPf,
} from './labCompute'
import { HISTORY_LIMITS } from './history'
import { ensureRackUnitIds } from './dataHallLayouts'
import { pfPerMTokForModel } from '../balance/tokenServe'
import { servingPlacementNeedForLab } from './servingPlacement'

const EMPTY_STAFF: StaffHeadcount = {
  researcher: 0,
  data_processor: 0,
  engineer: 0,
  ops: 0,
}

const EMPTY_FAB: FabProject = {
  phase: 'idle',
  daysInPhase: 0,
  daysRequired: 0,
  cashSunk: 0,
  yieldRate: 0.35,
  designPerfPerWatt: 2.2,
  chipsProduced: 0,
  failed: false,
  designFocus: 'balanced',
  designTechIds: [],
}

function financeFromRival(rival: RivalLab): LabFinance {
  if (rival.finance) return { ...rival.finance, cash: rival.cash }
  const valuation = Math.max(1, rival.cash * 1.35 + (rival.dayRevenue ?? 0) * 120)
  return {
    cash: rival.cash,
    dayRevenue: rival.dayRevenue ?? 0,
    dayCogs: 0,
    dayEnergyCost: 0,
    dayWageCost: 0,
    dayChipAmort: 0,
    dayBuildingOpex: 0,
    dayMarketing: 0,
    dayLoanPayment: 0,
    dayEnergyOther: 0,
    dayChipAmortOther: 0,
    apiRevenue: rival.dayRevenue ?? 0,
    subRevenue: 0,
    enterpriseRevenue: 0,
    apiCogs: 0,
    subCogs: 0,
    dayGrossProfit: rival.dayRevenue ?? 0,
    dayNet: 0,
    dayTotalOut: 0,
    marginPerSub: 0,
    marginPerMTok: 0,
    totalShare: rival.marketShare,
    valuation,
    lifetimeRevenue: 0,
    lifetimeNet: 0,
    lifetimeProductCogs: 0,
    peakCash: rival.cash,
    lowestCash: rival.cash,
    runwayDays: Number.POSITIVE_INFINITY,
    debtOutstanding: 0,
  }
}

function contractBelongsToLab(contract: ComputeContract, labId: LabId): boolean {
  return contract.buyerLabId === labId || contract.sellerLabId === labId
}

function contractsForLab(contracts: ComputeContract[], labId: LabId): ComputeContract[] {
  return contracts.filter((contract) => contractBelongsToLab(contract, labId))
}

/**
 * Replace one lab's view of the provider-neutral contract book without
 * disturbing contracts owned exclusively by other labs. The top-level book
 * remains authoritative; the per-lab list is only its filtered projection.
 */
function mergeLabContracts(
  contracts: ComputeContract[],
  labId: LabId,
  replacement: ComputeContract[],
): ComputeContract[] {
  const relevantReplacement = replacement.filter((contract) =>
    contractBelongsToLab(contract, labId),
  )
  const replacementById = new Map(
    relevantReplacement.map((contract) => [contract.id, contract]),
  )
  const seen = new Set<string>()
  const merged: ComputeContract[] = []

  for (const contract of contracts) {
    if (!contractBelongsToLab(contract, labId)) {
      merged.push(contract)
      continue
    }
    const next = replacementById.get(contract.id)
    if (!next || seen.has(next.id)) continue
    merged.push(next)
    seen.add(next.id)
  }
  for (const contract of relevantReplacement) {
    if (seen.has(contract.id)) continue
    merged.push(contract)
    seen.add(contract.id)
  }
  return merged
}

const CANONICAL_LAB_FIELDS: readonly CanonicalLabField[] = [
  'capital',
  'computeContracts',
  'researchLeads',
  'researchPods',
  'researchPrograms',
  'trainingPrograms',
  'data',
]

type RuntimeLabBaseline = Record<
  LabId,
  Partial<Record<CanonicalLabField, unknown>>
>

// Runtime reference baselines make the daily merge O(fields) without
// repeatedly serializing large data manifests. Persisted fingerprints are the
// fallback for the first merge after loading a save.
const runtimeLabBaselines = new WeakMap<object, RuntimeLabBaseline>()

function canonicalFingerprint(value: unknown): string {
  const serialized = JSON.stringify(value) ?? 'undefined'
  return `${serialized.length}:${hashSeed('lab-sync-a', serialized)}:${hashSeed('lab-sync-b', serialized)}`
}

/**
 * Three-way merge against the last agreed value. Canonical-only and
 * compatibility-only edits both survive; a true simultaneous conflict is the
 * explicit authority boundary and therefore resolves to canonical LabState.
 */
function canonicalFieldWins(
  canonicalValue: unknown,
  compatibilityValue: unknown,
  baseline: string | undefined,
  runtimeBaseline: unknown,
  hasRuntimeBaseline: boolean,
): boolean {
  if (hasRuntimeBaseline) {
    if (Object.is(canonicalValue, compatibilityValue)) return false
    const canonicalChanged = !Object.is(canonicalValue, runtimeBaseline)
    const compatibilityChanged = !Object.is(compatibilityValue, runtimeBaseline)
    if (canonicalChanged && compatibilityChanged) {
      // Separate immutable copies can still represent the same agreed value.
      return canonicalFingerprint(canonicalValue) !== canonicalFingerprint(compatibilityValue)
    }
    if (canonicalChanged) return true
    if (compatibilityChanged) return false
    return true
  }
  const canonical = canonicalFingerprint(canonicalValue)
  const compatibility = canonicalFingerprint(compatibilityValue)
  if (canonical === compatibility) return false
  if (baseline == null) return true
  const canonicalChanged = canonical !== baseline
  const compatibilityChanged = compatibility !== baseline
  if (canonicalChanged) return true
  if (compatibilityChanged) return false
  return true
}

function runtimeBaselineForLabs(labs: Record<LabId, LabState>): RuntimeLabBaseline {
  return Object.fromEntries(
    Object.entries(labs).map(([id, lab]) => [
      id,
      Object.fromEntries(CANONICAL_LAB_FIELDS.map((field) => [field, lab[field]])),
    ]),
  )
}

function fingerprintsForAgreedLabs(
  labs: Record<LabId, LabState>,
  previousSync: SimState['labSync'],
  previousRuntime: RuntimeLabBaseline | undefined,
): Record<LabId, Partial<Record<CanonicalLabField, string>>> {
  return Object.fromEntries(
    Object.entries(labs).map(([id, lab]) => [
      id,
      Object.fromEntries(
        CANONICAL_LAB_FIELDS.map((field) => {
          const previousFingerprint = previousSync?.canonicalFingerprints?.[id]?.[field]
          return [
            field,
            // Runtime reference baselines are authoritative between explicit
            // save boundaries. Avoid O(history²) serialization as canonical
            // datasets grow; persistence refreshes every fingerprint once.
            previousFingerprint != null && previousRuntime?.[id] != null
              ? previousFingerprint
              : canonicalFingerprint(lab[field]),
          ]
        }),
      ),
    ]),
  )
}

function setCanonicalField(
  target: LabState,
  field: CanonicalLabField,
  value: unknown,
): void {
  ;(target as unknown as Record<CanonicalLabField, unknown>)[field] = value
}

function projectCanonicalFieldsToPlayer(player: PlayerState, lab: LabState): PlayerState {
  return {
    ...player,
    capital: lab.capital,
    computeContracts: lab.computeContracts,
    researchLeads: lab.researchLeads,
    researchPods: lab.researchPods,
    researchPrograms: lab.researchPrograms,
    trainingPrograms: lab.trainingPrograms,
    data: lab.data,
  }
}

function projectCanonicalFieldsToRival(rival: RivalLab, lab: LabState): RivalLab {
  return {
    ...rival,
    capital: lab.capital,
    computeContracts: lab.computeContracts,
    researchLeads: lab.researchLeads,
    researchPods: lab.researchPods,
    researchPrograms: lab.researchPrograms,
    trainingPrograms: lab.trainingPrograms,
    data: lab.data,
  }
}

function advanceRuntimeBaselineAfterUpdate(
  state: SimState,
  labId: LabId,
  contractsChanged: boolean,
): void {
  if (!state.labSync) return
  const runtime = runtimeLabBaselines.get(state.labSync)
  if (!runtime) return
  const updated = state.labs[labId]
  if (updated) {
    const target = runtime[labId] ?? {}
    for (const field of CANONICAL_LAB_FIELDS) target[field] = updated[field]
    runtime[labId] = target
  }

  if (contractsChanged) {
    for (const id of [state.playerLabId, ...state.rivals.map((rival) => rival.id)]) {
      if (id === labId) continue
      const lab = state.labs[id]
      if (!lab) continue
      const projected = contractsForLab(state.computeContracts, id)
      // Do not bless a conflicting, unsynchronized canonical edit in another
      // lab merely because this lab changed the shared contract book.
      if (canonicalFingerprint(lab.computeContracts) !== canonicalFingerprint(projected)) continue
      const target = runtime[id] ?? {}
      target.computeContracts = lab.computeContracts
      runtime[id] = target
    }
  }
}

type PlayerLabContext = Pick<SimState, 'playerLabId' | 'map'> &
  Partial<Pick<SimState, 'computeContracts'>>

export function playerToLab(player: PlayerState, state: PlayerLabContext): LabState {
  const computeContracts = state.computeContracts
    ? contractsForLab(state.computeContracts, state.playerLabId)
    : player.computeContracts
  return {
    id: state.playerLabId,
    name: player.name,
    controller: 'player',
    archetype: 'player',
    regionId: state.map.activeRegionId,
    color: 0x48d7d1,
    cash: player.cash,
    finance: { ...player.finance, cash: player.cash },
    loans: [...(player.loans ?? [])],
    capital: player.capital,
    computeContracts,
    allocation: { ...player.allocation },
    utilCap: player.utilCap,
    servingEfficiency: player.servingEfficiency,
    trainEfficiency: player.trainEfficiency,
    pue: player.pue,
    staff: { ...(player.staff ?? EMPTY_STAFF) },
    researchLeads: player.researchLeads,
    researchPods: player.researchPods,
    researchPrograms: player.researchPrograms,
    trainingPrograms: player.trainingPrograms,
    dataQuality: player.dataQuality,
    data: player.data,
    brandTrust: player.brandTrust,
    servicePain: player.servicePain,
    researchUnlocked: [...player.researchUnlocked],
    activeResearch: player.activeResearch,
    researchQueue: [...player.researchQueue],
    models: player.models,
    trainingJob: player.trainingJob,
    pricing: player.pricing,
    rackFleet: player.rackFleet,
    rackDesigns: player.rackDesigns,
    fab: player.fab,
    marketingSpendPerDay: player.marketingSpendPerDay,
    marketingRevenueMultiple: player.marketingRevenueMultiple,
    marketingChannels: player.marketingChannels,
    enterpriseContracts: player.enterpriseContracts,
    wagesPerDay: player.wagesPerDay,
    abstractFlopsPf: 0,
    abstractChipCount: 0,
    marketShare: player.finance.totalShare,
  }
}

export function rivalToLab(rival: RivalLab, contracts?: ComputeContract[]): LabState {
  return {
    id: rival.id,
    name: rival.name,
    controller: 'rival',
    archetype: rival.archetype,
    regionId: rival.regionId,
    color: rival.color,
    cash: rival.cash,
    finance: financeFromRival(rival),
    loans: [...(rival.loans ?? [])],
    capital: rival.capital,
    computeContracts: contracts
      ? contractsForLab(contracts, rival.id)
      : rival.computeContracts,
    allocation: { ...rival.allocation },
    utilCap: rival.utilCap,
    servingEfficiency: rival.servingEfficiency,
    trainEfficiency: rival.trainEfficiency ?? 0.6,
    pue: rival.pue ?? 1.42,
    staff: { ...(rival.staff ?? EMPTY_STAFF) },
    researchLeads: rival.researchLeads,
    researchPods: rival.researchPods,
    researchPrograms: rival.researchPrograms,
    trainingPrograms: rival.trainingPrograms,
    dataQuality: rival.dataQuality,
    data: rival.data!,
    brandTrust: rival.brandTrust,
    servicePain: rival.servicePain ?? 0,
    researchUnlocked: [...rival.researchUnlocked],
    activeResearch: rival.activeResearch,
    researchQueue: [...(rival.researchQueue ?? [])],
    models: rival.models,
    trainingJob: rival.trainingJob ?? null,
    pricing: rival.pricing,
    rackFleet: rival.rackFleet ?? [],
    rackDesigns: rival.rackDesigns ?? [],
    fab: rival.fab ?? EMPTY_FAB,
    marketingSpendPerDay: rival.marketingSpendPerDay ?? 0,
    marketingRevenueMultiple: rival.marketingRevenueMultiple,
    marketingChannels: rival.marketingChannels,
    enterpriseContracts: rival.enterpriseContracts ?? 0,
    wagesPerDay: rival.wagesPerDay ?? 0,
    abstractFlopsPf: rival.flopsPf,
    abstractChipCount: rival.chips,
    marketShare: rival.marketShare,
    publicEstimate: rival.publicEstimate,
  }
}

export function createWorldMarkets(): WorldMarkets {
  return {
    cloudProviders: [
      {
        id: 'cloud-northstar',
        name: 'Northstar Compute',
        regionId: 'global-cloud',
        baselinePf: 1_200,
        availablePf: 1_176,
        basePricePerPfDay: 120,
        reliability: 0.997,
        spotVolatility: 0.22,
        acceleratorGeneration: 2,
        supportedTrainingFormats: ['fp32', 'fp16_mixed', 'bf16_mixed', 'fp8_hybrid'],
        supportedServePrecisions: ['fp16', 'bf16', 'fp8', 'int8', 'int4', 'ternary_1_58'],
      },
      {
        id: 'cloud-meridian',
        name: 'Meridian Cloud',
        regionId: 'global-cloud',
        baselinePf: 850,
        availablePf: 850,
        basePricePerPfDay: 445,
        reliability: 0.994,
        spotVolatility: 0.3,
        acceleratorGeneration: 2,
        supportedTrainingFormats: ['fp32', 'fp16_mixed', 'bf16_mixed', 'fp8_hybrid'],
        supportedServePrecisions: ['fp16', 'bf16', 'fp8', 'int8', 'int4', 'ternary_1_58'],
      },
      {
        id: 'cloud-atlas',
        name: 'Atlas Emergency',
        regionId: 'global-cloud',
        baselinePf: 500,
        availablePf: 500,
        basePricePerPfDay: 780,
        reliability: 0.999,
        spotVolatility: 0.08,
        acceleratorGeneration: 3,
        supportedTrainingFormats: ['fp32', 'fp16_mixed', 'bf16_mixed', 'fp8_hybrid', 'nvfp4'],
        supportedServePrecisions: [
          'fp16', 'bf16', 'fp8', 'int8', 'int4', 'nvfp4', 'ternary_1_58',
        ],
      },
    ],
    accelerators: Object.fromEntries(
      RACK_SKU_CATALOG.filter((sku) => !sku.custom).map((sku, index) => [
        sku.id,
        {
          skuId: sku.id,
          available: Math.max(12, 72 - index * 8),
          dailyReplenishment: Math.max(2, 9 - index),
          reserveUnitPrice: sku.price,
          backlog: 0,
          leadTimeDays: sku.leadTimeDays,
        },
      ]),
    ),
    orders: [],
    fills: [],
    loanApplications: [],
    loanOffers: [],
    capital: {
      cycle: 0,
      baseRate: 0.08,
      creditMult: 1,
      rateSpread: 0,
      industryDebt: 0,
    },
    lastClearedDay: 0,
    intents: [],
  }
}

/**
 * Reconcile canonical v4 fields with compatibility views, then import legacy
 * operational fields. This is deliberately a three-way merge rather than a
 * rebuild, so stale PlayerState/RivalLab copies cannot erase canonical work.
 */
export function syncLabIndex(state: SimState): SimState {
  const ids = [state.playerLabId, ...state.rivals.map((rival) => rival.id)]
  const runtimeBaseline = state.labSync
    ? runtimeLabBaselines.get(state.labSync)
    : undefined
  const compatibilityById: Record<LabId, LabState> = {
    [state.playerLabId]: playerToLab(state.player, state),
  }
  for (const rival of state.rivals) {
    compatibilityById[rival.id] = rivalToLab(rival, state.computeContracts)
  }

  // Resolve direct canonical edits to a lab's contract projection back into
  // the single authoritative top-level contract book before building labs.
  const canonicalContractReplacements: { labId: LabId; contracts: ComputeContract[] }[] = []
  for (const id of ids) {
    const existing = state.labs?.[id]
    if (!existing) continue
    const compatibilityContracts = contractsForLab(state.computeContracts, id)
    const baseline = state.labSync?.canonicalFingerprints?.[id]?.computeContracts
    const runtimeContracts = runtimeBaseline?.[id]?.computeContracts
    if (
      canonicalFieldWins(
        existing.computeContracts ?? [],
        compatibilityContracts,
        baseline,
        runtimeContracts,
        runtimeBaseline?.[id] != null,
      )
    ) {
      canonicalContractReplacements.push({
        labId: id,
        contracts: existing.computeContracts ?? [],
      })
    }
  }
  let computeContracts = state.computeContracts
  for (const replacement of canonicalContractReplacements) {
    computeContracts = mergeLabContracts(
      computeContracts,
      replacement.labId,
      replacement.contracts,
    )
  }

  const labs: Record<LabId, LabState> = {}
  for (const id of ids) {
    const compatibility = compatibilityById[id]!
    const existing = state.labs?.[id]
    const merged: LabState = {
      ...compatibility,
      computeContracts: contractsForLab(computeContracts, id),
    }
    if (existing) {
      const baseline = state.labSync?.canonicalFingerprints?.[id]
      const runtime = runtimeBaseline?.[id]
      for (const field of CANONICAL_LAB_FIELDS) {
        if (field === 'computeContracts') continue
        if (
          canonicalFieldWins(
            existing[field],
            compatibility[field],
            baseline?.[field],
            runtime?.[field],
            runtime != null,
          )
        ) {
          setCanonicalField(merged, field, existing[field])
        }
      }
    }
    labs[id] = merged
  }

  const player = projectCanonicalFieldsToPlayer(state.player, labs[state.playerLabId]!)
  const rivals = state.rivals.map((rival) =>
    projectCanonicalFieldsToRival(rival, labs[rival.id]!),
  )
  const labSync = {
    version: 1 as const,
    canonicalFingerprints: fingerprintsForAgreedLabs(
      labs,
      state.labSync,
      runtimeBaseline,
    ),
  }
  runtimeLabBaselines.set(labSync, runtimeBaselineForLabs(labs))
  return {
    ...state,
    player,
    rivals,
    labs,
    computeContracts,
    labSync,
  }
}

/** Reconcile and refresh persisted fingerprints at the save boundary. */
export function syncLabIndexForPersistence(state: SimState): SimState {
  const reconciled = syncLabIndex(state)
  const labSync = {
    version: 1 as const,
    canonicalFingerprints: Object.fromEntries(
      Object.entries(reconciled.labs).map(([id, lab]) => [
        id,
        Object.fromEntries(
          CANONICAL_LAB_FIELDS.map((field) => [
            field,
            canonicalFingerprint(lab[field]),
          ]),
        ),
      ]),
    ),
  }
  runtimeLabBaselines.set(labSync, runtimeBaselineForLabs(reconciled.labs))
  return { ...reconciled, labSync }
}

export function getLab(state: SimState, labId: LabId): LabState {
  const indexed = state.labs?.[labId]
  if (indexed) {
    return {
      ...indexed,
      computeContracts: contractsForLab(state.computeContracts, labId),
    }
  }
  if (labId === state.playerLabId) return playerToLab(state.player, state)
  const rival = state.rivals.find((entry) => entry.id === labId)
  if (!rival) throw new Error(`Unknown lab ${labId}`)
  return rivalToLab(rival, state.computeContracts)
}

export function labIds(state: SimState): LabId[] {
  return [state.playerLabId, ...state.rivals.map((rival) => rival.id)]
}

export function updateLab(state: SimState, labId: LabId, updater: (lab: LabState) => LabState): SimState {
  const current = getLab(state, labId)
  const updated = updater(current)
  const contractsChanged = updated.computeContracts !== current.computeContracts
  const computeContracts =
    contractsChanged && updated.computeContracts
      ? mergeLabContracts(state.computeContracts, labId, updated.computeContracts)
      : state.computeContracts
  const next: LabState = {
    ...updated,
    computeContracts: contractsForLab(computeContracts, labId),
  }
  const labs = Object.fromEntries(
    Object.entries({ ...state.labs, [labId]: next }).map(([id, lab]) => [
      id,
      contractsChanged
        ? { ...lab, computeContracts: contractsForLab(computeContracts, id) }
        : lab,
    ]),
  ) as Record<LabId, LabState>
  if (labId === state.playerLabId) {
    const player: PlayerState = {
      ...state.player,
      name: next.name,
      cash: next.cash,
      finance: { ...next.finance, cash: next.cash },
      loans: next.loans,
      capital: next.capital,
      computeContracts: next.computeContracts,
      allocation: next.allocation,
      utilCap: next.utilCap,
      servingEfficiency: next.servingEfficiency,
      trainEfficiency: next.trainEfficiency,
      pue: next.pue,
      staff: next.staff,
      researchLeads: next.researchLeads,
      researchPods: next.researchPods,
      researchPrograms: next.researchPrograms,
      trainingPrograms: next.trainingPrograms,
      dataQuality: next.dataQuality,
      data: next.data,
      brandTrust: next.brandTrust,
      servicePain: next.servicePain,
      researchUnlocked: next.researchUnlocked,
      activeResearch:
        typeof next.activeResearch === 'string' ? state.player.activeResearch : next.activeResearch,
      researchQueue: next.researchQueue,
      models: next.models,
      trainingJob:
        next.trainingJob && 'targetParamsB' in next.trainingJob ? next.trainingJob : null,
      pricing: next.pricing,
      rackFleet: next.rackFleet,
      rackDesigns: next.rackDesigns,
      fab: next.fab,
      marketingSpendPerDay: next.marketingSpendPerDay,
      marketingRevenueMultiple: next.marketingRevenueMultiple,
      marketingChannels: next.marketingChannels,
      enterpriseContracts: next.enterpriseContracts,
      wagesPerDay: next.wagesPerDay,
    }
    const result = { ...state, player, labs, computeContracts }
    advanceRuntimeBaselineAfterUpdate(result, labId, contractsChanged)
    return result
  }
  const rivals = state.rivals.map((rival) =>
    rival.id === labId
      ? {
          ...rival,
          name: next.name,
          cash: next.cash,
          finance: { ...next.finance, cash: next.cash },
          loans: next.loans,
          capital: next.capital,
          computeContracts: next.computeContracts,
          allocation: next.allocation,
          utilCap: next.utilCap,
          servingEfficiency: next.servingEfficiency,
          trainEfficiency: next.trainEfficiency,
          pue: next.pue,
          staff: next.staff,
          researchLeads: next.researchLeads,
          researchPods: next.researchPods,
          researchPrograms: next.researchPrograms,
          trainingPrograms: next.trainingPrograms,
          dataQuality: next.dataQuality,
          data: next.data,
          brandTrust: next.brandTrust,
          servicePain: next.servicePain,
          researchUnlocked: next.researchUnlocked,
          activeResearch:
            typeof next.activeResearch === 'string' ? next.activeResearch : next.activeResearch?.nodeId ?? null,
          researchQueue: next.researchQueue,
          models: next.models,
          trainingJob:
            next.trainingJob && 'paramsB' in next.trainingJob ? next.trainingJob : null,
          pricing: next.pricing,
          rackFleet: next.rackFleet,
          rackDesigns: next.rackDesigns,
          fab: next.fab,
          marketingSpendPerDay: next.marketingSpendPerDay,
          marketingRevenueMultiple: next.marketingRevenueMultiple,
          marketingChannels: next.marketingChannels,
          enterpriseContracts: next.enterpriseContracts,
          wagesPerDay: next.wagesPerDay,
          flopsPf: next.abstractFlopsPf,
          chips: next.abstractChipCount,
          marketShare: next.marketShare,
          publicEstimate: next.publicEstimate,
        }
      : rival,
  )
  const result = { ...state, rivals, labs, computeContracts }
  advanceRuntimeBaselineAfterUpdate(result, labId, contractsChanged)
  return result
}

export interface LabComputeSnapshot {
  /** Effective capacity available to this lab after local constraints/contracts. */
  rawFlopsPf: number
  installedLocalPf: number
  availableLocalPf: number
  remoteInboundPf: number
  outboundCommittedPf: number
  chipCount: number
  vramGb: number
  systemRamGb: number
  localVramGb: number
  remoteVramGb: number
  localSystemRamGb: number
  remoteSystemRamGb: number
  localServingMemoryReady: boolean
  /** Available hardware throughput before util/allocation/model conversion. */
  hardwareTokPerSec: number
  /** Capacity in the same reference PF-work units used by inference demand. */
  inferenceWorkPf: number
  powerMw: number
  spotPowerMw: number
  powerDerate: number
  rackDerate: number
  pools: { training: number; inference: number; research: number }
}

function legacyLeaseCapacityForLab(
  state: SimState,
  labId: LabId,
): { inboundPf: number; outboundPf: number } {
  let inboundPf = 0
  let outboundPf = 0
  for (const lease of state.computeLeases ?? []) {
    if (lease.status !== 'active') continue
    const sellerLabId =
      lease.sellerLabId ??
      (lease.playerSells ? state.playerLabId : lease.rivalId)
    const buyerLabId =
      lease.buyerLabId ??
      (lease.playerSells ? lease.rivalId : state.playerLabId)
    if (buyerLabId === labId) inboundPf += Math.max(0, lease.pf)
    if (sellerLabId === labId) outboundPf += Math.max(0, lease.pf)
  }
  return { inboundPf, outboundPf }
}

function normalizedComputeAllocation(allocation: Allocation): Allocation {
  const training = Math.max(0, allocation.training)
  const inference = Math.max(0, allocation.inference)
  const research = Math.max(0, allocation.research)
  const total = training + inference + research
  if (total <= 1e-9) return { training: 0.34, inference: 0.33, research: 0.33 }
  return {
    training: training / total,
    inference: inference / total,
    research: research / total,
  }
}

export function computeLabSnapshot(state: SimState, labId: LabId): LabComputeSnapshot {
  const lab = getLab(state, labId)
  const campus = campusBonusesForLab(state, labId)
  const pue = Math.max(1.05, lab.pue - campus.pueReduction)
  // Abstract fields are compatibility representations of paid starting
  // hardware. Newly purchased physical racks add to them; they never replace
  // or duplicate them.
  let installedLocalPf = Math.max(0, lab.abstractFlopsPf)
  let installedChipCount = Math.max(0, lab.abstractChipCount)
  let installedVramGb = Math.max(0, lab.abstractChipCount) * 80
  let installedSystemRamGb = Math.max(0, lab.abstractChipCount) * 128
  let installedTokPerSec = hardwareTokPerSecFromPf(lab.abstractFlopsPf)
  let installedFullLoadMw = Math.max(0, lab.abstractFlopsPf) * 0.011
  let installedIdleMw = installedFullLoadMw * 0.3
  let rackUnitsUsed = 0
  for (const install of lab.rackFleet) {
    if (install.status !== 'live' || install.count <= 0) continue
    const hall = mapTileAtAny(state, install.x, install.y)
    if (hall && isDcKind(hall.kind) && isDcAnchor(hall) && hall.powered === false) {
      continue
    }
    let sku
    try {
      sku = resolveRackSku(install.skuId, lab.rackDesigns)
    } catch {
      // Invalid imported blueprints contribute no capacity until validation.
      continue
    }
    const normalized = ensureRackUnitIds(install)
    const facilityId = install.facilityId ?? hall?.campusId
    const layout = facilityId ? state.dataHallLayouts?.[facilityId] : undefined
    const operational = layout ? new Set(layout.analysis.operationalRackUnitIds) : null
    const placed = layout ? new Set(layout.objects.flatMap((object) => object.rackUnitId ? [object.rackUnitId] : [])) : null
    const activeCount = operational ? (normalized.unitIds ?? []).filter((unitId) => operational.has(unitId)).length : install.count
    const placedCount = placed ? (normalized.unitIds ?? []).filter((unitId) => placed.has(unitId)).length : install.count
    const throughput = layout?.analysis.throughputMultiplier ?? 1
    installedLocalPf += sku.flopsPf * activeCount * throughput
    installedChipCount += activeCount
    installedVramGb += sku.vramGb * activeCount
    installedSystemRamGb += (sku.systemRamGb ?? sku.vramGb * 4) * activeCount
    installedTokPerSec += sku.tokPerSec * activeCount * throughput
    const layoutPue = layout?.analysis.pueMultiplier ?? 1
    installedFullLoadMw += sku.mw * activeCount * layoutPue
    installedIdleMw +=
      (sku.accelerator?.idleMw ?? sku.mw * 0.3) * activeCount * layoutPue
    rackUnitsUsed += (install.rackUnits || sku.rackUnits) * placedCount
  }
  const providerContracts = labContractCapacityPf(state, labId)
  const legacyLeases = legacyLeaseCapacityForLab(state, labId)
  const remoteInboundPf = Math.max(
    0,
    providerContracts.inboundPf + legacyLeases.inboundPf,
  )
  const requestedOutboundPf = Math.max(
    0,
    providerContracts.outboundPf + legacyLeases.outboundPf,
  )

  const installedPower = fleetPowerDraw({
    fullLoadMw: installedFullLoadMw,
    idleMw: installedIdleMw,
    dutyCycle: 1,
    pue,
  })
  const power = resolveLabPowerMw(state, labId, installedPower.demandMw)
  const powerDerate = powerDerateForSupply(
    installedPower.demandMw,
    power.mwAvailable,
  ).derate
  const rackCap = labFacilityEnergyTotals(state, labId).rackCap
  const rackDerate =
    rackUnitsUsed <= 0
      ? 1
      : rackCap > 0
        ? Math.max(0.2, Math.min(1, rackCap / rackUnitsUsed))
        : 0.2
  const localHostDerate = powerDerate * rackDerate
  const hostedLocalPf = installedLocalPf * localHostDerate
  // Contracts transfer effective hosted capacity. Deducting nominal PF before
  // a brownout derate let the seller retain part (or all) of sold capacity
  // while the buyer received the full amount.
  const outboundCommittedPf = Math.min(hostedLocalPf, requestedOutboundPf)
  const availableLocalPf = Math.max(0, hostedLocalPf - outboundCommittedPf)
  const localKeep = hostedLocalPf > 1e-9 ? availableLocalPf / hostedLocalPf : 0
  const hardwareTokPerSec =
    installedTokPerSec * localHostDerate * localKeep +
    hardwareTokPerSecFromPf(remoteInboundPf)
  const rawFlopsPf = Math.max(0, availableLocalPf + remoteInboundPf)
  const remoteGpuEquivalent = remoteInboundPf / 0.7
  const chipCount = installedChipCount * localKeep + remoteGpuEquivalent
  const localVramGb = installedVramGb * localKeep
  const remoteVramGb = remoteGpuEquivalent * 80
  const localSystemRamGb = installedSystemRamGb * localKeep
  const remoteSystemRamGb = remoteGpuEquivalent * 512
  const vramGb = localVramGb + remoteVramGb
  const systemRamGb = localSystemRamGb + remoteSystemRamGb

  const activeServeModel = lab.models.find(
    (model) =>
      model.id === lab.pricing.activeModelId &&
      (model.release === 'released' || model.shipped),
  )
  const rivalDemandPf =
    labId === state.playerLabId
      ? state.lastMarket?.demandPf ?? 0
      : state.rivals.find((rival) => rival.id === labId)?.lastDemandPf ?? 0
  const demandMTok = activeServeModel
    ? rivalDemandPf /
      Math.max(
        1e-9,
        pfPerMTokForModel(activeServeModel, lab.servingEfficiency),
      )
    : 0
  const placement = servingPlacementNeedForLab({
    models: lab.models,
    pricing: lab.pricing,
    demandMTok,
  })
  const localServingMemoryReady =
    placement.hbmNeedGb <= installedVramGb * localKeep + 1e-9 &&
    placement.systemRamNeedGb <= installedSystemRamGb * localKeep + 1e-9
  const remoteServingMemoryReady =
    placement.hbmNeedGb <= remoteVramGb + 1e-9 &&
    placement.systemRamNeedGb <= remoteSystemRamGb + 1e-9

  const engineers = Math.max(0, lab.staff.engineer ?? 0)
  const engineerUtil = Math.min(0.14, engineers * 0.012)
  const engineerServe = Math.min(0.2, engineers * 0.015)
  const engineerTrain = Math.min(0.18, engineers * 0.012)
  const effectiveUtil = Math.max(
    0.2,
    Math.min(0.98, lab.utilCap * (1 + engineerUtil)),
  )
  const allocation = normalizedComputeAllocation(lab.allocation)
  const base = rawFlopsPf * effectiveUtil
  const inferenceFlopsPf =
    (localServingMemoryReady ? availableLocalPf : 0) +
    (remoteServingMemoryReady ? remoteInboundPf : 0)
  const inferenceBase = inferenceFlopsPf * effectiveUtil
  const dataGenShare = Math.max(
    0,
    Math.min(0.85, lab.data.dataGenResearchShare ?? 0),
  )
  const inferenceWorkPf = labInferCapacityWorkPf({
    flopsPf: inferenceFlopsPf,
    hardwareTokPerSec,
    utilCap: effectiveUtil,
    allocation,
    servingEfficiency: lab.servingEfficiency,
    engineerServeBonus: engineerServe,
  })
  return {
    rawFlopsPf,
    installedLocalPf,
    availableLocalPf,
    remoteInboundPf,
    outboundCommittedPf,
    chipCount,
    vramGb,
    systemRamGb,
    localVramGb,
    remoteVramGb,
    localSystemRamGb,
    remoteSystemRamGb,
    localServingMemoryReady,
    hardwareTokPerSec,
    inferenceWorkPf,
    // A seller still hosts and powers resold capacity. Outbound contracts
    // reduce its usable pools, not the physical electricity bill.
    powerMw: installedPower.demandMw * powerDerate,
    spotPowerMw: Math.max(0, power.mwGridImport - power.mwContractImport),
    powerDerate,
    rackDerate,
    pools: {
      training:
        base *
        allocation.training *
        (1 + engineerTrain) *
        (1 + campus.trainEffBonus),
      inference: inferenceBase * allocation.inference * (1 + engineerServe),
      research: base * allocation.research * (1 - dataGenShare),
    },
  }
}

export function submitLabIntent(state: SimState, intent: LabIntent): SimState {
  const supersedes = (existing: LabIntent): boolean => {
    if (existing.id === intent.id) return true
    if (existing.labId !== intent.labId || existing.kind !== intent.kind) return false
    // Allocation and price intents express current policy, so only the newest
    // value for the same target can be pending. Transaction intents retain
    // distinct ids and are bounded as a queue below.
    if (intent.kind === 'allocation') return true
    if (intent.kind === 'api_price') {
      return existing.kind === 'api_price' && existing.modelId === intent.modelId
    }
    return false
  }
  const pending = state.worldMarkets.intents.filter(
    (existing) => !supersedes(existing),
  )
  return {
    ...state,
    worldMarkets: {
      ...state.worldMarkets,
      intents: [...pending, intent].slice(-HISTORY_LIMITS.pendingIntents),
    },
  }
}

export function buildRivalPublicEstimate(state: SimState, labId: LabId): RivalPublicEstimate {
  const lab = getLab(state, labId)
  const compute = computeLabSnapshot(state, labId)
  const rng = createRng(hashSeed(state.seed, state.day, labId, 'public-estimate'))
  const confidence = Math.max(0.55, Math.min(0.9, 0.68 + state.day / 1200))
  const band = (value: number, minSpread = 0.08): [number, number] => {
    const spread = minSpread + (1 - confidence) * 0.35 + rng.range(-0.02, 0.02)
    return [Math.max(0, value * (1 - spread)), value * (1 + spread)]
  }
  const debt = lab.loans.reduce((sum, loan) => sum + loan.remaining, 0)
  const processed = Object.values(lab.data.stocks).reduce((sum, stock) => sum + stock.processed, 0)
  const activeJob = lab.trainingJob
  const productPreset = activeJob && 'productPreset' in activeJob ? activeJob.productPreset : undefined
  const backbone = activeJob && 'backbone' in activeJob ? activeJob.backbone : undefined
  const focus =
    lab.archetype === 'multimodal' ? 'Multimodal products' :
      lab.archetype === 'efficiency' ? 'Efficient serving' :
        lab.archetype === 'open_weights' ? 'Open-weight models' :
          lab.archetype === 'safety' ? 'Trusted enterprise AI' : 'Frontier scaling'
  const activeResearchId =
    typeof lab.activeResearch === 'string'
      ? lab.activeResearch
      : lab.activeResearch?.nodeId
  const disclosedProgram = activeResearchId
    ? lab.researchPrograms?.find(
        (program) =>
          program.methodId === activeResearchId && program.disclosure !== 'secret',
      )
    : undefined
  const disclosedNode = disclosedProgram
    ? RESEARCH_NODES.find((node) => node.id === disclosedProgram.methodId)
    : undefined
  const researchEvidenceConfidence = disclosedProgram
    ? Math.max(0.82, ...disclosedProgram.evidence.map((evidence) => evidence.strength))
    : 0
  const trainingProduct = productPreset?.replaceAll('_', ' ') ??
    (activeJob?.family === 'diffusion' || activeJob?.family === 'video'
      ? 'media generation'
      : activeJob?.family === 'omni'
        ? 'multimodal product'
        : 'language model')
  const currentBetConfidence = activeJob
    ? Math.max(0.45, Math.min(0.88, confidence - 0.06))
    : activeResearchId
      ? disclosedProgram
        ? researchEvidenceConfidence
        : 0.25
      : 0.95
  const currentBet = activeJob
    ? currentBetConfidence >= 0.78
      ? `Likely ${trainingProduct}${backbone ? ` using a ${backbone.toUpperCase()} backbone` : ''}`
      : `Likely ${focus.toLowerCase()} model training`
    : activeResearchId
      ? disclosedProgram && disclosedNode
        ? `${disclosedProgram.disclosure === 'published' ? 'Published' : 'Licensed'}: ${disclosedNode.name}`
        : 'Undisclosed research program'
      : 'Serving the current fleet'
  const researchDisclosure = disclosedProgram?.disclosure === 'published' ||
    disclosedProgram?.disclosure === 'licensed'
    ? disclosedProgram.disclosure
    : undefined
  const announcedProject = activeJob
    ? 'Model training'
    : disclosedProgram && disclosedNode
      ? `${disclosedProgram.disclosure === 'published' ? 'Published research' : 'Licensed research'}: ${disclosedNode.name}`
      : null
  return {
    labId,
    day: state.day,
    computePf: band(compute.rawFlopsPf),
    dataMTok: band(processed, 0.12),
    cash: band(Math.max(0, lab.cash), 0.15),
    debt: band(debt, 0.18),
    runwayDays: band(Number.isFinite(lab.finance.runwayDays) ? Math.max(0, lab.finance.runwayDays) : 999, 0.2),
    announcedProject,
    focus,
    currentBet,
    currentBetConfidence,
    researchDisclosure,
    confidence,
  }
}

export function refreshPublicEstimates(state: SimState): SimState {
  let next = state
  for (const rival of state.rivals) {
    const estimate = buildRivalPublicEstimate(next, rival.id)
    next = updateLab(next, rival.id, (lab) => ({ ...lab, publicEstimate: estimate }))
  }
  return next
}

export function normalizeAllocationForLab(allocation: Allocation): Allocation {
  const training = Math.max(0.01, allocation.training)
  const inference = Math.max(0.01, allocation.inference)
  const research = Math.max(0.01, allocation.research)
  const total = training + inference + research
  return {
    training: training / total,
    inference: inference / total,
    research: research / total,
  }
}

/**
 * Common per-lab normalization boundary used by the daily engine. Domain
 * systems may advance jobs around it, but controller identity never changes
 * these invariants.
 */
export function tickLab(state: SimState, labId: LabId): SimState {
  return updateLab(state, labId, (lab) => {
    const allocation = normalizeAllocationForLab(lab.allocation)
    return {
      ...lab,
      allocation,
      cash: Number.isFinite(lab.cash) ? lab.cash : 0,
      finance: {
        ...lab.finance,
        cash: Number.isFinite(lab.cash) ? lab.cash : 0,
        debtOutstanding: lab.loans.reduce((sum, loan) => sum + loan.remaining, 0),
      },
    }
  })
}
