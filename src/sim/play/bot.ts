import { isDcKind, isDcAnchor, placeBuilding, upgradeBuilding } from '../systems/map'
/**
 * Automated play bot — drives pure sim actions for e2e / balance tests.
 * Deterministic given seed + policy.
 */
import { createGame } from '../createGame'
import { tickDay } from '../tick'
import { orderRacksIntoDc } from '../systems/dcRacks'
import {
  startTraining,
  advancePostTrain,
  releaseFromJob,
  keepInternal,
} from '../systems/training'
import { enqueueResearch, availableResearch } from '../systems/research'
import { setModelApiInOut } from '../systems/training'
import { computeSnapshot } from '../systems/compute'
import type { BuildableKind, MapTile, SimState } from '../types'
import type { DifficultyId } from '../balance/gameConfig'
import { tickSharedMarkets } from '../systems/sharedMarkets'
import {
  acceptFirmLoanOffer,
  queueDataOfferOrder,
  submitLoanApplication,
} from '../systems/sharedMarkets'
import { totalProcessed } from '../systems/data'
import {
  acceptEquityOffer,
  requestEquityOffers,
} from '../systems/capital'
import {
  quoteComputeContract,
  signComputeContract,
} from '../systems/computeContracts'
import {
  facilityAnchorTiles,
  mapTileAtAny,
  usesCompactWorld,
} from '../systems/worldAccess'
import { tileCoords } from '../world/ids'

export interface Milestone {
  day: number
  id: string
  detail: string
}

export interface PlayReport {
  final: SimState
  milestones: Milestone[]
  daysRun: number
  bankrupt: boolean
  hadRevenue: boolean
  releasedModel: boolean
  builtDc: boolean
  builtPower: boolean
  boughtChips: boolean
  peakCash: number
  minCash: number
}

function regionOk(id: string, preferRegion?: string): boolean {
  return (
    !preferRegion ||
    id === preferRegion ||
    // Legacy region names OR procedural city_* ids
    (preferRegion === 'west' && (id === 'west' || id.startsWith('city_'))) ||
    (preferRegion === 'heartland' && (id === 'heartland' || id.startsWith('city_'))) ||
    (preferRegion === 'north' && (id === 'north' || id.startsWith('city_')) )
  )
}

function isBuildableEmpty(tile: MapTile | undefined, preferRegion?: string): tile is MapTile {
  return (
    !!tile &&
    tile.kind === 'empty' &&
    (tile.owner === 'neutral' || tile.owner === 'player') &&
    tile.regionId !== 'void' &&
    regionOk(tile.regionId, preferRegion)
  )
}

function findEmpty(
  state: SimState,
  preferRegion?: string,
): { x: number; y: number } | null {
  if (usesCompactWorld(state) && state.map.world) {
    const world = state.map.world
    const pads = world.staticWorld.starterPads
      .map((id) => {
        const { x, y } = tileCoords(id, world.descriptor.width)
        return mapTileAtAny(state, x, y)
      })
      .filter((tile): tile is MapTile => isBuildableEmpty(tile, preferRegion))
    const namedPad = pads.find((tile) => tile.name && tile.name.includes('Build-ready'))
    if (namedPad) return { x: namedPad.x, y: namedPad.y }
    if (pads[0]) return { x: pads[0].x, y: pads[0].y }

    // Scan around cities for empty land without materializing the full map.
    for (const city of state.map.cities ?? []) {
      for (let radius = city.radius + 1; radius <= city.radius + 24; radius++) {
        for (let offset = -radius; offset <= radius; offset++) {
          const candidates = [
            [city.cx + offset, city.cy - radius],
            [city.cx + offset, city.cy + radius],
            [city.cx - radius, city.cy + offset],
            [city.cx + radius, city.cy + offset],
          ] as const
          for (const [x, y] of candidates) {
            const tile = mapTileAtAny(state, x, y)
            if (isBuildableEmpty(tile, preferRegion)) return { x, y }
          }
        }
      }
    }
    return null
  }

  const tiles = state.map.tiles.filter((t) => isBuildableEmpty(t, preferRegion))
  // Prefer named pads / cheaper land
  const named = tiles.find((t) => t.name && t.name.includes('Build-ready'))
  if (named) return { x: named.x, y: named.y }
  const cheapest = [...tiles].sort((a, b) => (a.landValue ?? 0) - (b.landValue ?? 0))[0]
  return cheapest ? { x: cheapest.x, y: cheapest.y } : null
}

