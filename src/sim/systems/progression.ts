import {
  calendarForDay,
  createInitialProgression,
  defaultCampaignRules,
  isCampaignReportDate,
} from '../campaign'
import type {
  DecadeReport,
  MilestoneId,
  MilestoneProgress,
  Model,
  ProductPricing,
  SimState,
} from '../types'
import { isLivePublicModel } from '../modelRelease'
import { modelOfferApiPrice } from './market'

export interface QuarterlyLabSnapshot {
  labId: string
  capability: number
  code: number
  science: number
  otherDomain: number
  reliability: number
  costPerUsefulTask: number
  servedDemandShare: number
  grossMargin: number
  solvent: boolean
  hasReleasedModel: boolean
  firstReleaseDay: number | null
  independentCapability?: number
  creatorQuality?: number
  energyEfficiency?: number
  openResearch?: number
  companyValue?: number
}

const clamp = (value: number, low = 0, high = 100) =>
  Math.max(low, Math.min(high, Number.isFinite(value) ? value : low))

const roundScore = (value: number) => Math.round(clamp(value) * 100) / 100

function releasedModels(models: readonly Model[]): Model[] {
  return models.filter(isLivePublicModel)
}

function modelSnapshot(
  models: readonly Model[],
  pricing: ProductPricing,
): Pick<
  QuarterlyLabSnapshot,
  | 'capability'
  | 'code'
  | 'science'
  | 'otherDomain'
  | 'reliability'
  | 'hasReleasedModel'
  | 'firstReleaseDay'
> & {
  fallbackPrice: number
  offerCapability: number
  offerReliability: number
} {
  const released = releasedModels(models)
  const flagship = released.toSorted(
    (a, b) => b.capability - a.capability || a.id.localeCompare(b.id),
  )[0]
  const offerModel =
    released.find((model) => model.id === pricing.activeModelId) ?? flagship
  const maxDomain = (
    domain: keyof NonNullable<Model['capabilities']>['domains'],
    fallback: (model: Model) => number,
  ) =>
    released.reduce(
      (best, model) =>
        Math.max(best, model.capabilities?.domains[domain] ?? fallback(model)),
      0,
    )
  const code = maxDomain('code', (model) => model.benchmarks.coding ?? 0)
  const science = maxDomain('science', (model) => model.benchmarks.science ?? 0)
  const otherDomain = released.reduce(
    (best, model) =>
      Math.max(
        best,
        model.capabilities?.domains.language ?? model.benchmarks.multilingual ?? 0,
        model.capabilities?.domains.reasoning ?? model.benchmarks.mmlu ?? 0,
        model.capabilities?.domains.math ?? model.benchmarks.math ?? 0,
        model.capabilities?.domains.vision ?? model.benchmarks.vision ?? 0,
        model.capabilities?.domains.video ?? 0,
        model.capabilities?.domains.audio ?? 0,
        model.capabilities?.domains.tools ?? model.benchmarks.agents ?? 0,
      ),
    0,
  )
  const fallbackPrice = offerModel
    ? modelOfferApiPrice(pricing, offerModel)
    : Number.POSITIVE_INFINITY
  return {
    capability: flagship?.capability ?? 0,
    code,
    science,
    otherDomain,
    reliability: flagship?.quality.reliability ?? 0,
    hasReleasedModel: released.length > 0,
    firstReleaseDay:
      released.length > 0
        ? released.reduce((first, model) => Math.min(first, model.releaseDay), Infinity)
        : null,
    fallbackPrice,
    offerCapability: offerModel?.capability ?? 0,
    offerReliability: offerModel?.quality.reliability ?? 0,
  }
}

function independentCapabilityFor(
  state: SimState,
  labId: string,
  models: readonly Model[],
  fallback: number,
): number {
  const modelIds = new Set(releasedModels(models).map((model) => model.id))
  const audited = state.evaluations.filter(
    (evaluation) =>
      evaluation.published &&
      evaluation.kind === 'blind_audit' &&
      (evaluation.labId ?? state.playerLabId) === labId &&
      modelIds.has(evaluation.modelId),
  )
  if (audited.length === 0) return fallback * 0.92
  return Math.max(
    ...audited.map((evaluation) => {
      const scores = Object.values(evaluation.scores).filter(
        (score): score is number => typeof score === 'number',
      )
      return scores.length > 0
        ? scores.reduce((sum, score) => sum + score, 0) / scores.length
        : 0
    }),
  )
}

