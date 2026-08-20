import { architecturePretrainingCapabilityCap } from '../balance/architectureFrontiers'
import { normalizeModelEvaluations, suiteComposite } from '../balance/evaluationSuites'
import { buildScaledModel } from '../balance/modelBuild'
import {
  highestPostTrainStage,
  postTrainStagesFromResearch,
} from '../balance/modelProduct'
import { deriveModelCapabilities, modalityExperienceCounts } from '../balance/modelCapabilities'
import { bentCapabilityCeiling } from '../balance/modelScaling'
import {
  blendApiPrice,
  commercialModelKind,
  splitBlendedApiPrice,
} from '../balance/pricing'
import { ioForPreset } from '../balance/trainingV3'
import { rivalEraParamCeilingB } from '../balance/rivalScale'
import { createRng, hashSeed } from '../rng'
import type {
  CapitalStack,
  DataDomain,
  Model,
  ModelBackbone,
  ModelFamily,
  ModelIOModality,
  ModelProductPreset,
  ProductPricing,
  RivalFinancialComeback,
  RivalLab,
  SimState,
} from '../types'
import { isLivePublicModel } from '../modelRelease'
import { updateLab } from './labEngine'
import { chooseRivalServePrecision } from './rivalStrategy'

/** One immutable opportunity per genuine distress episode. */
export const RIVAL_COMEBACK_CHANCE = 0.14
export const RIVAL_COMEBACK_COOLDOWN_DAYS = 720
export const RIVAL_COMEBACK_FAILED_COOLDOWN_DAYS = 365
export const RIVAL_COMEBACK_MIN_LEAD_DAYS = 21
export const RIVAL_COMEBACK_MAX_LEAD_DAYS = 35

const PRODUCT_PARAM_LADDER = [
  12, 22, 34, 70, 110, 180, 235, 405, 700, 1100, 1800, 2500, 3500, 5000,
] as const
const INVESTORS = [
  'Atlas Sovereign Compute',
  'Northstar Continuity Fund',
  'Meridian Strategic Capital',
  'Horizon Infrastructure Partners',
] as const

type ProductMarket = 'language' | 'image' | 'video' | 'audio' | 'omni'

