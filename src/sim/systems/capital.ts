import type {
  CapitalStack,
  DebtInstrument,
  DebtInstrumentKind,
  EffortRecipe,
  EquityOffer,
  InvestorPitchTarget,
  LabId,
  Model,
  InvestorPitchRecord,
  SimState,
} from '../types'
import { createRng, hashSeed } from '../rng'
import { getLab, updateLab } from './labEngine'
import {
  maybeStartRivalFinancialComeback,
  normalizeRivalFinancialComeback,
} from './rivalComeback'
import { isLivePublicModel } from '../modelRelease'
import { isDcKind } from './map'
import { facilityAnchorTiles } from './worldAccess'
import {
  effortViewForRecipe,
  INSTANT_EFFORT_ID,
  instantRecipe,
  migrateEffortRecipes,
  peakServedCapability,
} from '../balance/modelProduct'

const DAY_COUNT = 365

/** Rival-specific tolerance prevents a shared market shock from synchronizing every board. */
export function rivalDistressRunwayThreshold(
  seed: number,
  rivalId: string,
): number {
  return 72 + (hashSeed(seed, rivalId, 'distress-runway-v2') % 37)
}

/** Deterministic stage bands retain urgency without identical countdown clocks. */
export function rivalRestructuringStageDays(
  seed: number,
  rivalId: string,
  stage: CapitalStack['restructuring']['stage'],
  distressEpisode: number,
): number {
  const bands: Partial<
    Record<CapitalStack['restructuring']['stage'], readonly [number, number]>
  > = {
    warning: [50, 75],
    refinance: [35, 55],
    asset_sale: [22, 40],
  }
  const band = bands[stage]
  if (!band) return 0
  return (
    band[0] +
    (hashSeed(seed, rivalId, stage, distressEpisode, 'restructure-days-v2') %
      (band[1] - band[0] + 1))
  )
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

function defaultCapital(): CapitalStack {
  return {
    capTable: [
      {
        holderId: 'founders',
        holderName: 'Founders',
        ownership: 0.9,
        votingPower: 0.95,
        kind: 'founder',
      },
      {
        holderId: 'option-pool',
        holderName: 'Team option pool',
        ownership: 0.1,
        votingPower: 0.05,
        kind: 'option_pool',
      },
    ],
    fundingRounds: [],
    debt: [],
    investorConfidence: 0.55,
    boardPressure: 0.1,
    founderControl: 0.95,
    pitchCooldownUntilDay: 0,
    pitchModelCooldowns: {},
    pitchHistory: [],
    restructuring: { active: false, daysLeft: 0, stage: 'none' },
  }
}

function capitalFor(state: SimState, labId: LabId = state.playerLabId): CapitalStack {
  if (labId === state.playerLabId) return state.player.capital ?? defaultCapital()
  return state.rivals.find((rival) => rival.id === labId)?.capital ?? defaultCapital()
}

function capitalLabView(state: SimState, labId: LabId) {
  if (labId === state.playerLabId) {
    return {
      id: state.playerLabId,
      name: state.player.name,
      cash: state.player.cash,
      finance: state.player.finance,
    }
  }
  const rival = state.rivals.find((candidate) => candidate.id === labId)
  if (!rival) throw new Error(`Unknown lab ${labId}`)
  return {
    id: rival.id,
    name: rival.name,
    cash: rival.cash,
    finance: rival.finance ?? getLab(state, labId).finance,
  }
}

function pushAlert(
  state: SimState,
  severity: 'info' | 'warn' | 'danger',
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      { id: `capital-${state.day}-${state.tick}-${message}`, day: state.day, severity, message },
      ...state.alerts,
    ].slice(0, 80),
  }
}

export interface CapitalSnapshot {
  founderOwnership: number
  investorOwnership: number
  optionPool: number
  debtOutstanding: number
  netCash: number
  annualRecurringRevenue: number
  investorConfidence: number
  boardPressure: number
}

export function capitalSnapshot(
  state: SimState,
  labId: LabId = state.playerLabId,
): CapitalSnapshot {
  const lab = capitalLabView(state, labId)
  const capital = capitalFor(state, labId)
  const ownership = (kind: CapitalStack['capTable'][number]['kind']) =>
    capital.capTable
      .filter((stake) => stake.kind === kind)
      .reduce((sum, stake) => sum + stake.ownership, 0)
  const debtOutstanding = capital.debt.reduce((sum, debt) => sum + debt.remaining, 0)
  return {
    founderOwnership: ownership('founder'),
    investorOwnership: ownership('investor') + ownership('public'),
    optionPool: ownership('option_pool'),
    debtOutstanding,
    netCash: lab.cash - debtOutstanding,
    annualRecurringRevenue: Math.max(0, lab.finance.dayRevenue * DAY_COUNT),
    investorConfidence: capital.investorConfidence,
    boardPressure: capital.boardPressure,
  }
}

const INVESTOR_PITCH_COOLDOWN_DAYS = 30
const INVESTOR_PITCH_HISTORY_LIMIT = 16

/** A non-mutating model-backed term sheet shown in Finances → Capital. */
export interface InvestorPitchPreview {
  /** Select value: `modelId::effortId`. Bare model ids still decode as Instant. */
  id: string
  modelId: string
  effortId: string
  effortName: string
  modelName: string
  eligible: boolean
  reason?: string
  investorName: string
  capability: number
  frontierCapability: number
  capabilityScore: number
  qualityScore: number
  overusePenalty: number
  successChance: number
  cashRaised: number
  preMoneyValuation: number
  postMoneyValuation: number
  investorOwnership: number
  optionPoolTopUp: number
  confidenceRequired: number
  cooldownUntilDay: number
  expiresDay: number
}

/** Dropdown row for disclosing a checkpoint at a specific thinking level. */
export interface InvestorPitchOption {
  id: string
  modelId: string
  effortId: string
  effortName: string
  name: string
  label: string
  capability: number
  release: Model['release']
  shipped: boolean
}

const PITCH_OPTION_SEP = '::'

export function encodeInvestorPitchOptionId(
  modelId: string,
  effortId: string = INSTANT_EFFORT_ID,
): string {
  return `${modelId}${PITCH_OPTION_SEP}${effortId}`
}

export function decodeInvestorPitchOptionId(
  optionId: string,
): InvestorPitchTarget {
  const sep = optionId.lastIndexOf(PITCH_OPTION_SEP)
  if (sep <= 0) {
    return { modelId: optionId, effortId: INSTANT_EFFORT_ID }
  }
  const effortId = optionId.slice(sep + PITCH_OPTION_SEP.length)
  return {
    modelId: optionId.slice(0, sep),
    effortId: effortId.length > 0 ? effortId : INSTANT_EFFORT_ID,
  }
}