function playerFacilities(state: SimState): MapTile[] {
  return facilityAnchorTiles(state, { ownerId: 'player' })
}

function countKind(state: SimState, kind: BuildableKind): number {
  return playerFacilities(state).filter(
    (t) => t.kind === kind && t.buildingProgress >= t.buildingTarget,
  ).length
}

function buildingInProgress(state: SimState, kind: BuildableKind): boolean {
  return playerFacilities(state).some(
    (t) =>
      t.kind === kind &&
      t.buildingTarget > 0 &&
      t.buildingProgress < t.buildingTarget,
  )
}

function liveRackCount(state: SimState): number {
  return (state.player.rackFleet ?? [])
    .filter((r) => r.status === 'live')
    .reduce((s, r) => s + r.count, 0)
}

function orderedRackCount(state: SimState): number {
  return (state.player.rackFleet ?? [])
    .filter((r) => r.status === 'ordered')
    .reduce((s, r) => s + r.count, 0)
}

function firstLiveDc(state: SimState): { x: number; y: number } | null {
  const t = playerFacilities(state).find(
    (tile) =>
      isDcKind(tile.kind) &&
      isDcAnchor(tile) &&
      tile.buildingProgress >= tile.buildingTarget,
  )
  return t ? { x: t.x, y: t.y } : null
}

/** Order racks into first live hall (bot path). */
function tryOrderRacks(state: SimState, count: number): SimState {
  const dc = firstLiveDc(state)
  if (!dc || count <= 0) return state
  return orderRacksIntoDc(state, dc.x, dc.y, 'rack_h100', count)
}

function tryPlace(state: SimState, kind: BuildableKind, region = 'west'): SimState {
  if (buildingInProgress(state, kind)) return state
  const spot = findEmpty(state, region) ?? findEmpty(state)
  if (!spot) return state
  return placeBuilding(state, spot.x, spot.y, kind)
}

/**
 * One "think" step before the day advances — places builds, buys, trains.
 */