interface ComebackBlueprint {
  family: ModelFamily
  backbone: ModelBackbone
  productPreset: ModelProductPreset
  activeParamsRatio?: number
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isFamily(value: unknown): value is ModelFamily {
  return ['dense', 'moe', 'diffusion', 'video', 'omni', 'embedding'].includes(
    String(value),
  )
}

function isBackbone(value: unknown): value is ModelBackbone {
  return ['dense', 'moe', 'diffusion'].includes(String(value))
}

function isPreset(value: unknown): value is ModelProductPreset {
  return [
    'language',
    'vision_language',
    'audio',
    'image_generation',
    'video_generation',
    'omni',
  ].includes(String(value))
}

/** Soft migration and malformed-save repair for the optional lifecycle. */
export function normalizeRivalFinancialComeback(
  rival: Pick<RivalLab, 'capital' | 'financialComeback'>,
): RivalFinancialComeback {
  const source = rival.financialComeback
  const legacyActive = rival.capital?.restructuring.active === true
  const distressEpisode = Math.max(
    legacyActive ? 1 : 0,
    Math.floor(finite(source?.distressEpisode)),
  )
  const attempted = source?.attemptedEpisode
  const attemptedEpisode =
    attempted == null
      ? undefined
      : Math.min(distressEpisode, Math.max(0, Math.floor(finite(attempted))))
  const rawStatus = source?.status
  let status: RivalFinancialComeback['status'] =
    rawStatus === 'announced' || rawStatus === 'released' ? rawStatus : 'none'
  const modelId =
    typeof source?.modelId === 'string' && source.modelId.trim()
      ? source.modelId
      : undefined
  const family = isFamily(source?.family) ? source.family : undefined
  const backbone = isBackbone(source?.backbone) ? source.backbone : undefined
  const productPreset = isPreset(source?.productPreset)
    ? source.productPreset
    : undefined
  const releaseDay =
    source?.releaseDay == null
      ? undefined
      : Math.max(0, Math.floor(finite(source.releaseDay)))
  const paramsB =
    typeof source?.paramsB === 'number' && Number.isFinite(source.paramsB)
      ? Math.max(0.007, source.paramsB)
      : undefined
  if (
    status === 'announced' &&
    (!modelId || !family || !backbone || !productPreset || !releaseDay || !paramsB)
  ) {
    status = 'none'
  }
  const modalityExperience = source?.modalityExperience
    ? {
        image: Math.max(0, finite(source.modalityExperience.image)),
        audio: Math.max(0, finite(source.modalityExperience.audio)),
        video: Math.max(0, finite(source.modalityExperience.video)),
      }
    : undefined
  return {
    distressEpisode,
    attemptedEpisode,
    cooldownUntilDay: Math.max(
      0,
      Math.floor(finite(source?.cooldownUntilDay)),
    ),
    status,
    announcedDay:
      source?.announcedDay == null
        ? undefined
        : Math.max(0, Math.floor(finite(source.announcedDay))),
    releaseDay,
    completedDay:
      source?.completedDay == null
        ? undefined
        : Math.max(0, Math.floor(finite(source.completedDay))),
    backingCash:
      source?.backingCash == null
        ? undefined
        : Math.max(0, finite(source.backingCash)),
    acquisitionCost:
      source?.acquisitionCost == null
        ? undefined
        : Math.max(0, finite(source.acquisitionCost)),
    investorName:
      typeof source?.investorName === 'string' && source.investorName.trim()
        ? source.investorName
        : undefined,
    modelId,
    family,
    backbone,
    productPreset,
    paramsB,
    activeParamsRatio:
      source?.activeParamsRatio == null
        ? undefined
        : clamp(finite(source.activeParamsRatio), 0.01, 1),
    researchMultiplier:
      source?.researchMultiplier == null
        ? undefined
        : clamp(finite(source.researchMultiplier), 0.5, 2),
    researchUnlocked: Array.isArray(source?.researchUnlocked)
      ? source.researchUnlocked.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : undefined,
    dataCoverage:
      source?.dataCoverage == null
        ? undefined
        : clamp(finite(source.dataCoverage), 0.05, 20),
    dataQuality:
      source?.dataQuality == null
        ? undefined
        : clamp(finite(source.dataQuality), 0, 100),
    modalityExperience,
    targetCapability:
      source?.targetCapability == null
        ? undefined
        : clamp(finite(source.targetCapability), 0, 100),
    referenceFrontierCapability:
      source?.referenceFrontierCapability == null
        ? undefined
        : clamp(finite(source.referenceFrontierCapability), 0, 100),
  }
}

function productMarket(preset: ModelProductPreset): ProductMarket {
  if (preset === 'image_generation') return 'image'
  if (preset === 'video_generation') return 'video'
  if (preset === 'audio') return 'audio'
  if (preset === 'omni') return 'omni'
  return 'language'
}

function modelMatchesMarket(model: Model, market: ProductMarket): boolean {
  const kind = commercialModelKind(model)
  if (market === 'language') {
    return kind === 'language' || kind === 'coding' || kind === 'reasoning'
  }
  return kind === market
}

/** Comparable public score used for both the announcement and release audit. */
export function rivalComebackProductScore(
  model: Model,
  market: ProductMarket = productMarket(model.productPreset ?? 'language'),
): number {
  if (market === 'image') {
    return (
      suiteComposite(model.benchmarkSuites?.image_generation) ||
      model.quality.image
    )
  }
  if (market === 'video') {
    return (
      suiteComposite(model.benchmarkSuites?.video_generation) ||
      model.quality.video
    )
  }
  if (market === 'audio') {
    return (
      suiteComposite(model.benchmarkSuites?.audio_generation) ||
      model.capabilities?.domains.audio ||
      model.quality.chat
    )
  }
  if (market === 'omni') {
    return suiteComposite(model.benchmarkSuites?.omni_overview) || model.capability
  }
  return model.capability
}

function chooseBlueprint(rival: RivalLab): ComebackBlueprint {
  const unlocked = new Set(rival.researchUnlocked)
  if (rival.archetype === 'multimodal') {
    if (unlocked.has('mm_omni')) {
      const sparse = unlocked.has('moe_basics')
      return {
        family: 'omni',
        backbone: sparse ? 'moe' : 'dense',
        productPreset: 'omni',
        activeParamsRatio: sparse ? 0.12 : undefined,
      }
    }
    if (unlocked.has('mm_video')) {
      return {
        family: 'video',
        backbone: 'diffusion',
        productPreset: 'video_generation',
      }
    }
    if (unlocked.has('mm_diff')) {
      return {
        family: 'diffusion',
        backbone: 'diffusion',
        productPreset: 'image_generation',
      }
    }
    if (unlocked.has('mm_vision')) {
      return {
        family: 'dense',
        backbone: 'dense',
        productPreset: 'audio',
      }
    }
  }
  const sparse =
    rival.archetype !== 'safety' && unlocked.has('moe_basics')
  return {
    family: sparse ? 'moe' : 'dense',
    backbone: sparse ? 'moe' : 'dense',
    productPreset: 'language',
    activeParamsRatio: sparse ? 0.12 : undefined,
  }
}

function modalitiesForPreset(preset: ModelProductPreset): Model['modalities'] {
  if (preset === 'image_generation') return ['text', 'image']
  if (preset === 'video_generation') return ['text', 'image', 'video']
  if (preset === 'audio') return ['text', 'audio']
  if (preset === 'omni') return ['text', 'image', 'audio', 'video', 'tools']
  return ['text']
}

function domainWeightsForPreset(
  preset: ModelProductPreset,
): Partial<Record<DataDomain, number>> {
  if (preset === 'image_generation') {
    return { chat: 0.18, code: 0.04, image: 0.66, video: 0.08, audio: 0.04 }
  }
  if (preset === 'video_generation') {
    return { chat: 0.12, code: 0.03, image: 0.2, video: 0.61, audio: 0.04 }
  }
  if (preset === 'audio') {
    return { chat: 0.34, code: 0.05, image: 0.03, video: 0.03, audio: 0.55 }
  }
  if (preset === 'omni') {
    return {
      chat: 0.24,
      code: 0.14,
      math: 0.08,
      science: 0.07,
      image: 0.18,
      audio: 0.12,
      video: 0.12,
      law: 0.025,
      health: 0.025,
    }
  }
  return {
    chat: 0.3,
    code: 0.22,
    math: 0.14,
    science: 0.13,
    law: 0.08,
    health: 0.08,
    image: 0.025,
    audio: 0.01,
    video: 0.005,
  }
}

function releasedModels(state: SimState): Model[] {
  return [
    ...state.player.models,
    ...state.rivals.flatMap((rival) => rival.models),
  ].filter(isLivePublicModel)
}

function frontierForMarket(state: SimState, market: ProductMarket): number {
  const all = releasedModels(state)
  const comparable = all.filter((model) => modelMatchesMarket(model, market))
  if (comparable.length > 0) {
    return Math.max(
      0,
      ...comparable.map((model) => rivalComebackProductScore(model, market)),
    )
  }
  return Math.max(24, ...all.map((model) => model.capability * 0.88))
}

function buildAcquiredCheckpoint(
  state: SimState,
  rival: RivalLab,
  plan: RivalFinancialComeback,
  paramsB: number,
): Model {
  const family = plan.family ?? 'dense'
  const backbone = plan.backbone ?? 'dense'
  const productPreset = plan.productPreset ?? 'language'
  const activeParamsB =
    plan.activeParamsRatio == null
      ? undefined
      : Math.max(0.1, paramsB * plan.activeParamsRatio)
  const dataCoverage = plan.dataCoverage ?? 8
  const dataQuality = plan.dataQuality ?? 88
  const researchUnlocked = plan.researchUnlocked ?? rival.researchUnlocked
  const researchMultiplier =
    plan.researchMultiplier ?? clamp(1.08 + researchUnlocked.length * 0.008, 1.08, 1.24)
  const modalityExperience =
    plan.modalityExperience ?? modalityExperienceCounts(rival.models)
  return buildScaledModel({
    id: plan.modelId ?? `${rival.id}-comeback-e${plan.distressEpisode}`,
    name: `${rival.name.split(' ')[0] ?? rival.name} Phoenix-${plan.distressEpisode}`,
    paramsB,
    activeParamsB,
    family,
    backbone,
    productPreset,
    io: ioForPreset(productPreset),
    modalities: modalitiesForPreset(productPreset),
    day: plan.releaseDay ?? state.day,
    dataCoverage,
    dataQuality,
    mixWeights: domainWeightsForPreset(productPreset),
    researchUnlocked,
    researchMult: researchMultiplier,
    postTrain: highestPostTrainStage(
      postTrainStagesFromResearch(researchUnlocked),
    ),
    effectiveDataRatio: dataCoverage,
    modalityExperience,
    openWeights: rival.archetype === 'open_weights',
    shipped: true,
    release: 'released',
  })
}

function chooseCheckpointScale(
  state: SimState,
  rival: RivalLab,
  plan: RivalFinancialComeback,
  desired: number,
): { paramsB: number; model: Model; score: number } {
  const market = productMarket(plan.productPreset ?? 'language')
  const ceiling = rivalEraParamCeilingB({
    day: state.day,
    archetype: rival.archetype,
    publicFrontierParamsB: Math.max(
      0,
      ...releasedModels(state).map((model) => model.paramsB),
    ),
  })
  const rungs = PRODUCT_PARAM_LADDER.filter((paramsB) => paramsB <= ceiling * 1.05)
  const candidates = (rungs.length > 0 ? rungs : [PRODUCT_PARAM_LADDER[0]!]).map(
    (paramsB) => {
    const model = buildAcquiredCheckpoint(state, rival, plan, paramsB)
    return {
      paramsB,
      model,
      score: rivalComebackProductScore(model, market),
      unitCost: blendApiPrice(model.costApiPriceIn, model.costApiPriceOut),
    }
  })
  candidates.sort((left, right) => {
    const leftGap = Math.abs(left.score - desired)
    const rightGap = Math.abs(right.score - desired)
    if (Math.abs(leftGap - rightGap) > 1.25) return leftGap - rightGap
    return left.unitCost - right.unitCost || left.paramsB - right.paramsB
  })
  return candidates[0]!
}

function capitalForRival(rival: RivalLab): CapitalStack {
  return (
    rival.capital ?? {
      capTable: [
        {
          holderId: `${rival.id}-founders`,
          holderName: 'Founders',
          ownership: 1,
          votingPower: 1,
          kind: 'founder',
        },
      ],
      fundingRounds: [],
      debt: [],
      investorConfidence: 0.4,
      boardPressure: 0.5,
      founderControl: 1,
      restructuring: { active: false, daysLeft: 0, stage: 'none' },
    }
  )
}

function withComeback(
  state: SimState,
  rivalId: string,
  financialComeback: RivalFinancialComeback,
): SimState {
  return {
    ...state,
    rivals: state.rivals.map((rival) =>
      rival.id === rivalId ? { ...rival, financialComeback } : rival,
    ),
  }
}

function isGenuinelyDistressed(rival: RivalLab): boolean {
  const stage = rival.capital?.restructuring.stage
  if (stage !== 'refinance' && stage !== 'asset_sale') return false
  const finance = rival.finance
  if (!finance) return false
  return rival.cash < 0 || (finance.dayNet < 0 && finance.runwayDays < 45)
}

/**
 * Consume the episode's one seeded decision. A failed roll is persisted, so
 * neither save/reload nor waiting another day can farm emergency backing.
 */
export function maybeStartRivalFinancialComeback(
  state: SimState,
  rivalId: string,
): SimState {
  const rival = state.rivals.find((candidate) => candidate.id === rivalId)
  if (!rival || !isGenuinelyDistressed(rival) || !rival.finance) return state
  const existing = normalizeRivalFinancialComeback(rival)
  const episode = existing.distressEpisode
  if (
    episode <= 0 ||
    existing.attemptedEpisode === episode ||
    state.day < existing.cooldownUntilDay ||
    existing.status === 'announced'
  ) {
    return withComeback(state, rivalId, existing)
  }

  const rng = createRng(
    hashSeed(state.seed, rival.id, episode, 'rival-emergency-backing-v1'),
  )
  const attempted: RivalFinancialComeback = {
    ...existing,
    attemptedEpisode: episode,
    cooldownUntilDay: state.day + RIVAL_COMEBACK_FAILED_COOLDOWN_DAYS,
  }
  if (rng.next() >= RIVAL_COMEBACK_CHANCE) {
    return withComeback(state, rivalId, attempted)
  }

  const blueprint = chooseBlueprint(rival)
  const market = productMarket(blueprint.productPreset)
  const referenceFrontierCapability = frontierForMarket(state, market)
  let desired = referenceFrontierCapability + rng.range(-2.75, 1)
  if (market === 'language') {
    const architectureWall = bentCapabilityCeiling(
      architecturePretrainingCapabilityCap(blueprint),
    )
    desired = Math.min(desired, architectureWall - 0.2)
  }
  const releaseDay =
    state.day + rng.int(RIVAL_COMEBACK_MIN_LEAD_DAYS, RIVAL_COMEBACK_MAX_LEAD_DAYS)
  const technicalPlan: RivalFinancialComeback = {
    ...attempted,
    status: 'announced',
    announcedDay: state.day,
    releaseDay,
    investorName: rng.pick([...INVESTORS]),
    modelId: `${rival.id}-comeback-e${episode}`,
    family: blueprint.family,
    backbone: blueprint.backbone,
    productPreset: blueprint.productPreset,
    activeParamsRatio: blueprint.activeParamsRatio,
    researchMultiplier: clamp(
      1.08 + rival.researchUnlocked.length * 0.008,
      1.08,
      1.24,
    ),
    researchUnlocked: [...rival.researchUnlocked],
    dataCoverage: blueprint.family === 'omni' ? 10 : 8,
    dataQuality: clamp(86 + rival.brandTrust * 0.07, 86, 93),
    modalityExperience: modalityExperienceCounts(rival.models),
    referenceFrontierCapability,
  }
  const selected = chooseCheckpointScale(state, rival, technicalPlan, desired)
  // A real rescue consortium declines if its audited checkpoint is not at
  // least near the compatible public frontier. This preserves architecture
  // walls and first-generation modality maturity instead of bypassing them.
  if (
    referenceFrontierCapability > 0 &&
    selected.score < referenceFrontierCapability - 6
  ) {
    return withComeback(state, rivalId, attempted)
  }

  const acquisitionCost = Math.round(
    clamp(
      80_000_000 +
        selected.paramsB *
          (blueprint.backbone === 'moe' ? 380_000 : 720_000) +
        selected.score * selected.score * 42_000,
      120_000_000,
      1_250_000_000,
    ),
  )
  const recurringBurn = Math.max(1, -rival.finance.dayNet)
  const runwayReserve = Math.min(
    4_000_000_000,
    recurringBurn * rng.int(180, 240),
  )
  const backingCash = Math.round(
    acquisitionCost + Math.max(0, -rival.cash) + Math.max(100_000_000, runwayReserve),
  )
  const preMoneyValuation = Math.round(
    Math.max(
      50_000_000,
      rival.finance.valuation * 0.55,
      backingCash * 0.55,
      rival.finance.dayRevenue * 365 * 4,
    ),
  )
  const postMoneyValuation = preMoneyValuation + backingCash
  const dilution = backingCash / postMoneyValuation
  const capital = capitalForRival(rival)
  const existingMultiplier = 1 - dilution
  const capTable = capital.capTable.map((stake) => ({
    ...stake,
    ownership: stake.ownership * existingMultiplier,
    votingPower: stake.votingPower * existingMultiplier,
  }))
  capTable.push({
    holderId: `comeback-round-${rival.id}-${episode}`,
    holderName: technicalPlan.investorName!,
    ownership: dilution,
    votingPower: dilution,
    kind: 'investor',
  })
  const ownershipTotal =
    capTable.reduce((sum, stake) => sum + stake.ownership, 0) || 1
  const normalizedCapTable = capTable.map((stake) => ({
    ...stake,
    ownership: stake.ownership / ownershipTotal,
  }))
  const cash = rival.cash + backingCash - acquisitionCost
  const plan: RivalFinancialComeback = {
    ...technicalPlan,
    paramsB: selected.paramsB,
    targetCapability: selected.score,
    backingCash,
    acquisitionCost,
    cooldownUntilDay: state.day + RIVAL_COMEBACK_COOLDOWN_DAYS,
  }

  let next = updateLab(state, rival.id, (lab) => ({
    ...lab,
    cash,
    capital: {
      ...capital,
      capTable: normalizedCapTable,
      fundingRounds: [
        ...capital.fundingRounds,
        {
          id: `comeback-round-${rival.id}-${episode}`,
          label: 'Emergency restructure',
          day: state.day,
          preMoneyValuation,
          cashRaised: backingCash,
          postMoneyValuation,
          dilution,
          investorName: technicalPlan.investorName!,
        },
      ],
      investorConfidence: clamp(capital.investorConfidence + 0.16, 0, 1),
      boardPressure: clamp(capital.boardPressure + dilution * 0.5, 0, 1),
      founderControl: clamp(capital.founderControl * existingMultiplier, 0, 1),
      restructuring: { active: false, daysLeft: 0, stage: 'none' },
    },
    finance: {
      ...lab.finance,
      cash,
      dayCapexCost: (lab.finance.dayCapexCost ?? 0) + acquisitionCost,
      dayTotalOut: lab.finance.dayTotalOut + acquisitionCost,
      dayNet: lab.finance.dayNet - acquisitionCost,
      lifetimeNet: lab.finance.lifetimeNet - acquisitionCost,
      valuation: postMoneyValuation,
      peakCash: Math.max(lab.finance.peakCash, cash),
      lowestCash: Math.min(lab.finance.lowestCash, cash),
      runwayDays: cash > 0 ? cash / recurringBurn : 0,
    },
  }))
  next = withComeback(next, rival.id, plan)
  next = {
    ...next,
    rivals: next.rivals.map((candidate) =>
      candidate.id === rival.id
        ? {
            ...candidate,
            publicEstimate: candidate.publicEstimate
              ? {
                  ...candidate.publicEstimate,
                  announcedProject: `${blueprint.productPreset.replaceAll('_', ' ')} checkpoint acquisition`,
                }
              : candidate.publicEstimate,
            strategy: candidate.strategy
              ? {
                  ...candidate.strategy,
                  goal: 'ship_model',
                  plan: [
                    `Release acquired ${blueprint.productPreset.replaceAll('_', ' ')} checkpoint by day ${releaseDay}`,
                    ...candidate.strategy.plan.filter(
                      (item) => !item.startsWith('Release acquired '),
                    ),
                  ],
                }
              : candidate.strategy,
          }
        : candidate,
    ),
    news: [
      `Day ${state.day}: ${technicalPlan.investorName} commits $${(backingCash / 1_000_000).toFixed(0)}M to rescue ${rival.name}; $${(acquisitionCost / 1_000_000).toFixed(0)}M is booked now for an audited ${blueprint.productPreset.replaceAll('_', ' ')} checkpoint targeting ${selected.score.toFixed(1)} versus the ${referenceFrontierCapability.toFixed(1)} public frontier, with release due day ${releaseDay}.`,
      ...next.news,
    ].slice(0, 64),
  }
  return next
}

function modelOutputModalities(model: Model): ModelIOModality[] {
  const outputs = model.io?.outputs ?? {}
  return (['text', 'image', 'audio', 'video'] as const).filter(
    (modality) => (outputs[modality] ?? 0) > 0,
  )
}

function listedPrice(pricing: ProductPricing, model: Model): number {
  if (model.apiPriceInPerMTok != null || model.apiPriceOutPerMTok != null) {
    return blendApiPrice(
      model.apiPriceInPerMTok ?? pricing.apiPriceInPerMTok,
      model.apiPriceOutPerMTok ?? pricing.apiPriceOutPerMTok,
    )
  }
  return model.apiPricePerMTok ?? pricing.apiPricePerMTok
}

function peerPriceAnchor(
  state: SimState,
  ownerId: string,
  model: Model,
): number | null {
  const market = productMarket(model.productPreset ?? 'language')
  const ownScore = Math.max(5, rivalComebackProductScore(model, market))
  const prices: number[] = []
  for (const peer of state.player.models) {
    if (!isLivePublicModel(peer) || !modelMatchesMarket(peer, market)) {
      continue
    }
    prices.push(
      listedPrice(state.player.pricing, peer) *
        (ownScore / Math.max(5, rivalComebackProductScore(peer, market))),
    )
  }
  for (const rival of state.rivals) {
    if (rival.id === ownerId) continue
    for (const peer of rival.models) {
      if (!isLivePublicModel(peer) || !modelMatchesMarket(peer, market)) {
        continue
      }
      prices.push(
        listedPrice(rival.pricing, peer) *
          (ownScore / Math.max(5, rivalComebackProductScore(peer, market))),
      )
    }
  }
  if (prices.length === 0) return null
  prices.sort((a, b) => a - b)
  const mid = Math.floor(prices.length / 2)
  return prices.length % 2 === 1
    ? prices[mid]!
    : (prices[mid - 1]! + prices[mid]!) / 2
}

function priceComebackModel(
  state: SimState,
  rival: RivalLab,
  model: Model,
  episode: number,
): Model {
  const peerAnchor = peerPriceAnchor(state, rival.id, model)
  const rng = createRng(
    hashSeed(state.seed, rival.id, episode, 'comeback-list-price-v1'),
  )
  const desiredBlended =
    peerAnchor == null
      ? model.suggestedApiPrice * 0.88
      : peerAnchor * rng.range(0.72, 0.88)
  const desired = splitBlendedApiPrice(desiredBlended)
  const priceIn = Math.max(model.costApiPriceIn * 1.18, desired.priceIn)
  const priceOut = Math.max(model.costApiPriceOut * 1.18, desired.priceOut)
  return {
    ...model,
    apiPriceInPerMTok: priceIn,
    apiPriceOutPerMTok: priceOut,
    apiPricePerMTok: blendApiPrice(priceIn, priceOut),
  }
}

function routeComebackModel(
  pricing: ProductPricing,
  models: Model[],
  model: Model,
  precision: ReturnType<typeof chooseRivalServePrecision>,
): ProductPricing {
  const retainedIds = new Set(models.map((candidate) => candidate.id))
  const outputModalities = modelOutputModalities(model)
  const plans = pricing.plans.map((plan) => {
    const previousModels = plan.modelIds.filter((id) => retainedIds.has(id))
    const routes = { ...(plan.modalityRoutes ?? {}) }
    for (const modality of outputModalities) {
      const previous = routes[modality]
      const currentPrimary = models.find(
        (candidate) =>
          candidate.id !== model.id &&
          candidate.id === previous?.primaryModelId &&
          modelOutputModalities(candidate).includes(modality),
      )
      const bestFallback =
        currentPrimary ??
        models
          .filter(
            (candidate) =>
              candidate.id !== model.id &&
              modelOutputModalities(candidate).includes(modality),
          )
          .toSorted((left, right) => right.capability - left.capability)[0]
      routes[modality] = {
        modality,
        primaryModelId: model.id,
        fallbackModelId: bestFallback?.id ?? null,
        premiumShare: 0.82,
        precision,
      }
    }
    return {
      ...plan,
      modelIds: [...new Set([...previousModels, model.id])],
      servePrecisionByModel: {
        ...Object.fromEntries(
          Object.entries(plan.servePrecisionByModel ?? {}).filter(([id]) =>
            retainedIds.has(id),
          ),
        ),
        [model.id]: precision,
      },
      modalityRoutes: routes,
    }
  })
  return {
    ...pricing,
    apiPricePerMTok: model.apiPricePerMTok ?? pricing.apiPricePerMTok,
    apiPriceInPerMTok: model.apiPriceInPerMTok ?? pricing.apiPriceInPerMTok,
    apiPriceOutPerMTok: model.apiPriceOutPerMTok ?? pricing.apiPriceOutPerMTok,
    activeModelId: model.id,
    apiModelIds: [
      model.id,
      ...(pricing.apiModelIds ?? []).filter(
        (id) => id !== model.id && retainedIds.has(id),
      ),
    ],
    apiServePrecisionByModel: {
      ...Object.fromEntries(
        Object.entries(pricing.apiServePrecisionByModel ?? {}).filter(([id]) =>
          retainedIds.has(id),
        ),
      ),
      [model.id]: precision,
    },
    plans,
  }
}

/** Release announced checkpoints before tickRivals schedules fresh public evals. */
export function releaseDueRivalComebacks(state: SimState): SimState {
  let next = state
  for (const source of state.rivals) {
    const rival = next.rivals.find((candidate) => candidate.id === source.id)
    if (!rival) continue
    const plan = normalizeRivalFinancialComeback(rival)
    if (
      plan.status !== 'announced' ||
      plan.releaseDay == null ||
      plan.releaseDay > state.day ||
      !plan.modelId ||
      !plan.paramsB
    ) {
      continue
    }
    if (rival.models.some((model) => model.id === plan.modelId)) {
      next = withComeback(next, rival.id, {
        ...plan,
        status: 'released',
        completedDay: state.day,
      })
      continue
    }

    let model = buildAcquiredCheckpoint(next, rival, plan, plan.paramsB)
    const architectureWall = bentCapabilityCeiling(
      architecturePretrainingCapabilityCap({
        family: model.family,
        backbone: model.backbone,
      }),
    )
    if (model.capability > architectureWall + 1e-7) {
      // Defensive only: buildScaledModel already applies this wall.
      model = { ...model, capability: architectureWall }
    }
    const mixWeights = domainWeightsForPreset(plan.productPreset ?? 'language')
    const trainComputeSpent = Math.max(
      model.trainComputeSpent,
      plan.paramsB * (plan.backbone === 'moe' ? 1.4 : 2),
    )
    model = normalizeModelEvaluations({
      ...model,
      trainComputeSpent,
      capabilities: deriveModelCapabilities({
        finalCapability: model.capability,
        trainComputePfDays: trainComputeSpent,
        effectiveDataRatio: plan.dataCoverage ?? 8,
        dataQuality: plan.dataQuality ?? 88,
        domainWeights: mixWeights,
        io: model.io ?? ioForPreset(plan.productPreset ?? 'language'),
        family: model.family,
        postTrain: model.postTrain,
        quality: model.quality,
        modalityMaturity: plan.modalityExperience,
      }),
      economics: {
        lifetimeApiRevenue: 0,
        lifetimeSubRevenue: 0,
        lifetimeEnterpriseRevenue: 0,
        lifetimeServingCost: 0,
        lifetimeNet: 0,
        trainingInitialCost: plan.acquisitionCost ?? 0,
        trainingDataCost: 0,
        trainingDailyCost: 0,
      },
      checkpointEvaluations: [],
      trainingBenchmarkSnapshots: [],
    })
    model = priceComebackModel(next, rival, model, plan.distressEpisode)
    const models = [model, ...rival.models.slice(0, 3)]
    const precision = chooseRivalServePrecision({ ...rival, models })
    const pricing = routeComebackModel(rival.pricing, models, model, precision)
    const productPreset = model.productPreset ?? 'language'
    const backbone = model.backbone ?? 'dense'
    const releaseMilestones = (rival.releaseMilestones ?? []).some(
      (milestone) =>
        milestone.productPreset === productPreset &&
        milestone.backbone === backbone,
    )
      ? rival.releaseMilestones
      : [
          ...(rival.releaseMilestones ?? []),
          {
            productPreset,
            backbone,
            modelId: model.id,
            releaseDay: state.day,
          },
        ]
    const releasedPlan: RivalFinancialComeback = {
      ...plan,
      status: 'released',
      completedDay: state.day,
    }
    // Keep the canonical lab index aligned for all non-rival-specific fields.
    next = updateLab(next, rival.id, (lab) => ({
      ...lab,
      models,
      pricing,
    }))
    next = {
      ...next,
      rivals: next.rivals.map((candidate) =>
        candidate.id === rival.id
          ? {
              ...candidate,
              releaseMilestones,
              financialComeback: releasedPlan,
              publicEstimate: candidate.publicEstimate
                ? { ...candidate.publicEstimate, announcedProject: null }
                : candidate.publicEstimate,
            }
          : candidate,
      ),
      news: [
        `Day ${state.day}: ${rival.name} releases ${model.name} at ${rivalComebackProductScore(model).toFixed(1)} versus its ${plan.referenceFrontierCapability?.toFixed(1) ?? 'unrated'} announcement frontier; cost-backed API list is $${(model.apiPricePerMTok ?? 0).toFixed(2)}/MTok.`,
        ...next.news,
      ].slice(0, 64),
    }
  }
  return next
}