function trainedPitchRecipes(model: Model): EffortRecipe[] {
  const recipes = migrateEffortRecipes(model.productProfile).filter(
    (recipe) => recipe.trained,
  )
  return recipes.length > 0 ? recipes : [instantRecipe()]
}

function pitchDisclosureName(
  model: Model,
  recipe: Pick<EffortRecipe, 'name' | 'kind'>,
  hasNamedHeads: boolean,
): string {
  if (!hasNamedHeads) return model.name
  return `${model.name}-${recipe.name}`
}

function modelsForLab(state: SimState, labId: LabId): Model[] {
  if (labId === state.playerLabId) return state.player.models
  return state.rivals.find((rival) => rival.id === labId)?.models ?? []
}

/** Internal checkpoints and live public models can both be disclosed to investors. */
export function investorPitchModels(
  state: SimState,
  labId: LabId = state.playerLabId,
): Model[] {
  return modelsForLab(state, labId)
    .filter(
      (model) =>
        model.archived !== true &&
        (model.release === 'internal' || isLivePublicModel(model)),
    )
    .toSorted(
      (a, b) =>
        b.capability - a.capability ||
        a.releaseDay - b.releaseDay ||
        a.id.localeCompare(b.id),
    )
}

/** Models currently available to pitch, excluding model and desk cooldowns. */
export function eligibleInvestorPitchModels(
  state: SimState,
  labId: LabId = state.playerLabId,
): Model[] {
  const capital = capitalFor(state, labId)
  const deskCooldown = Math.max(0, Math.floor(capital.pitchCooldownUntilDay ?? 0))
  const cooldowns = capital.pitchModelCooldowns ?? {}
  return investorPitchModels(state, labId).filter(
    (model) =>
      state.day >= deskCooldown &&
      state.day >= Math.max(0, Math.floor(cooldowns[model.id] ?? 0)),
  )
}

/** One dropdown row per trained thinking head. Instant-only models stay a single option. */
export function investorPitchOptions(
  state: SimState,
  labId: LabId = state.playerLabId,
): InvestorPitchOption[] {
  const options: InvestorPitchOption[] = []
  for (const model of investorPitchModels(state, labId)) {
    const recipes = trainedPitchRecipes(model)
    const hasNamedHeads = recipes.some((recipe) => recipe.kind !== 'instant')
    for (const recipe of recipes) {
      const view = effortViewForRecipe(model, recipe.id)
      const capability = view?.capability ?? model.capability
      const name = pitchDisclosureName(model, recipe, hasNamedHeads)
      const released = model.release === 'released' || Boolean(model.shipped)
      options.push({
        id: encodeInvestorPitchOptionId(model.id, recipe.id),
        modelId: model.id,
        effortId: recipe.id,
        effortName: recipe.name,
        name,
        label: `${name} · cap ${capability.toFixed(0)} · ${released ? 'released' : 'internal'}`,
        capability,
        release: model.release,
        shipped: Boolean(model.shipped),
      })
    }
  }
  return options.toSorted(
    (a, b) =>
      b.capability - a.capability ||
      a.modelId.localeCompare(b.modelId) ||
      a.effortId.localeCompare(b.effortId),
  )
}

function pitchModelOverusePenalty(model: Model): number {
  const repeatedEpochs = Math.max(0, (model.repeatedDataEpochs ?? 1) - 1)
  const benchmarkOverfit = Math.max(0, model.benchmarkOverfit ?? 0)
  const thinData = Math.max(0, 0.85 - (model.effectiveDataRatio ?? model.dataCoverage ?? 1))
  const listedSaturation = model.commerciallyOffered === true ? 0.08 : 0
  return clamp(
    repeatedEpochs / 4 * 0.62 +
      benchmarkOverfit * 0.28 +
      thinData * 0.3 +
      listedSaturation,
    0,
    1,
  )
}

function pitchFrontierCapability(state: SimState): number {
  const capabilities = [
    ...state.player.models
      .filter((model) => isLivePublicModel(model))
      .map((model) => peakServedCapability(model)),
    ...state.rivals.flatMap((rival) =>
      rival.models
        .filter((model) => isLivePublicModel(model))
        .map((model) => peakServedCapability(model)),
    ),
  ].filter((value) => Number.isFinite(value) && value > 0)
  return Math.max(50, ...capabilities)
}

function pitchInvestorName(strength: number): string {
  if (strength >= 0.9) return 'Civic Frontier Partners'
  if (strength >= 0.68) return 'Horizon Compute Fund'
  return 'Northstar Growth'
}

function roundedMillion(value: number): number {
  return Math.round(Math.max(0, value) / 1_000_000) * 1_000_000
}

function ineligiblePitchPreview(
  state: SimState,
  optionId: string,
  reason: string,
  labId: LabId,
): InvestorPitchPreview {
  const target = decodeInvestorPitchOptionId(optionId)
  const model = modelsForLab(state, labId).find((candidate) => candidate.id === target.modelId)
  const recipes = model ? trainedPitchRecipes(model) : []
  const hasNamedHeads = recipes.some((recipe) => recipe.kind !== 'instant')
  const recipe =
    recipes.find((item) => item.id === target.effortId) ??
    (target.effortId === INSTANT_EFFORT_ID ? instantRecipe() : undefined)
  const view = model ? effortViewForRecipe(model, target.effortId) : null
  const capability = Math.max(0, view?.capability ?? model?.capability ?? 0)
  const frontier = pitchFrontierCapability(state)
  const lab = capitalLabView(state, labId)
  const capital = capitalFor(state, labId)
  return {
    id: encodeInvestorPitchOptionId(target.modelId, target.effortId),
    modelId: target.modelId,
    effortId: target.effortId,
    effortName: recipe?.name ?? 'Instant',
    modelName: model
      ? pitchDisclosureName(model, recipe ?? instantRecipe(), hasNamedHeads)
      : 'Unknown model',
    eligible: false,
    reason,
    investorName: 'Investor desk',
    capability,
    frontierCapability: frontier,
    capabilityScore: clamp(capability / Math.max(1, frontier), 0, 1.2),
    qualityScore: 0,
    overusePenalty: model ? pitchModelOverusePenalty(model) : 0,
    successChance: 0,
    cashRaised: 0,
    preMoneyValuation: Math.max(0, lab.finance.valuation),
    postMoneyValuation: Math.max(0, lab.finance.valuation),
    investorOwnership: 0,
    optionPoolTopUp: 0,
    confidenceRequired: 1,
    cooldownUntilDay: Math.max(
      state.day,
      Math.floor(capital.pitchCooldownUntilDay ?? 0),
    ),
    expiresDay: state.day,
  }
}