function creatorQuality(models: readonly Model[]): number {
  return releasedModels(models).reduce(
    (best, model) =>
      Math.max(
        best,
        model.benchmarks.vision ?? 0,
        model.capabilities?.domains.video ?? 0,
        model.capabilities?.domains.audio ?? 0,
      ),
    0,
  )
}

function servingEfficiencyScore(models: readonly Model[]): number {
  return releasedModels(models).reduce(
    (best, model) =>
      Math.max(best, model.capability / Math.max(0.15, model.inferCostMult ?? 1)),
    0,
  )
}

function usefulTaskCost(price: number, capability: number, reliability: number): number {
  if (!Number.isFinite(price) || price < 0) return Number.POSITIVE_INFINITY
  const successRate = Math.max(0.05, capability / 100) * Math.max(0.25, reliability / 100)
  return price / successRate
}

/**
 * Builds one comparable quarterly row for every lab from currently public
 * information. Callers may supply audited rows to evaluateMilestones instead;
 * this compatibility path keeps the campaign core usable during the v4 model
 * and market migrations.
 */
export function collectQuarterlyLabSnapshots(state: SimState): QuarterlyLabSnapshot[] {
  const shares = state.lastMarket?.sharesByLab ?? {}
  const playerModel = modelSnapshot(
    state.player.models ?? [],
    state.player.pricing,
  )
  const {
    fallbackPrice: playerFallbackPrice,
    offerCapability: playerOfferCapability,
    offerReliability: playerOfferReliability,
    ...playerMetrics
  } = playerModel
  const playerRevenue = state.player.finance?.dayRevenue ?? 0
  const playerGross = state.player.finance?.dayGrossProfit ?? 0
  const player: QuarterlyLabSnapshot = {
    labId: state.playerLabId || 'player',
    ...playerMetrics,
    costPerUsefulTask: usefulTaskCost(
      playerFallbackPrice,
      playerOfferCapability,
      playerOfferReliability,
    ),
    servedDemandShare: shares[state.playerLabId || 'player'] ?? state.player.finance?.totalShare ?? 0,
    grossMargin: playerRevenue > 0 ? playerGross / playerRevenue : -1,
    solvent:
      state.victory?.outcome !== 'lost' &&
      state.player.cash > -20_000_000 &&
      state.player.capital?.restructuring.stage !== 'bankruptcy',
    independentCapability: independentCapabilityFor(
      state,
      state.playerLabId,
      state.player.models,
      playerModel.capability,
    ),
    creatorQuality: creatorQuality(state.player.models),
    energyEfficiency: servingEfficiencyScore(state.player.models),
    openResearch:
      (state.player.researchPrograms ?? []).filter(
        (program) => program.disclosure === 'published' && program.phase === 'complete',
      ).length * 10 +
      state.player.models.filter((model) => model.openWeights).length * 6,
    companyValue: state.player.finance.valuation,
  }

  const rivals = (state.rivals ?? []).map((rival): QuarterlyLabSnapshot => {
    const model = modelSnapshot(rival.models ?? [], rival.pricing)
    const {
      fallbackPrice,
      offerCapability,
      offerReliability,
      ...metrics
    } = model
    const revenue = rival.finance?.dayRevenue ?? rival.dayRevenue ?? 0
    const gross = rival.finance?.dayGrossProfit
    return {
      labId: rival.id,
      ...metrics,
      costPerUsefulTask: usefulTaskCost(
        fallbackPrice,
        offerCapability,
        offerReliability,
      ),
      servedDemandShare: shares[rival.id] ?? rival.marketShare ?? 0,
      grossMargin: revenue > 0 ? (gross == null ? 0.1 : gross / revenue) : -1,
      solvent: rival.cash > -20_000_000,
      independentCapability: independentCapabilityFor(
        state,
        rival.id,
        rival.models,
        model.capability,
      ),
      creatorQuality: creatorQuality(rival.models),
      energyEfficiency: servingEfficiencyScore(rival.models),
      openResearch:
        (rival.researchPrograms ?? []).filter(
          (program) => program.disclosure === 'published' && program.phase === 'complete',
        ).length * 10 +
        rival.models.filter((candidate) => candidate.openWeights).length * 6,
      companyValue: rival.finance?.valuation ?? rival.cash * 1.35,
    }
  })
  return [player, ...rivals]
}