export function botAct(state: SimState): SimState {
  let s = state
  if (s.victory.outcome !== 'playing') return s

  const dcs = countKind(s, 'dc')
  const power =
    countKind(s, 'substation') + countKind(s, 'solar') + countKind(s, 'gas') + countKind(s, 'battery')
  const racks = liveRackCount(s)
  const arriving = orderedRackCount(s)
  const hasPublic = s.player.models.some((m) => m.release === 'released' || m.shipped)
  const snap = computeSnapshot(s)
  const processedData = totalProcessed(s.player.data)

  // The balance bot uses the same public provider action as the player. Renew
  // cloud capacity after a finite term instead of silently receiving PF or
  // becoming permanently unable to serve an otherwise viable small model.
  const activeInboundPf = s.computeContracts.reduce(
    (sum, contract) =>
      sum +
      (contract.buyerLabId === s.playerLabId &&
      (contract.status === 'active' || contract.status === 'interrupted')
        ? contract.pf
        : 0),
    0,
  )
  const observedDemandPf = Math.max(0, s.lastMarket.demandPf ?? 0)
  const desiredCloudPf = Math.min(
    192,
    Math.max(24, observedDemandPf / Math.max(0.2, s.player.utilCap) * 1.25),
  )
  if (activeInboundPf + 1 < desiredCloudPf && s.player.cash > 2_000_000) {
    const requestedPf = Math.max(1, Math.min(48, Math.ceil(desiredCloudPf - activeInboundPf)))
    const provider = s.worldMarkets.cloudProviders
      .filter((candidate) => candidate.availablePf >= requestedPf)
      .toSorted((a, b) => a.basePricePerPfDay - b.basePricePerPfDay)[0]
    if (provider) {
      const quote = quoteComputeContract(s, {
        providerId: provider.id,
        buyerLabId: s.playerLabId,
        kind: 'on_demand',
        pf: requestedPf,
        termDays: 180,
      })
      if (quote.canSign) s = signComputeContract(s, quote)
    }
  }

  const lastRoundDay = Math.max(
    -Infinity,
    ...(s.player.capital?.fundingRounds ?? []).map((round) => round.day),
  )
  if (
    s.day >= 30 &&
    s.player.cash < 15_000_000 &&
    s.day - lastRoundDay >= 120
  ) {
    const confidence = s.player.capital?.investorConfidence ?? 0
    const offer = requestEquityOffers(s)
      .filter((candidate) => candidate.confidenceRequired <= confidence)
      .toSorted(
        (a, b) =>
          b.cashRaised - a.cashRaised ||
          a.investorOwnership - b.investorOwnership,
      )[0]
    if (offer) s = acceptEquityOffer(s, offer)
  }

  const firmLoan = s.worldMarkets.loanOffers.find(
    (offer) => offer.labId === s.playerLabId && offer.expiresDay >= s.day,
  )
  if (firmLoan && s.player.cash < 3_000_000 && (s.player.loans ?? []).length === 0) {
    s = acceptFirmLoanOffer(s, firmLoan.id)
  }
  const loanPending = s.worldMarkets.loanApplications.some(
    (application) =>
      application.labId === s.playerLabId && application.status === 'pending',
  )
  if (
    s.player.cash < 3_000_000 &&
    !firmLoan &&
    !loanPending &&
    (s.player.loans ?? []).length === 0
  ) {
    s = submitLoanApplication(s, s.playerLabId, 35_000_000, 90)
  }

  // Compete for real processed corpus before training. One finite lot per day
  // keeps the bot competent without grants or privileged data generation.
  const latestPublic = s.player.models
    .filter((model) => model.release === 'released' || model.shipped)
    .toSorted((a, b) => b.releaseDay - a.releaseDay)[0]
  const corpusTarget = hasPublic
    ? Math.max(6_500, (latestPublic?.paramsB ?? 1) * 1_800)
    : 1_200
  if (
    processedData < corpusTarget &&
    s.player.cash > (hasPublic ? 25_000_000 : 8_000_000) &&
    !s.worldMarkets.orders.some(
      (order) => order.labId === s.playerLabId && order.kind === 'data',
    )
  ) {
    const offer = [...s.dataMarket.offers]
      .filter((entry) => entry.mTokLeft > 0 && entry.cash <= Math.min(6_000_000, s.player.cash * 0.04))
      .sort(
        (a, b) =>
          b.quality - a.quality ||
          a.cash / Math.max(1, a.lotMTok) - b.cash / Math.max(1, b.lotMTok),
      )[0]
    if (offer) s = queueDataOfferOrder(s, s.playerLabId, offer.id)
  }

  // 1) Cloud-first. Owned infrastructure is a later utilization decision.
  if (hasPublic && dcs === 0 && !buildingInProgress(s, 'dc') && s.player.cash > 160_000_000) {
    s = tryPlace(s, 'dc', 'west')
  }
  if (dcs >= 1 && power === 0 && !buildingInProgress(s, 'substation') && s.player.cash > 75_000_000) {
    s = tryPlace(s, 'substation', 'west')
  }

  // 2) Order racks into hall once DC online
  const rackTarget = hasPublic ? 96 : 48
  if (firstLiveDc(s) && racks + arriving < rackTarget && s.player.cash > 35_000_000) {
    const need = rackTarget - racks - arriving
    s = tryOrderRacks(s, Math.min(48, Math.max(8, need)))
  }

  // 3) Allocation: train-heavy until model ships, then infer-heavy
  if (!hasPublic && !s.player.trainingJob) {
    s = {
      ...s,
      player: {
        ...s.player,
        allocation: { training: 0.55, inference: 0.2, research: 0.25 },
      },
    }
  } else if (hasPublic) {
    s = {
      ...s,
      player: {
        ...s.player,
        allocation: { training: 0.2, inference: 0.55, research: 0.25 },
      },
    }
  }

  // 4) Train the first sellable checkpoint entirely on rented compute.
  if (
    !s.player.trainingJob &&
    s.player.models.length === 0 &&
    snap.pools.training > 0.05 &&
    s.player.cash > 4_000_000 &&
    processedData >= 400
  ) {
    s = startTraining(s, {
      name: 'Bot-400M',
      family: 'dense',
      paramsB: 0.4,
      mode: 'pretrain',
      dataPlan: {
        totalUnits: Math.min(500, processedData),
        totalMTok: Math.min(500, processedData),
        weights: { code: 0.32, math: 0.12, science: 0.08, chat: 0.38, image: 0.05, audio: 0.05 },
        allowSynthetic: true,
      },
    })
  }

  // 5) Handle milestone pause, then post-train SFT / release.
  if (s.player.trainingJob) {
    const job = s.player.trainingJob
    if (job.awaitingDecision) {
      s = releaseFromJob(s)
    } else if (job.progressPfDays >= job.targetPfDays) {
      if (job.postTrain === 'none') {
        s = advancePostTrain(s)
      } else if (job.postTrainProgress >= job.postTrainTarget) {
        s = releaseFromJob(s)
      }
    }
  }

  // 6) Price + research once live
  if (hasPublic) {
    const m = s.player.models.find((x) => x.release === 'released')
    if (m && (m.apiPriceInPerMTok == null || m.apiPriceOutPerMTok == null)) {
      const pin = m.suggestedApiPriceIn ?? (m.suggestedApiPrice || 2.5) * 0.35
      const pout = m.suggestedApiPriceOut ?? (m.suggestedApiPrice || 2.5) * 1.25
      s = setModelApiInOut(s, m.id, pin, pout)
      s = {
        ...s,
        player: {
          ...s.player,
          pricing: {
            ...s.player.pricing,
            activeModelId: m.id,
            apiPriceInPerMTok: pin,
            apiPriceOutPerMTok: pout,
            apiPricePerMTok: Math.round((pin * 0.3 + pout * 0.7) * 1000) / 1000,
          },
        },
      }
    }
    const avail = availableResearch(s)
    const dataMix = avail.find((n) => n.id === 'data_mix')
    const dataClean = avail.find((n) => n.id === 'data_clean')
    const batch = avail.find((n) => n.id === 'sys_batching')
    const priority = dataMix ?? dataClean ?? batch ?? avail[0]
    if (
      priority &&
      !s.player.activeResearch &&
      !s.player.researchQueue.includes(priority.id)
    ) {
      s = enqueueResearch(s, priority.id)
    } else if (
      avail[0] &&
      !s.player.activeResearch &&
      s.player.researchQueue.length < 2
    ) {
      s = enqueueResearch(s, avail[0].id)
    }
  }

  // 7) Mid-game expansion
  if (hasPublic && s.player.cash > 260_000_000 && dcs < 2 && !buildingInProgress(s, 'dc')) {
    s = tryPlace(s, 'dc', 'heartland')
  }
  if (hasPublic && s.player.cash > 180_000_000 && countKind(s, 'cooling') < 1 && dcs >= 1) {
    s = tryPlace(s, 'cooling', 'west')
  }
  if (hasPublic && s.player.cash > 150_000_000 && countKind(s, 'solar') < 1) {
    s = tryPlace(s, 'solar', 'west')
  }
  if (hasPublic && s.player.cash > 200_000_000 && countKind(s, 'hq') + countKind(s, 'office') < 1) {
    s = tryPlace(s, 'hq', 'west')
  }

  // 8) Upgrade first DC if profitable
  if (hasPublic && s.player.finance.dayNet > 50_000 && s.player.cash > 220_000_000) {
    const dc = s.map.tiles.find(
      (t) =>
        t.owner === 'player' &&
        (isDcKind(t.kind) && isDcAnchor(t)) &&
        t.level < 3 &&
        t.buildingProgress >= t.buildingTarget,
    )
    if (dc) s = upgradeBuilding(s, dc.x, dc.y)
  }

  // 9) Repeat model generations on a bounded cadence. The corpus, not a free
  // calendar multiplier, limits how quickly the bot can scale parameters.
  // Re-read the portfolio after the completion block above. Reusing the
  // pre-action `latestPublic` let the bot finalize a generation and then
  // immediately start an identical reroll against the previous release's
  // 120-day clock. Besides wasting data, taking the better of two hidden
  // outcome rolls gave the calibration bot an unfair early capability edge.
  const currentLatestPublic = s.player.models
    .filter((model) => model.release === 'released' || model.shipped)
    .toSorted((a, b) => b.releaseDay - a.releaseDay)[0]
  const daysSinceRelease = currentLatestPublic
    ? s.day - currentLatestPublic.releaseDay
    : Number.POSITIVE_INFINITY
  if (
    hasPublic &&
    !s.player.trainingJob &&
    daysSinceRelease >= 120 &&
    s.player.cash > 18_000_000 &&
    processedData >= 1_200
  ) {
    const previousParams = currentLatestPublic?.paramsB ?? 0.4
    const dataLimitedParams = Math.max(0.5, processedData / 1_250)
    // This is the balanced cloud policy, not the compute-rich frontier policy.
    // Keep generation-over-generation scale inside the frontier rival's
    // evidence-gated 1.16–1.32 range instead of jumping 45% every cycle.
    const paramsB = Math.min(120, dataLimitedParams, previousParams * 1.3)
    s = startTraining(s, {
      name: `Bot-Balanced-${(s.player.models.length + 1).toString().padStart(2, '0')}`,
      family: 'dense',
      paramsB,
      mode: 'pretrain',
      dataPlan: {
        totalUnits: Math.min(processedData, Math.max(1_000, paramsB * 1_250)),
        totalMTok: Math.min(processedData, Math.max(1_000, paramsB * 1_250)),
        weights: {
          code: 0.25,
          math: 0.12,
          science: 0.12,
          chat: 0.3,
          law: 0.06,
          health: 0.05,
          image: 0.06,
          audio: 0.03,
          video: 0.01,
        },
        allowSynthetic: true,
      },
    })
  }

  return s
}