/**
 * Build a transparent model-backed investor pitch. This is deliberately pure:
 * previews never consume the seeded roll, cash, or a pitch cooldown.
 * `optionId` is `modelId::effortId`; a bare model id still decodes as Instant.
 */
export function investorPitchPreview(
  state: SimState,
  optionId: string,
  labId: LabId = state.playerLabId,
): InvestorPitchPreview {
  const target = decodeInvestorPitchOptionId(optionId)
  const encodedId = encodeInvestorPitchOptionId(target.modelId, target.effortId)
  const model = investorPitchModels(state, labId).find(
    (candidate) => candidate.id === target.modelId,
  )
  if (!model) {
    return ineligiblePitchPreview(
      state,
      encodedId,
      'Choose an internal or released model first.',
      labId,
    )
  }
  const recipes = trainedPitchRecipes(model)
  const recipe = recipes.find((item) => item.id === target.effortId)
  const view = effortViewForRecipe(model, target.effortId)
  if (!recipe || !view) {
    return ineligiblePitchPreview(
      state,
      encodedId,
      'That thinking level is not trained on this model.',
      labId,
    )
  }
  const capital = capitalFor(state, labId)
  const deskCooldown = Math.max(0, Math.floor(capital.pitchCooldownUntilDay ?? 0))
  const modelCooldown = Math.max(0, Math.floor(capital.pitchModelCooldowns?.[model.id] ?? 0))
  const cooldownUntilDay = Math.max(deskCooldown, modelCooldown)
  if (state.day < cooldownUntilDay) {
    return ineligiblePitchPreview(
      state,
      encodedId,
      `Investor desk is cooling down until day ${cooldownUntilDay}.`,
      labId,
    )
  }

  const frontierCapability = pitchFrontierCapability(state)
  const capability = Math.max(0, view.capability)
  const capabilityScore = clamp(capability / frontierCapability, 0, 1.2)
  const quality = model.quality
  const qualityScore = clamp(
    ((quality?.reliability ?? 50) * 0.45 +
      (quality?.safety ?? 50) * 0.25 +
      (quality?.reasoning ?? capability) * 0.2 +
      (quality?.coding ?? capability) * 0.1) /
      100,
    0,
    1,
  )
  const overusePenalty = pitchModelOverusePenalty(model)
  const frontierEdge = clamp((capability - frontierCapability * 0.72) / frontierCapability, -0.5, 0.35)
  const strength = clamp(
    capabilityScore * 0.5 + qualityScore * 0.3 + (0.5 + frontierEdge) * 0.2 - overusePenalty * 0.25,
    0,
    1.2,
  )
  const confidence = clamp(capital.investorConfidence, 0, 1)
  const successChance = clamp(
    0.18 + confidence * 0.34 + strength * 0.42 - overusePenalty * 0.2,
    0.08,
    0.94,
  )
  const investorName = pitchInvestorName(strength)
  const valuation = Math.max(
    10_000_000,
    capitalLabView(state, labId).finance.valuation,
    capitalLabView(state, labId).finance.dayRevenue * DAY_COUNT * 8,
  )
  const preMoneyValuation = roundedMillion(
    Math.max(10_000_000, valuation * (0.9 + strength * 1.4) * (0.9 + confidence * 0.25)),
  )
  const chequeMultiple = clamp(
    0.06 + strength * 0.14 - overusePenalty * 0.04,
    0.025,
    0.24,
  )
  const cashRaised = roundedMillion(
    clamp(valuation * chequeMultiple, 8_000_000, 900_000_000),
  )
  const postMoneyValuation = preMoneyValuation + cashRaised
  const investorOwnership = cashRaised / Math.max(1, postMoneyValuation)
  const optionPoolTopUp = clamp(0.005 + overusePenalty * 0.045 + (1 - strength) * 0.02, 0, 0.08)
  const confidenceRequired = clamp(0.62 - strength * 0.22 + overusePenalty * 0.1, 0.3, 0.78)
  const eligible = confidence >= confidenceRequired
  const hasNamedHeads = recipes.some((item) => item.kind !== 'instant')
  return {
    id: encodedId,
    modelId: model.id,
    effortId: recipe.id,
    effortName: recipe.name,
    modelName: pitchDisclosureName(model, recipe, hasNamedHeads),
    eligible,
    reason: eligible
      ? undefined
      : `Investor confidence ${(confidence * 100).toFixed(0)}% is below the ${(
          confidenceRequired *
          100
        ).toFixed(0)}% threshold for this pitch.`,
    investorName,
    capability,
    frontierCapability,
    capabilityScore,
    qualityScore,
    overusePenalty,
    successChance,
    cashRaised,
    preMoneyValuation,
    postMoneyValuation,
    investorOwnership,
    optionPoolTopUp,
    confidenceRequired,
    cooldownUntilDay,
    expiresDay: state.day + INVESTOR_PITCH_COOLDOWN_DAYS,
  }
}

function withPitchRecord(
  state: SimState,
  labId: LabId,
  record: InvestorPitchRecord,
  cooldownUntilDay: number,
): SimState {
  return updateLab(state, labId, (current) => {
    const capital = current.capital ?? defaultCapital()
    return {
      ...current,
      capital: {
        ...capital,
        pitchCooldownUntilDay: cooldownUntilDay,
        pitchModelCooldowns: {
          ...(capital.pitchModelCooldowns ?? {}),
          [record.modelId]: cooldownUntilDay,
        },
        pitchHistory: [record, ...(capital.pitchHistory ?? [])].slice(
          0,
          INVESTOR_PITCH_HISTORY_LIMIT,
        ),
      },
    }
  })
}