function topLab(
  rows: readonly QuarterlyLabSnapshot[],
  score: (row: QuarterlyLabSnapshot) => number,
  eligible: (row: QuarterlyLabSnapshot) => boolean = () => true,
): QuarterlyLabSnapshot | null {
  return (
    rows
      .filter(eligible)
      .toSorted((a, b) => score(b) - score(a) || a.labId.localeCompare(b.labId))[0] ?? null
  )
}

function percentile80(values: readonly number[]): number {
  if (values.length === 0) return Infinity
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.8) - 1)] ?? Infinity
}

function milestoneCandidate(
  id: MilestoneId,
  rows: readonly QuarterlyLabSnapshot[],
): string | null {
  const publicRows = rows.filter((row) => row.hasReleasedModel && row.solvent)
  if (publicRows.length === 0) return null

  if (id === 'sustainable_launch') {
    return (
      publicRows
        .filter((row) => row.grossMargin > 0)
        .toSorted(
          (a, b) =>
            (a.firstReleaseDay ?? Infinity) - (b.firstReleaseDay ?? Infinity) ||
            a.labId.localeCompare(b.labId),
        )[0]?.labId ?? null
    )
  }

  if (id === 'frontier_leader') {
    const capability = topLab(
      publicRows,
      (row) => row.independentCapability ?? row.capability,
    )
    if (!capability || capability.reliability < 50) return null
    const code = topLab(publicRows, (row) => row.code)
    const science = topLab(publicRows, (row) => row.science)
    const other = topLab(publicRows, (row) => row.otherDomain)
    const leadsPriorityDomain =
      capability.labId === code?.labId || capability.labId === science?.labId
    return leadsPriorityDomain && capability.labId === other?.labId
      ? capability.labId
      : null
  }

  if (id === 'abundance_leader') {
    const threshold = percentile80(publicRows.map((row) => row.capability))
    const eligible = publicRows.filter(
      (row) =>
        row.capability >= threshold &&
        row.servedDemandShare >= 0.2 &&
        row.grossMargin > 0 &&
        Number.isFinite(row.costPerUsefulTask),
    )
    return topLab(eligible, (row) => -row.costPerUsefulTask)?.labId ?? null
  }

  if (id === 'code_record') return topLab(publicRows, (row) => row.code)?.labId ?? null
  if (id === 'science_record') return topLab(publicRows, (row) => row.science)?.labId ?? null
  if (id === 'reliability_record') {
    return topLab(publicRows, (row) => row.reliability)?.labId ?? null
  }
  if (id === 'creator_record') {
    return topLab(publicRows, (row) => row.creatorQuality ?? 0)?.labId ?? null
  }
  if (id === 'energy_efficiency_record') {
    return topLab(publicRows, (row) => row.energyEfficiency ?? 0)?.labId ?? null
  }
  if (id === 'open_research_record') {
    return topLab(
      publicRows,
      (row) => row.openResearch ?? 0,
      (row) => (row.openResearch ?? 0) > 0,
    )?.labId ?? null
  }
  if (id === 'adoption_record') {
    return topLab(publicRows, (row) => row.servedDemandShare)?.labId ?? null
  }
  return topLab(publicRows, (row) => row.companyValue ?? 0)?.labId ?? null
}

function advanceMilestone(
  milestone: MilestoneProgress,
  candidateLabId: string | null,
  day: number,
): MilestoneProgress {
  if (milestone.achievedDay != null) return milestone
  if (!candidateLabId) {
    return { ...milestone, qualifyingQuarters: 0, firstLabId: null }
  }
  const qualifyingQuarters =
    milestone.firstLabId === candidateLabId ? milestone.qualifyingQuarters + 1 : 1
  return {
    ...milestone,
    firstLabId: candidateLabId,
    qualifyingQuarters,
    achievedDay:
      qualifyingQuarters >= milestone.requiredQuarters ? day : milestone.achievedDay,
  }
}