export function runPlayBot(opts: {
  seed?: number
  maxDays?: number
  difficulty?: DifficultyId
  /** Stop early if released + profitable for N consecutive days */
  profitDaysToStop?: number
}): PlayReport {
  const maxDays = opts.maxDays ?? 120
  let s = createGame({ seed: opts.seed ?? 42, difficulty: opts.difficulty ?? 'normal' })
  s = { ...s, paused: false, speed: 5 }

  const milestones: Milestone[] = []
  const note = (id: string, detail: string) => {
    if (!milestones.some((m) => m.id === id)) {
      milestones.push({ day: s.day, id, detail })
    }
  }

  let peakCash = s.player.cash
  let minCash = s.player.cash
  let profitStreak = 0
  let hadRevenue = false
  let releasedModel = false
  let builtDc = false
  let builtPower = false
  let boughtChips = false

  for (let i = 0; i < maxDays; i++) {
    s = botAct(s)
    s = tickDay(s)

    peakCash = Math.max(peakCash, s.player.cash)
    minCash = Math.min(minCash, s.player.cash)

    if (countKind(s, 'dc') > 0) {
      builtDc = true
      note('dc', 'Data hall online')
    }
    if (
      countKind(s, 'substation') + countKind(s, 'solar') + countKind(s, 'gas') > 0
    ) {
      builtPower = true
      note('power', 'Power source online')
    }
    if (liveRackCount(s) > 0 || orderedRackCount(s) > 0) {
      boughtChips = true
      note('racks', `${liveRackCount(s)} racks live`)
    }
    if (s.player.models.some((m) => m.release === 'released' || m.shipped)) {
      releasedModel = true
      note('release', 'First model released')
    }
    if (s.player.finance.dayRevenue > 1000) {
      hadRevenue = true
      note('revenue', `Day revenue $${s.player.finance.dayRevenue.toFixed(0)}`)
    }
    if (s.player.finance.dayNet > 0) profitStreak++
    else profitStreak = 0

    if (s.victory.outcome === 'lost') {
      note('bankrupt', s.victory.reason)
      break
    }
    if (s.victory.outcome === 'won') {
      note('win', s.victory.reason)
      break
    }
    if (opts.profitDaysToStop && profitStreak >= opts.profitDaysToStop && releasedModel) {
      note('profit_streak', `${profitStreak} profitable days`)
      break
    }
  }

  return {
    final: s,
    milestones,
    daysRun: s.day,
    bankrupt: s.victory.outcome === 'lost',
    hadRevenue,
    releasedModel,
    builtDc,
    builtPower,
    boughtChips,
    peakCash,
    minCash,
  }
}