/** Resolve a model-backed pitch using a stable (seed, day, model, thinking head) roll. */
export function acceptInvestorPitch(
  state: SimState,
  optionId: string,
  labId: LabId = state.playerLabId,
): SimState {
  const preview = investorPitchPreview(state, optionId, labId)
  const notify = (next: SimState, severity: 'info' | 'warn', message: string) =>
    labId === state.playerLabId
      ? pushAlert(next, severity, message)
      : {
          ...next,
          news: [`Day ${state.day}: ${capitalLabView(state, labId).name} — ${message}`, ...next.news].slice(0, 64),
        }
  if (!preview.eligible) {
    return notify(state, 'warn', preview.reason ?? 'That model is not ready for an investor pitch.')
  }
  const rollSeed =
    preview.effortId === INSTANT_EFFORT_ID
      ? hashSeed(state.seed, state.day, preview.modelId, 'investor-pitch-v1')
      : hashSeed(state.seed, state.day, preview.modelId, preview.effortId, 'investor-pitch-v1')
  const roll = createRng(rollSeed).next()
  const funded = roll < preview.successChance
  const cooldownUntilDay = state.day + INVESTOR_PITCH_COOLDOWN_DAYS
  const record: InvestorPitchRecord = {
    id:
      preview.effortId === INSTANT_EFFORT_ID
        ? `pitch-${preview.modelId}-${state.day}`
        : `pitch-${preview.modelId}-${preview.effortId}-${state.day}`,
    modelId: preview.modelId,
    effortId: preview.effortId,
    modelName: preview.modelName,
    investorName: preview.investorName,
    day: state.day,
    outcome: funded ? 'funded' : 'declined',
    successChance: preview.successChance,
    cashRaised: funded ? preview.cashRaised : 0,
    preMoneyValuation: preview.preMoneyValuation,
    postMoneyValuation: funded ? preview.postMoneyValuation : preview.preMoneyValuation,
    investorOwnership: funded ? preview.investorOwnership : 0,
    cooldownUntilDay,
  }
  if (!funded) {
    const cooled = updateLab(state, labId, (current) => {
      const capital = current.capital ?? defaultCapital()
      return {
        ...current,
        capital: {
          ...capital,
          investorConfidence: clamp(capital.investorConfidence - 0.015, 0, 1),
          boardPressure: clamp(capital.boardPressure + 0.01, 0, 1),
        },
      }
    })
    return notify(
      withPitchRecord(cooled, labId, record, cooldownUntilDay),
      'warn',
      `${preview.investorName} passed on ${preview.modelName}. The desk is closed until day ${cooldownUntilDay}.`,
    )
  }
  const offer: EquityOffer = {
    id: record.id,
    modelId: preview.modelId,
    effortId: preview.effortId,
    investorName: preview.investorName,
    cashRaised: preview.cashRaised,
    preMoneyValuation: preview.preMoneyValuation,
    postMoneyValuation: preview.postMoneyValuation,
    investorOwnership: preview.investorOwnership,
    optionPoolTopUp: preview.optionPoolTopUp,
    confidenceRequired: preview.confidenceRequired,
    expiresDay: preview.expiresDay,
  }
  const fundedState = acceptEquityOffer(state, offer, labId)
  return withPitchRecord(fundedState, labId, record, cooldownUntilDay)
}

/** Deterministic term sheets; requesting them never changes campaign state. */
export function requestEquityOffers(
  state: SimState,
  labId: LabId = state.playerLabId,
): EquityOffer[] {
  const lab = capitalLabView(state, labId)
  const capital = capitalFor(state, labId)
  const valuation = Math.max(
    10_000_000,
    lab.finance.valuation,
    lab.finance.dayRevenue * DAY_COUNT * 8,
  )
  const confidence = clamp(capital.investorConfidence, 0, 1)
  const terms = [
    { name: 'Northstar Growth', frac: 0.09, floor: 12_000_000, multiple: 0.9, topUp: 0 },
    { name: 'Horizon Compute Fund', frac: 0.16, floor: 28_000_000, multiple: 1.05, topUp: 0.025 },
    { name: 'Civic Frontier Partners', frac: 0.24, floor: 55_000_000, multiple: 1.2, topUp: 0.04 },
  ]
  return terms.map((term, index) => {
    const cash = Math.round(
      clamp(Math.max(valuation * term.frac, term.floor), 12_000_000, 900_000_000) / 1_000_000,
    ) * 1_000_000
    const preMoneyValuation = Math.round(valuation * term.multiple * (0.8 + confidence * 0.4))
    const postMoneyValuation = preMoneyValuation + cash
    return {
      id: `equity-${labId}-${state.day}-${index}`,
      investorName: term.name,
      cashRaised: cash,
      preMoneyValuation,
      postMoneyValuation,
      investorOwnership: cash / postMoneyValuation,
      optionPoolTopUp: term.topUp,
      confidenceRequired: 0.35 + index * 0.15,
      expiresDay: state.day + 30,
    }
  })
}

export function acceptEquityOffer(
  state: SimState,
  offer: EquityOffer,
  labId: LabId = state.playerLabId,
): SimState {
  const lab = capitalLabView(state, labId)
  const capital = capitalFor(state, labId)
  const notify = (
    next: SimState,
    severity: 'info' | 'warn' | 'danger',
    message: string,
  ): SimState =>
    labId === state.playerLabId
      ? pushAlert(next, severity, message)
      : {
          ...next,
          news: [`Day ${state.day}: ${lab.name} — ${message}`, ...next.news].slice(0, 64),
        }
  if (state.day > offer.expiresDay) return notify(state, 'warn', 'That equity offer has expired.')
  if (capital.investorConfidence < offer.confidenceRequired) {
    return notify(state, 'warn', `${offer.investorName} withdrew: investor confidence is too low.`)
  }
  if (offer.cashRaised <= 0 || offer.preMoneyValuation <= 0) return state
  if (capital.fundingRounds.some((round) => round.id === offer.id)) {
    return notify(state, 'warn', 'That term sheet was already accepted this round.')
  }

  const postMoney = offer.preMoneyValuation + offer.cashRaised
  const investorOwnership = offer.cashRaised / postMoney
  const optionTopUp = clamp(offer.optionPoolTopUp, 0, 0.15)
  const existingMultiplier = (1 - investorOwnership) * (1 - optionTopUp)
  const capTable = capital.capTable.map((stake) => ({
    ...stake,
    ownership: stake.ownership * existingMultiplier,
    votingPower: stake.votingPower * existingMultiplier,
  }))
  if (optionTopUp > 0) {
    const pool = capTable.find((stake) => stake.kind === 'option_pool')
    if (pool) pool.ownership += optionTopUp * (1 - investorOwnership)
    else {
      capTable.push({
        holderId: `option-pool-${state.day}`,
        holderName: 'New option pool',
        ownership: optionTopUp * (1 - investorOwnership),
        votingPower: 0,
        kind: 'option_pool',
      })
    }
  }
  capTable.push({
    holderId: offer.id,
    holderName: offer.investorName,
    ownership: investorOwnership,
    votingPower: investorOwnership,
    kind: 'investor',
  })
  const total = capTable.reduce((sum, stake) => sum + stake.ownership, 0) || 1
  const normalized = capTable.map((stake) => ({ ...stake, ownership: stake.ownership / total }))
  const founderControl = capital.founderControl * existingMultiplier

  const cash = lab.cash + offer.cashRaised
  const next = updateLab(state, labId, (current) => ({
    ...current,
    cash,
    finance: {
      ...current.finance,
      cash,
      valuation: postMoney,
      peakCash: Math.max(current.finance.peakCash, cash),
    },
    capital: {
        ...capital,
        capTable: normalized,
        fundingRounds: [
          ...capital.fundingRounds,
          {
            id: offer.id,
            label: capital.fundingRounds.length === 0 ? 'Seed' : `Series ${String.fromCharCode(64 + capital.fundingRounds.length)}`,
            day: state.day,
            preMoneyValuation: offer.preMoneyValuation,
            cashRaised: offer.cashRaised,
            postMoneyValuation: postMoney,
            dilution: investorOwnership,
            investorName: offer.investorName,
          },
        ],
        investorConfidence: clamp(capital.investorConfidence + 0.04, 0, 1),
        boardPressure: clamp(capital.boardPressure + investorOwnership * 0.35, 0, 1),
        founderControl: clamp(founderControl, 0, 1),
    },
  }))
  return notify(
    next,
    'info',
    `${offer.investorName} invested $${(offer.cashRaised / 1_000_000).toFixed(0)}M at a $${(offer.preMoneyValuation / 1_000_000).toFixed(0)}M pre-money valuation (${(investorOwnership * 100).toFixed(1)}% dilution).`,
  )
}