/** Evaluates titles only on a quarterly review boundary. Titles never end play. */
export function evaluateMilestones(
  state: SimState,
  snapshots?: readonly QuarterlyLabSnapshot[],
): SimState {
  const progression = state.progression ?? createInitialProgression()
  if (!state.calendar?.isReviewDay || progression.runPhase === 'failed') {
    return {
      ...state,
      progression: { ...progression, era: state.calendar?.era ?? progression.era },
    }
  }
  const quarterlySnapshots = snapshots ?? collectQuarterlyLabSnapshots(state)
  return {
    ...state,
    progression: {
      ...progression,
      era: state.calendar.era,
      milestones: progression.milestones.map((milestone) =>
        advanceMilestone(
          milestone,
          milestoneCandidate(milestone.id, quarterlySnapshots),
          state.day,
        ),
      ),
    },
  }
}

export function buildDecadeReport(state: SimState): DecadeReport {
  const playerId = state.playerLabId || 'player'
  const row =
    collectQuarterlyLabSnapshots(state).find((snapshot) => snapshot.labId === playerId) ??
    collectQuarterlyLabSnapshots(state)[0]
  const capability = roundScore(row?.capability ?? 0)
  const affordability = roundScore(
    row && Number.isFinite(row.costPerUsefulTask)
      ? 100 / (1 + row.costPerUsefulTask / 5)
      : 0,
  )
  const adoption = roundScore((row?.servedDemandShare ?? 0) * 100)
  const reliability = roundScore(row?.reliability ?? 0)
  const lifetimeNet = state.player.finance?.lifetimeNet ?? 0
  const profit = roundScore(
    lifetimeNet >= 0
      ? 35 + Math.log10(1 + lifetimeNet / 1_000_000) * 15
      : 35 - Math.log10(1 + Math.abs(lifetimeNet) / 1_000_000) * 18,
  )
  const trust = roundScore(state.player.brandTrust ?? 0)
  const founderControl = state.player.capital?.founderControl
  const founderOwnership = roundScore(
    founderControl == null ? 100 : founderControl <= 1 ? founderControl * 100 : founderControl,
  )
  const completedResearch = (state.player.researchPrograms ?? []).filter(
    (program) => program.phase === 'complete',
  )
  const researchImpact = roundScore(
    completedResearch.length * 4 +
      completedResearch.filter((program) => program.disclosure === 'published').length * 8 +
      completedResearch.filter((program) => program.disclosure === 'licensed').length * 5 +
      completedResearch.reduce(
        (sum, program) =>
          sum + program.evidence.reduce((evidence, item) => evidence + item.strength, 0),
        0,
      ) * 2 +
      state.player.models.filter((model) => model.openWeights).length * 3,
  )
  const score = roundScore(
    (researchImpact +
      capability +
      affordability +
      adoption +
      reliability +
      profit +
      trust +
      founderOwnership) /
      8,
  )
  return {
    generatedDay: state.day,
    score,
    researchImpact,
    capability,
    affordability,
    adoption,
    reliability,
    profit,
    trust,
    founderOwnership,
  }
}

/** Campaign-level daily hook: quarterly titles, then the one-time decade close. */
export function tickProgression(
  state: SimState,
  snapshots?: readonly QuarterlyLabSnapshot[],
): SimState {
  const rules = state.config?.campaignRules ?? defaultCampaignRules()
  const calendar = state.calendar ?? calendarForDay(state.day, rules)
  let next = evaluateMilestones(
    { ...state, calendar },
    snapshots,
  )
  if (
    next.progression.decadeReport == null &&
    isCampaignReportDate(calendar, rules)
  ) {
    next = {
      ...next,
      paused: true,
      progression: {
        ...next.progression,
        era: calendar.era,
        decadeReport: buildDecadeReport(next),
        reportAcknowledged: false,
      },
    }
  }
  return next
}

/** Acknowledges the decade report and resumes the same deterministic sandbox. */
export function continueEndless(state: SimState): SimState {
  const rules = state.config?.campaignRules ?? defaultCampaignRules()
  const progression = state.progression ?? createInitialProgression()
  if (!rules.endless || progression.decadeReport == null) return state
  return {
    ...state,
    paused: false,
    progression: {
      ...progression,
      era: 'endless',
      reportAcknowledged: true,
      runPhase: 'endless',
    },
  }
}