/** Force-complete constructions / rack deliveries for short smoke tests. */
export function cheatFastForwardBuild(state: SimState): SimState {
  const cleared = tickSharedMarkets(state)
  let next: SimState = cleared
  if (usesCompactWorld(cleared) && cleared.map.world) {
    const world = cleared.map.world
    const batch = world.beginBatch()
    let changed = false
    world.forEachFacility({ ownerId: 'player', underConstruction: true }, (facility) => {
      if (facility.constructionTarget <= 0) return
      if (facility.constructionProgress >= facility.constructionTarget) return
      batch.updateFacility(facility.id, {
        constructionProgress: facility.constructionTarget,
      })
      changed = true
    })
    if (changed) {
      const result = batch.commit()
      next = {
        ...cleared,
        map: {
          ...cleared.map,
          worldRevision: result.revision,
        },
      }
    } else {
      batch.rollback()
    }
  } else {
    const tiles = cleared.map.tiles.map((t) =>
      t.owner === 'player' && t.buildingTarget > 0
        ? { ...t, buildingProgress: t.buildingTarget }
        : t,
    )
    next = {
      ...cleared,
      map: { ...cleared.map, tiles },
    }
  }
  const chips = next.player.chips.map((c) => {
    const count = c.count + c.arriving.reduce((s, a) => s + a.count, 0)
    return { ...c, count, arriving: [] }
  })
  // Deliver all ordered racks immediately
  const rackFleet = (next.player.rackFleet ?? []).map((r) =>
    r.status === 'ordered' ? { ...r, status: 'live' as const, daysLeft: 0 } : { ...r },
  )
  // Merge same-sku live groups on same hall
  const merged: typeof rackFleet = []
  for (const r of rackFleet) {
    if (r.status !== 'live') {
      merged.push(r)
      continue
    }
    const hit = merged.find(
      (x) => x.status === 'live' && x.x === r.x && x.y === r.y && x.skuId === r.skuId,
    )
    if (hit) hit.count += r.count
    else merged.push({ ...r })
  }
  return {
    ...next,
    player: { ...next.player, chips, rackFleet: merged },
  }
}