export interface EquityBuybackQuote {
  holderId: string
  ownership: number
  premium: number
  cost: number
  founderOwnershipAfter: number
}

/** Repurchase an outside holder's stake and return it to founder ownership. */
export function equityBuybackQuote(
  state: SimState,
  holderId: string,
  ownership: number,
): EquityBuybackQuote | null {
  const capital = capitalFor(state)
  const seller = capital.capTable.find((stake) => stake.holderId === holderId)
  if (!seller || (seller.kind !== 'investor' && seller.kind !== 'public')) return null
  const amount = clamp(ownership, 0, seller.ownership)
  if (amount <= 0) return null
  const valuation = Math.max(10_000_000, state.player.finance.valuation)
  const premium = 1.08 + capital.investorConfidence * 0.08
  return {
    holderId,
    ownership: amount,
    premium,
    cost: valuation * amount * premium,
    founderOwnershipAfter: capitalSnapshot(state).founderOwnership + amount,
  }
}

export function buyBackEquity(
  state: SimState,
  holderId: string,
  ownership: number,
): SimState {
  const quote = equityBuybackQuote(state, holderId, ownership)
  if (!quote) return pushAlert(state, 'warn', 'That stake is not available for repurchase.')
  if (state.player.cash < quote.cost) {
    return pushAlert(
      state,
      'warn',
      `Buyback needs $${(quote.cost / 1_000_000).toFixed(2)}M cash.`,
    )
  }
  const capital = capitalFor(state)
  const seller = capital.capTable.find((stake) => stake.holderId === holderId)!
  let founders = capital.capTable.find((stake) => stake.kind === 'founder')
  const capTable = capital.capTable
    .map((stake) =>
      stake.holderId === holderId
        ? {
            ...stake,
            ownership: stake.ownership - quote.ownership,
            votingPower: Math.max(0, stake.votingPower - quote.ownership),
          }
        : stake.kind === 'founder'
          ? {
              ...stake,
              ownership: stake.ownership + quote.ownership,
              votingPower: Math.min(1, stake.votingPower + quote.ownership),
            }
          : stake,
    )
    .filter((stake) => stake.ownership > 0.000001)
  if (!founders) {
    founders = {
      holderId: 'founders',
      holderName: 'Founders',
      ownership: quote.ownership,
      votingPower: quote.ownership,
      kind: 'founder',
    }
    capTable.push(founders)
  }
  const cash = state.player.cash - quote.cost
  return pushAlert(
    {
      ...state,
      player: {
        ...state.player,
        cash,
        finance: { ...state.player.finance, cash },
        capital: {
          ...capital,
          capTable,
          founderControl: clamp(capital.founderControl + quote.ownership * 0.8, 0, 1),
          boardPressure: clamp(capital.boardPressure - quote.ownership * 0.45, 0, 1),
        },
      },
    },
    'info',
    `Repurchased ${(quote.ownership * 100).toFixed(2)}% from ${seller.holderName} for $${(quote.cost / 1_000_000).toFixed(2)}M.`,
  )
}

function debtTerms(kind: DebtInstrumentKind): { apr: number; termDays: number; label: string } {
  switch (kind) {
    case 'revolver':
      return { apr: 0.115, termDays: 365, label: 'Revenue revolver' }
    case 'equipment':
      return { apr: 0.082, termDays: 1_095, label: 'Equipment finance' }
    case 'project_finance':
      return { apr: 0.095, termDays: 1_825, label: 'Campus project finance' }
    case 'venture_debt':
      return { apr: 0.16, termDays: 730, label: 'Venture debt' }
    case 'bond':
      return { apr: 0.065, termDays: 2_555, label: 'Corporate bond' }
  }
}

export interface BankingProduct {
  kind: DebtInstrumentKind
  label: string
  apr: number
  termDays: number
  max: number
  available: number
  collateral: number
  covenant: string
  purpose: string
}

const DEBT_PURPOSE: Record<DebtInstrumentKind, string> = {
  revolver: 'Working capital against recurring revenue',
  equipment: 'Accelerators, racks, and serving equipment',
  project_finance: 'Secured campus and power construction',
  venture_debt: 'Frontier R&D backed by company value',
  bond: 'Long-duration institutional financing',
}

function adjustedDebtApr(state: SimState, kind: DebtInstrumentKind): number {
  const base = debtTerms(kind).apr
  const valuation = Math.max(0, state.player.finance.valuation)
  const valueDiscount = valuation >= 5_000_000_000
    ? 0.025
    : valuation >= 1_000_000_000
      ? 0.015
      : valuation >= 250_000_000
        ? 0.007
        : 0
  const profitRisk = state.player.finance.dayNet < 0 ? 0.025 : -0.006
  const brandRisk = state.player.brandTrust < 40 ? 0.018 : 0
  return clamp(base + profitRisk + brandRisk - valueDiscount, 0.045, 0.24)
}

export function bankingProducts(state: SimState): BankingProduct[] {
  const outstandingByKind = new Map<DebtInstrumentKind, number>()
  for (const debt of state.player.capital?.debt ?? []) {
    outstandingByKind.set(
      debt.kind,
      (outstandingByKind.get(debt.kind) ?? 0) + debt.remaining,
    )
  }
  return (['revolver', 'equipment', 'project_finance', 'venture_debt', 'bond'] as const).map((kind) => {
    const terms = debtTerms(kind)
    const capacity = debtCapacity(state, kind)
    return {
      kind,
      label: terms.label,
      apr: adjustedDebtApr(state, kind),
      termDays: terms.termDays,
      max: capacity.max,
      available: Math.max(0, capacity.max - (outstandingByKind.get(kind) ?? 0)),
      collateral: capacity.collateral,
      covenant: capacity.covenant,
      purpose: DEBT_PURPOSE[kind],
    }
  })
}

function debtCapacity(state: SimState, kind: DebtInstrumentKind): { max: number; collateral: number; covenant: string } {
  const annualRevenue = Math.max(0, state.player.finance.dayRevenue * DAY_COUNT)
  const equipment = (state.player.rackFleet ?? []).reduce(
    (sum, rack) => sum + Math.max(0, rack.count) * 650_000,
    0,
  )
  const hasSite = facilityAnchorTiles(state, {
    ownerId: state.playerLabId,
  }).some((tile) => isDcKind(tile.kind))
  switch (kind) {
    case 'revolver':
      return { max: annualRevenue * 0.25, collateral: annualRevenue, covenant: 'Debt below 35% of annual recurring revenue' }
    case 'equipment':
      return { max: equipment * 0.7, collateral: equipment, covenant: 'Financed racks remain operational' }
    case 'project_finance':
      return { max: hasSite ? Math.max(15_000_000, equipment * 2) : 0, collateral: hasSite ? Math.max(20_000_000, equipment * 2.5) : 0, covenant: 'Campus reaches commercial operation' }
    case 'venture_debt':
      return { max: state.player.finance.valuation * 0.12, collateral: 0, covenant: 'Maintain at least 90 days runway' }
    case 'bond':
      return { max: state.calendar.year >= 2032 && state.player.finance.valuation >= 1_000_000_000 ? state.player.finance.valuation * 0.18 : 0, collateral: 0, covenant: 'Positive trailing-year operating cash flow' }
  }
}

function labDebtCapacity(
  state: SimState,
  labId: LabId,
  kind: DebtInstrumentKind,
): { max: number; collateral: number; covenant: string } {
  if (labId === state.playerLabId) return debtCapacity(state, kind)
  const lab = getLab(state, labId)
  const annualRevenue = Math.max(0, lab.finance.dayRevenue * DAY_COUNT)
  const equipment = lab.rackFleet.reduce(
    (sum, rack) => sum + Math.max(0, rack.count) * Math.max(1, rack.paidEach),
    0,
  )
  const siteCollateral = state.siteCapacities
    .filter((site) => site.labId === labId && site.status === 'active')
    .reduce((sum, site) => sum + site.firmMw * 5_000_000, 0)
  switch (kind) {
    case 'revolver':
      return {
        max: annualRevenue * 0.25,
        collateral: annualRevenue,
        covenant: 'Debt below 35% of annual recurring revenue',
      }
    case 'equipment':
      return {
        max: equipment * 0.7,
        collateral: equipment,
        covenant: 'Financed racks remain operational',
      }
    case 'project_finance':
      return {
        max: Math.max(
          siteCollateral * 0.72,
          Math.min(lab.finance.valuation * 0.42, 320_000_000),
        ),
        collateral: Math.max(siteCollateral, lab.finance.valuation * 0.2),
        covenant: 'Campus reaches commercial operation',
      }
    case 'venture_debt':
      return {
        max: lab.finance.valuation * 0.18,
        collateral: 0,
        covenant: 'Maintain at least 90 days runway',
      }
    case 'bond':
      return {
        max:
          state.calendar.year >= 2032 && lab.finance.valuation >= 1_000_000_000
            ? lab.finance.valuation * 0.18
            : 0,
        collateral: 0,
        covenant: 'Positive trailing-year operating cash flow',
      }
  }
}

const RIVAL_CAMPUS_EQUITY_COOLDOWN_DAYS = 90
const RIVAL_CAMPUS_MIN_FOUNDER_OWNERSHIP = 0.28

function alignIndexedLabFromRival(state: SimState, labId: LabId): SimState {
  if (labId === state.playerLabId) return state
  const rival = state.rivals.find((entry) => entry.id === labId)
  const indexed = state.labs?.[labId]
  if (!rival || !indexed) return state
  return {
    ...state,
    labs: {
      ...state.labs,
      [labId]: {
        ...indexed,
        cash: rival.cash,
        finance: { ...indexed.finance, ...(rival.finance ?? {}), cash: rival.cash },
        data: rival.data ?? indexed.data,
        capital: rival.capital ?? indexed.capital,
      },
    },
  }
}

/**
 * Raise equity and/or campus debt so a rival can afford a planned hall or
 * interconnect. No-ops when cash already covers `neededCash`.
 */
export function fundRivalForCampus(
  state: SimState,
  labId: LabId,
  neededCash: number,
): SimState {
  if (labId === state.playerLabId) return state
  const target = Math.max(0, neededCash)
  if (target <= 0) return state
  let next = alignIndexedLabFromRival(state, labId)
  let lab = getLab(next, labId)
  if (lab.cash >= target) return next

  const capital = lab.capital ?? defaultCapital()
  const lastRoundDay = Math.max(
    Number.NEGATIVE_INFINITY,
    ...capital.fundingRounds.map((round) => round.day),
  )
  const daysSinceRound = Number.isFinite(lastRoundDay)
    ? next.day - lastRoundDay
    : 999
  const founderOwn = capital.capTable
    .filter((stake) => stake.kind === 'founder')
    .reduce((sum, stake) => sum + stake.ownership, 0)
  const confidence = capital.investorConfidence

  if (daysSinceRound >= RIVAL_CAMPUS_EQUITY_COOLDOWN_DAYS && confidence >= 0.32) {
    const gap = target - lab.cash
    const offer = requestEquityOffers(next, labId)
      .filter((candidate) => candidate.confidenceRequired <= confidence)
      .filter((candidate) => {
        const investorOwn =
          candidate.cashRaised /
          (candidate.preMoneyValuation + candidate.cashRaised)
        const nextFounder =
          founderOwn * (1 - investorOwn) * (1 - candidate.optionPoolTopUp)
        return nextFounder >= RIVAL_CAMPUS_MIN_FOUNDER_OWNERSHIP
      })
      .toSorted((a, b) => {
        const aCovers = a.cashRaised >= gap
        const bCovers = b.cashRaised >= gap
        if (aCovers !== bCovers) return aCovers ? -1 : 1
        if (aCovers && bCovers) return a.cashRaised - b.cashRaised
        return b.cashRaised - a.cashRaised
      })[0]
    if (offer) {
      next = acceptEquityOffer(next, offer, labId)
      lab = getLab(next, labId)
    }
  }

  if (lab.cash >= target) return next

  const remaining = target - lab.cash
  const projectCap = labDebtCapacity(next, labId, 'project_finance').max
  if (remaining > 0 && projectCap >= 100_000) {
    next = applyForLabDebt(
      next,
      labId,
      'project_finance',
      Math.min(remaining * 1.06, projectCap),
    )
    lab = getLab(next, labId)
  }
  if (lab.cash >= target) return next

  const stillShort = target - lab.cash
  if (stillShort > 0) {
    next = applyForLabDebt(
      next,
      labId,
      lab.finance.dayRevenue > 0 ? 'revolver' : 'venture_debt',
      stillShort * 1.08,
    )
  }
  return next
}