export function runSmokeBootstrap(seed = 7): PlayReport {
  let s = createGame(seed)
  // Scripted minimum cloud path: no owned hall, grid queue, or rack order.
  s = {
    ...s,
    player: {
      ...s.player,
      allocation: { training: 0.6, inference: 0.2, research: 0.2 },
    },
  }
  s = startTraining(s, {
    name: 'Smoke',
    family: 'dense',
    paramsB: 0.4,
    mode: 'pretrain',
    dataPlan: {
      totalUnits: 400,
      totalMTok: 400,
      weights: { chat: 0.45, code: 0.3, math: 0.1, science: 0.1, image: 0.05 },
      allowSynthetic: true,
    },
  })

  const milestones: Milestone[] = []
  let days = 0
  for (let i = 0; i < 80; i++) {
    days++
    // Finish train instantly if stalled on cash burn
    if (s.player.trainingJob) {
      let job = s.player.trainingJob
      if (job.awaitingDecision) {
        s = releaseFromJob(s)
        milestones.push({ day: s.day, id: 'release', detail: 'smoke release' })
        continue
      }
      if (job.progressPfDays < job.targetPfDays) {
        s = {
          ...s,
          player: {
            ...s.player,
            trainingJob: {
              ...job,
              progressPfDays: job.targetPfDays,
              daysElapsed: job.minCalendarDays ?? 0,
              awaitingDecision: false,
            },
            trainingJobs: (s.player.trainingJobs ?? [job]).map((candidate) =>
              candidate.id === job.id
                ? {
                    ...candidate,
                    progressPfDays: candidate.targetPfDays,
                    daysElapsed: candidate.minCalendarDays ?? 0,
                    awaitingDecision: false,
                  }
                : candidate,
            ),
          },
        }
        job = s.player.trainingJob!
      }
      if (job.postTrain === 'none') s = advancePostTrain(s)
      const j2 = s.player.trainingJob
      if (j2 && j2.postTrain !== 'none') {
        s = {
          ...s,
          player: {
            ...s.player,
            trainingJob: {
              ...j2,
              postTrainProgress: j2.postTrainTarget,
              awaitingDecision: false,
            },
          },
        }
        s = releaseFromJob(s)
        milestones.push({ day: s.day, id: 'release', detail: 'smoke release' })
      }
    }
    s = tickDay(s)
    if (s.player.finance.dayRevenue > 0) {
      milestones.push({ day: s.day, id: 'revenue', detail: 'got revenue' })
      break
    }
  }

  return {
    final: s,
    milestones,
    daysRun: days,
    bankrupt: s.victory.outcome === 'lost',
    hadRevenue: s.player.finance.dayRevenue > 0 || s.player.finance.lifetimeRevenue > 0,
    releasedModel: s.player.models.some((m) => m.release === 'released'),
    builtDc: false,
    builtPower: false,
    boughtChips: false,
    peakCash: s.player.finance.peakCash,
    minCash: s.player.finance.lowestCash,
  }
}

// silence unused import if keepInternal unused
void keepInternal