/** Lab-neutral typed debt service used by rival planners and scenario tools. */
export function applyForLabDebt(
  state: SimState,
  labId: LabId,
  kind: DebtInstrumentKind,
  requestedAmount: number,
): SimState {
  const lab = getLab(state, labId)
  const capital = lab.capital ?? defaultCapital()
  const capacity = labDebtCapacity(state, labId, kind)
  const amount = Math.max(0, Math.min(requestedAmount, capacity.max))
  if (amount < 100_000) return state
  const terms = debtTerms(kind)
  const totalInterest = amount * terms.apr * (terms.termDays / DAY_COUNT)
  const debt: DebtInstrument = {
    id: `debt-${kind}-${labId}-${state.day}-${capital.debt.length}`,
    kind,
    label: terms.label,
    principal: amount,
    remaining: amount + totalInterest,
    apr: terms.apr,
    termDays: terms.termDays,
    daysLeft: terms.termDays,
    dailyPayment: (amount + totalInterest) / terms.termDays,
    collateralValue: capacity.collateral,
    covenant: capacity.covenant,
    breached: false,
  }
  return updateLab(state, labId, (current) => {
    const cash = current.cash + amount
    return {
      ...current,
      cash,
      capital: { ...(current.capital ?? capital), debt: [...capital.debt, debt] },
      finance: {
        ...current.finance,
        cash,
        debtOutstanding: current.finance.debtOutstanding + debt.remaining,
      },
    }
  })
}

function settleRivalCapital(state: SimState): SimState {
  let next = state
  for (const rival of state.rivals) {
    const before = getLab(next, rival.id)
    const capital = before.capital ?? defaultCapital()
    let financialComeback = normalizeRivalFinancialComeback(
      next.rivals.find((candidate) => candidate.id === rival.id) ?? rival,
    )
    const runwayThreshold = rivalDistressRunwayThreshold(state.seed, rival.id)
    let cash = before.cash
    let paid = 0
    let breach = false
    const debts: DebtInstrument[] = []
    for (const debt of capital.debt) {
      const due = Math.min(debt.remaining, debt.dailyPayment)
      const payment = Math.min(Math.max(0, cash), due)
      cash -= payment
      paid += payment
      const remaining = debt.remaining - payment
      const daysLeft = Math.max(0, debt.daysLeft - 1)
      const covenantBreached =
        payment + 0.01 < due ||
        (debt.kind === 'venture_debt' &&
          before.finance.runwayDays < runwayThreshold)
      breach ||= covenantBreached
      if (remaining > 0.01) {
        debts.push({ ...debt, remaining, daysLeft, breached: covenantBreached })
      }
    }
    const distressed =
      breach || before.finance.runwayDays < runwayThreshold || cash < 0
    let restructuring = capital.restructuring
    if (!distressed && restructuring.stage !== 'bankruptcy') {
      restructuring = { active: false, daysLeft: 0, stage: 'none' }
    } else if (distressed && !restructuring.active) {
      financialComeback = {
        ...financialComeback,
        distressEpisode: financialComeback.distressEpisode + 1,
      }
      restructuring = {
        active: true,
        daysLeft: rivalRestructuringStageDays(
          state.seed,
          rival.id,
          'warning',
          financialComeback.distressEpisode,
        ),
        stage: 'warning',
      }
    } else if (distressed && restructuring.daysLeft > 1) {
      restructuring = { ...restructuring, daysLeft: restructuring.daysLeft - 1 }
    } else if (distressed) {
      const stages: Record<
        CapitalStack['restructuring']['stage'],
        CapitalStack['restructuring']
      > = {
        none: {
          active: true,
          daysLeft: rivalRestructuringStageDays(
            state.seed,
            rival.id,
            'warning',
            financialComeback.distressEpisode,
          ),
          stage: 'warning',
        },
        warning: {
          active: true,
          daysLeft: rivalRestructuringStageDays(
            state.seed,
            rival.id,
            'refinance',
            financialComeback.distressEpisode,
          ),
          stage: 'refinance',
        },
        refinance: {
          active: true,
          daysLeft: rivalRestructuringStageDays(
            state.seed,
            rival.id,
            'asset_sale',
            financialComeback.distressEpisode,
          ),
          stage: 'asset_sale',
        },
        asset_sale: { active: true, daysLeft: 0, stage: 'bankruptcy' },
        bankruptcy: { active: true, daysLeft: 0, stage: 'bankruptcy' },
      }
      restructuring = stages[restructuring.stage]
    }
    const nextCapital: CapitalStack = {
      ...capital,
      debt: debts,
      boardPressure: clamp(capital.boardPressure + (breach ? 0.025 : -0.001), 0, 1),
      investorConfidence: clamp(
        capital.investorConfidence + (breach ? -0.02 : 0.0005),
        0,
        1,
      ),
      restructuring,
    }
    next = updateLab(next, rival.id, (lab) => ({
      ...lab,
      cash,
      capital: nextCapital,
      finance: {
        ...lab.finance,
        cash,
        dayLoanPayment: lab.finance.dayLoanPayment + paid,
        dayTotalOut: lab.finance.dayTotalOut + paid,
        dayNet: lab.finance.dayNet - paid,
        lifetimeNet: lab.finance.lifetimeNet - paid,
        debtOutstanding:
          debts.reduce((sum, debt) => sum + debt.remaining, 0) +
          lab.loans.reduce((sum, loan) => sum + loan.remaining, 0),
      },
    }))
    next = {
      ...next,
      rivals: next.rivals.map((candidate) =>
        candidate.id === rival.id
          ? { ...candidate, financialComeback }
          : candidate,
      ),
    }
    if (restructuring.stage !== capital.restructuring.stage) {
      next = {
        ...next,
        news: [
          `Day ${next.day}: ${before.name} enters ${restructuring.stage.replace('_', ' ')} recovery.`,
          ...next.news,
        ].slice(0, 64),
      }
    }
    next = maybeStartRivalFinancialComeback(next, rival.id)
  }
  return next
}

export function applyForDebt(
  state: SimState,
  kind: DebtInstrumentKind,
  requestedAmount: number,
): SimState {
  const capital = capitalFor(state)
  const capacity = debtCapacity(state, kind)
  const sameKindOutstanding = capital.debt
    .filter((debt) => debt.kind === kind)
    .reduce((sum, debt) => sum + debt.remaining, 0)
  const available = Math.max(0, capacity.max - sameKindOutstanding)
  const amount = Math.max(0, Math.min(requestedAmount, available))
  if (amount < 100_000) {
    return pushAlert(state, 'warn', `${debtTerms(kind).label} is not available at the current collateral and revenue level.`)
  }
  const baseTerms = debtTerms(kind)
  const terms = { ...baseTerms, apr: adjustedDebtApr(state, kind) }
  const totalInterest = amount * terms.apr * (terms.termDays / DAY_COUNT)
  const debt: DebtInstrument = {
    id: `debt-${kind}-${state.day}-${capital.debt.length}`,
    kind,
    label: terms.label,
    principal: amount,
    remaining: amount + totalInterest,
    apr: terms.apr,
    termDays: terms.termDays,
    daysLeft: terms.termDays,
    dailyPayment: (amount + totalInterest) / terms.termDays,
    collateralValue: capacity.collateral,
    covenant: capacity.covenant,
    breached: false,
  }
  const cash = state.player.cash + amount
  const next: SimState = {
    ...state,
    player: {
      ...state.player,
      cash,
      finance: {
        ...state.player.finance,
        cash,
        debtOutstanding: state.player.finance.debtOutstanding + debt.remaining,
      },
      capital: { ...capital, debt: [...capital.debt, debt] },
    },
  }
  return pushAlert(next, 'info', `${terms.label} funded $${(amount / 1_000_000).toFixed(1)}M. Financing is excluded from revenue.`)
}

export function repayDebt(state: SimState, debtId: string, amount = Number.POSITIVE_INFINITY): SimState {
  const capital = capitalFor(state)
  const debt = capital.debt.find((item) => item.id === debtId)
  if (!debt) return state
  const payment = Math.min(debt.remaining, state.player.cash, Math.max(0, amount))
  if (payment <= 0) return state
  const remaining = debt.remaining - payment
  const debts = capital.debt
    .map((item) => (item.id === debtId ? { ...item, remaining } : item))
    .filter((item) => item.remaining > 0.01)
  const cash = state.player.cash - payment
  return pushAlert(
    {
      ...state,
      player: {
        ...state.player,
        cash,
        finance: {
          ...state.player.finance,
          cash,
          debtOutstanding: debts.reduce((sum, item) => sum + item.remaining, 0) +
            (state.player.loans ?? []).reduce((sum, item) => sum + item.remaining, 0),
        },
        capital: { ...capital, debt: debts },
      },
    },
    'info',
    `${debt.label}: repaid $${(payment / 1_000_000).toFixed(2)}M.`,
  )
}

export function tickCapital(state: SimState): SimState {
  const capital = capitalFor(state)
  let cash = state.player.cash
  let paid = 0
  let breach = false
  const debts: DebtInstrument[] = []
  for (const debt of capital.debt) {
    const due = Math.min(debt.remaining, debt.dailyPayment)
    const payment = Math.min(Math.max(0, cash), due)
    cash -= payment
    paid += payment
    const remaining = debt.remaining - payment
    const daysLeft = Math.max(0, debt.daysLeft - 1)
    const covenantBreached = payment + 0.01 < due ||
      (debt.kind === 'venture_debt' && state.player.finance.runwayDays < 90)
    breach ||= covenantBreached
    if (remaining > 0.01) debts.push({ ...debt, remaining, daysLeft, breached: covenantBreached })
  }
  // Player recovery ladder: negative cash only (runway soft-warns elsewhere).
  const cashNegative = cash < 0
  let restructuring = capital.restructuring
  if (!cashNegative && restructuring.stage !== 'bankruptcy') {
    restructuring = { active: false, daysLeft: 0, stage: 'none' }
  } else if (cashNegative && !restructuring.active) {
    restructuring = { active: true, daysLeft: 60, stage: 'warning' }
  } else if (cashNegative && restructuring.active && restructuring.daysLeft > 1) {
    restructuring = { ...restructuring, daysLeft: restructuring.daysLeft - 1 }
  } else if (cashNegative && restructuring.active) {
    const nextStage: Record<CapitalStack['restructuring']['stage'], CapitalStack['restructuring']> = {
      none: { active: true, daysLeft: 60, stage: 'warning' },
      warning: { active: true, daysLeft: 45, stage: 'refinance' },
      refinance: { active: true, daysLeft: 30, stage: 'asset_sale' },
      asset_sale: { active: true, daysLeft: 0, stage: 'bankruptcy' },
      bankruptcy: { active: true, daysLeft: 0, stage: 'bankruptcy' },
    }
    restructuring = nextStage[restructuring.stage]
  }
  const nextCapital: CapitalStack = {
    ...capital,
    debt: debts,
    boardPressure: clamp(capital.boardPressure + (breach ? 0.025 : -0.001), 0, 1),
    investorConfidence: clamp(capital.investorConfidence + (breach ? -0.02 : 0.0005), 0, 1),
    restructuring,
  }
  const debtOutstanding = debts.reduce((sum, debt) => sum + debt.remaining, 0) +
    (state.player.loans ?? []).reduce((sum, loan) => sum + loan.remaining, 0)
  const next: SimState = {
    ...state,
    player: {
      ...state.player,
      cash,
      capital: nextCapital,
      finance: {
        ...state.player.finance,
        cash,
        dayLoanPayment: state.player.finance.dayLoanPayment + paid,
        dayTotalOut: state.player.finance.dayTotalOut + paid,
        dayNet: state.player.finance.dayNet - paid,
        lifetimeNet: state.player.finance.lifetimeNet - paid,
        debtOutstanding,
      },
    },
  }
  if (restructuring.stage !== capital.restructuring.stage) {
    const messages: Record<CapitalStack['restructuring']['stage'], string> = {
      none: 'Recovery complete: cash is non-negative again.',
      warning: 'Cash negative: cut commitments, refinance, or raise equity within 60 days.',
      refinance: 'Refinancing stage: lenders and investors now demand corrective terms.',
      asset_sale: 'Forced-recovery stage: sell assets, accept a down round, or restructure within 30 days.',
      bankruptcy: 'Restructuring failed; the lab has entered bankruptcy review.',
    }
    const severity = restructuring.stage === 'none' ? 'info' : restructuring.stage === 'warning' ? 'warn' : 'danger'
    return settleRivalCapital(pushAlert(next, severity, messages[restructuring.stage]))
  }
  return settleRivalCapital(
    breach
      ? pushAlert(
          next,
          'danger',
          cashNegative
            ? 'A debt covenant was breached. The recovery window is active.'
            : 'A debt covenant was breached.',
        )
      : next,
  )
}
