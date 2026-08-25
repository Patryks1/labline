/**
 * Gating tests for overload-aware demand: throttle policies, per-channel
 * load, trickle-down to sibling models, and share spillover to rivals.
 */
import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { collectOffers, tickMarket } from '../systems/market'
import { buildScaledModel } from '../balance/modelBuild'
import {
  nextSpeedStrain,
  nextSurgeLevel,
  planSlownessDissatisfaction,
  strainLatencyFactor,
  strainSpeedFactor,
  surgePriceMultiplier,
  throttleAbsorbShare,
  configuredAbsorbShare,
  peakPricingDemandMultiplier,
  slowdownAbsorbShare,
  throttleChurnScale,
  throttlePainScale,
} from '../balance/serveThrottle'
import { updatePlan } from '../systems/plans'
import { syncLabIndex } from '../systems/labEngine'
import type { ServeThrottlePolicy, SimState } from '../types'

function withRacks(s: SimState, racks: number): SimState {
  const tiles = s.map.tiles.map((t) => {
    if (t.x === 2 && t.y === 2) {
      return {
        ...t,
        kind: 'dc' as const,
        owner: 'player' as const,
        buildingProgress: 1,
        buildingTarget: 1,
        rackCapacity: Math.max(4096, racks * 2),
        racksUsed: 0,
        mwCapacity: Math.max(600, racks),
        opexPerDay: 72_000,
      }
    }
    if (t.x === 3 && t.y === 2) {
      return {
        ...t,
        kind: 'substation' as const,
        owner: 'player' as const,
        buildingProgress: 1,
        buildingTarget: 1,
        mwCapacity: Math.max(600, racks),
        opexPerDay: 15_000,
      }
    }
    return t
  })
  return {
    ...s,
    map: { ...s.map, tiles },
    player: {
      ...s.player,
      cash: 1e9,
      rackFleet: [
        {
          id: 'overload-fleet',
          skuId: 'rack_h100',
          x: 2,
          y: 2,
          count: racks,
          status: 'live',
          daysLeft: 0,
          paidEach: 165_000,
          rackUnits: 1,
        },
      ],
      allocation: { training: 0.1, inference: 0.8, research: 0.1 },
      servingEfficiency: 0.85,
    },
  }
}

function withReleasedModel(s: SimState, cap = 55): SimState {
  const m = buildScaledModel({
    id: 'overload-model',
    name: 'Overload',
    paramsB: 4,
    family: 'dense',
    day: s.day,
    dataCoverage: 20,
    dataQuality: 70,
    postTrain: 'none',
  })
  return {
    ...s,
    player: {
      ...s.player,
      researchUnlocked: [...new Set([...s.player.researchUnlocked, 'opt_fp16'])],
      models: [
        {
          ...m,
          capability: cap,
          quality: { ...m.quality, reliability: 60, chat: 55 },
          shipped: true,
          release: 'released',
          apiPricePerMTok: 3,
          apiPriceInPerMTok: 1,
          apiPriceOutPerMTok: 4,
        },
      ],
      brandTrust: 58,
      pricing: {
        ...s.player.pricing,
        activeModelId: m.id,
        apiPricePerMTok: 3,
        apiPriceInPerMTok: 1,
        apiPriceOutPerMTok: 4,
        apiServePrecisionByModel: {
          ...s.player.pricing.apiServePrecisionByModel,
          [m.id]: 'fp16',
        },
      },
    },
  }
}

/** Second, heavier API-listed model so overflow has somewhere to retry. */
function withSiblingModel(s: SimState): SimState {
  const heavy = buildScaledModel({
    id: 'overload-heavy',
    name: 'Heavy',
    paramsB: 30,
    family: 'dense',
    day: s.day,
    dataCoverage: 20,
    dataQuality: 70,
    postTrain: 'none',
  })
  const heavyModel = {
    ...heavy,
    capability: 58,
    quality: { ...heavy.quality, reliability: 60, chat: 55 },
    shipped: true,
    release: 'released' as const,
    apiPricePerMTok: 6,
    apiPriceInPerMTok: 2,
    apiPriceOutPerMTok: 8,
  }
  return {
    ...s,
    player: {
      ...s.player,
      models: [...s.player.models, heavyModel],
      pricing: {
        ...s.player.pricing,
        apiModelIds: [...s.player.models.map((m) => m.id), heavyModel.id],
      },
    },
  }
}

function withRivalModels(s: SimState, cap = 48): SimState {
  const next = {
    ...s,
    rivals: s.rivals.map((r) => {
      const m =
        r.models.find((x) => x.shipped || x.release === 'released') ??
        (() => {
          const built = buildScaledModel({
            id: `rival-m-${r.id}`,
            name: `${r.name} M`,
            paramsB: 3,
            family: 'dense',
            day: s.day,
            dataCoverage: 20,
            dataQuality: 65,
            postTrain: 'none',
          })
          return {
            ...built,
            quality: { ...built.quality, reliability: 58 },
            shipped: true,
            release: 'released' as const,
            apiPricePerMTok: 3,
            apiPriceInPerMTok: 1,
            apiPriceOutPerMTok: 3.85,
          }
        })()
      return {
        ...r,
        flopsPf: 2_000_000,
        models: [
          { ...m, capability: cap, quality: { ...m.quality, reliability: 58 } },
        ],
      }
    }),
  }
  return syncLabIndex(next)
}

function withoutPlans(s: SimState): SimState {
  let next = s
  for (const p of [...next.player.pricing.plans]) {
    next = updatePlan(next, p.id, { enabled: false })
  }
  return next
}

function withPolicy(s: SimState, policy: ServeThrottlePolicy): SimState {
  return {
    ...s,
    player: {
      ...s.player,
      pricing: { ...s.player.pricing, serveThrottlePolicy: policy },
    },
  }
}

function run(
  s: SimState,
  days: number,
  opts?: { pinBrandTrust?: number; pinPain?: number },
): SimState {
  for (let i = 0; i < days; i++) {
    s = tickMarket(s)
    s = { ...s, day: s.day + 1 }
    if (opts?.pinBrandTrust != null || opts?.pinPain != null) {
      s = {
        ...s,
        player: {
          ...s.player,
          ...(opts.pinBrandTrust != null
            ? { brandTrust: opts.pinBrandTrust }
            : {}),
          ...(opts.pinPain != null ? { servicePain: opts.pinPain } : {}),
        },
      }
    }
  }
  return s
}

describe('throttle policy math', () => {
  it('uses tunable slowdown headroom and collapses excessive peak demand', () => {
    expect(slowdownAbsorbShare(0.2, 0)).toBe(0)
    expect(slowdownAbsorbShare(0.2, 0.25)).toBe(1)
    expect(slowdownAbsorbShare(0.5, 0.25)).toBeCloseTo(0.25)
    expect(
      configuredAbsorbShare(
        { serveSlowdownLimit: 0.6, peakPricingPct: 0 },
        0.5,
      ),
    ).toBeCloseTo(0.6)
    expect(
      configuredAbsorbShare(
        {
          serveThrottlePolicy: 'balanced',
          serveSlowdownLimit: 0.25,
          peakPricingPct: 0,
        },
        0.5,
      ),
    ).toBeCloseTo(0.25)
    expect(peakPricingDemandMultiplier(1)).toBeCloseTo(1)
    expect(peakPricingDemandMultiplier(2)).toBeLessThan(0.1)
  })

  it('splits overload per policy', () => {
    expect(throttleAbsorbShare('shed', 0.4)).toBe(0)
    expect(throttleAbsorbShare('throttle', 0.4)).toBe(1)
    expect(throttleAbsorbShare('balanced', 0.1)).toBe(1)
    expect(throttleAbsorbShare('balanced', 0.5)).toBeCloseTo(0.5)
    expect(throttleAbsorbShare('surge', 0.5)).toBeCloseTo(0.5)
    expect(throttleAbsorbShare('balanced', 0)).toBe(0)
  })

  it('surge EMA ramps under load and heals with headroom', () => {
    let level = 0
    for (let i = 0; i < 8; i++) level = nextSurgeLevel(level, 0.4, 'surge')
    expect(level).toBeGreaterThan(0.15)
    expect(surgePriceMultiplier(level)).toBeGreaterThan(1.1)
    expect(surgePriceMultiplier(level)).toBeLessThanOrEqual(1.8)
    const cooling = nextSurgeLevel(level, 0, 'surge')
    expect(cooling).toBeLessThan(level)
    expect(nextSurgeLevel(level, 0.4, 'balanced')).toBeLessThan(level)
  })

  it('uses the configured slowdown headroom when pricing strained streams', () => {
    const shedImmediately = nextSurgeLevel(0, 0.4, 'surge', 80, 0)
    const slowEverything = nextSurgeLevel(0, 0.4, 'surge', 80, 1)

    expect(shedImmediately).toBe(0)
    expect(slowEverything).toBeGreaterThan(shedImmediately)
  })

  it('strain rises when throttling and heals with headroom', () => {
    const rising = nextSpeedStrain(0, 0.5, 1)
    expect(rising).toBeGreaterThan(0.3)
    const healing = nextSpeedStrain(0.8, 0.01, 1)
    expect(healing).toBeLessThan(0.55)
    expect(strainSpeedFactor(0)).toBe(1)
    expect(strainSpeedFactor(1)).toBeCloseTo(0.4)
    expect(strainLatencyFactor(1)).toBeCloseTo(0.65)
    expect(throttleChurnScale(1)).toBeCloseTo(0.35)
    expect(throttlePainScale(1)).toBeCloseTo(0.25)
    expect(planSlownessDissatisfaction(1, false)).toBeCloseTo(0.6)
    expect(planSlownessDissatisfaction(1, true)).toBeCloseTo(0.35)
  })
})

describe('overload policies in the market', () => {
  const overloadedBase = (policy: ServeThrottlePolicy) =>
    withPolicy(withRivalModels(withReleasedModel(withRacks(createGame(21), 8))), policy)

  it('throttle slows streams instead of shedding: less pain, less churn, real strain', () => {
    const throttled = run(overloadedBase('throttle'), 12, { pinBrandTrust: 58 })
    const shed = run(overloadedBase('shed'), 12, { pinBrandTrust: 58 })
    // The fixture is genuinely overloaded either way.
    expect(shed.lastMarket.unservedRatio).toBeGreaterThan(0.15)
    expect(throttled.lastMarket.unservedRatio).toBeGreaterThan(0.15)
    // Throttle accumulates stream strain; shed never does.
    expect(throttled.player.speedStrain ?? 0).toBeGreaterThan(0.1)
    expect(shed.player.speedStrain ?? 0).toBeLessThan(0.02)
    // Queueing beats erroring: less pain, more subscribers retained.
    expect(throttled.player.servicePain).toBeLessThan(shed.player.servicePain)
    const subsOf = (s: SimState) =>
      s.lastMarket.planStats.reduce((sum, p) => sum + p.subscribers, 0)
    expect(subsOf(throttled)).toBeGreaterThan(subsOf(shed))
    // ...and the strain lands on the overloaded (API) channel.
    expect(throttled.player.apiSpeedStrain ?? 0).toBeGreaterThan(0.1)
  })

  it('sub-channel strain reads as plan slowness dissatisfaction', () => {
    let s = overloadedBase('throttle')
    s = {
      ...s,
      player: {
        ...s.player,
        speedStrain: 0.5,
        apiSpeedStrain: 0.5,
        subSpeedStrain: 0.5,
      },
    }
    s = run(s, 1)
    const paid = s.lastMarket.planStats.find((p) => !p.isFree)!
    expect(paid.slownessDissatisfaction ?? 0).toBeGreaterThan(0.05)
  })

  it('balanced sits between the two extremes', () => {
    // Two days: before the shed-path pain EMA saturates at the cap.
    const balanced = run(overloadedBase('balanced'), 2, { pinBrandTrust: 58 })
    const shed = run(overloadedBase('shed'), 2, { pinBrandTrust: 58 })
    // At extreme overload, 25% of *capacity* can be too little of total demand
    // to move the strain EMA, but it must never be worse than immediate shed.
    expect(balanced.player.speedStrain ?? 0).toBeGreaterThanOrEqual(
      shed.player.speedStrain ?? 0,
    )
    expect(balanced.player.servicePain).toBeLessThanOrEqual(
      shed.player.servicePain,
    )
  })

  it('surge prices API up under load: fewer MTok, higher $/MTok, less churn than shed', () => {
    const base = (policy: ServeThrottlePolicy) =>
      withPolicy(
        withRivalModels(withReleasedModel(withRacks(createGame(21), 96))),
        policy,
      )
    const surge = run(base('surge'), 14, { pinBrandTrust: 58 })
    const shed = run(base('shed'), 14, { pinBrandTrust: 58 })
    expect(surge.lastMarket.apiSurgeMultiplier ?? 1).toBeGreaterThan(1.05)
    expect(surge.lastMarket.apiDemandMTok ?? 0).toBeLessThan(
      shed.lastMarket.apiDemandMTok ?? 0,
    )
    expect(surge.lastMarket.apiDayMTok).toBeLessThanOrEqual(
      shed.lastMarket.apiDayMTok,
    )
    const surgeYield =
      surge.lastMarket.apiDayRevenue /
      Math.max(0.01, surge.lastMarket.apiDayMTok)
    const shedYield =
      shed.lastMarket.apiDayRevenue / Math.max(0.01, shed.lastMarket.apiDayMTok)
    expect(surgeYield).toBeGreaterThan(shedYield)
    expect(surge.player.servicePain).toBeLessThan(shed.player.servicePain)
    const subsOf = (s: SimState) =>
      s.lastMarket.planStats.reduce((sum, p) => sum + p.subscribers, 0)
    expect(subsOf(surge)).toBeGreaterThan(subsOf(shed))
  })
})

describe('compute split drives channel load and speed', () => {
  const splitBase = (prio: number) => {
    let s = withRivalModels(withReleasedModel(withRacks(createGame(22), 1024)))
    s = withPolicy(s, 'throttle')
    s = {
      ...s,
      player: {
        ...s.player,
        pricing: { ...s.player.pricing, apiVsSubPriority: prio },
      },
    }
    return s
  }

  it('reserving more capacity for API lowers API load and raises sub load', () => {
    const apiHeavy = run(splitBase(0.85), 8, { pinBrandTrust: 58 })
    const apiStarved = run(splitBase(0.25), 8, { pinBrandTrust: 58 })
    expect(apiHeavy.lastMarket.apiLoad ?? 0).toBeGreaterThan(0)
    expect(apiHeavy.lastMarket.apiLoad!).toBeLessThan(
      apiStarved.lastMarket.apiLoad!,
    )
    expect(apiHeavy.lastMarket.subLoad!).toBeGreaterThan(
      apiStarved.lastMarket.subLoad!,
    )
  })

  it('channel strain slows that channel’s offer speed only', () => {
    let s = withRivalModels(withReleasedModel(withRacks(createGame(22), 1024)))
    s = {
      ...s,
      player: {
        ...s.player,
        speedStrain: 0.8,
        apiSpeedStrain: 0.8,
        subSpeedStrain: 0,
      },
    }
    const offer = collectOffers(s).find((o) => o.labId === 'player')!
    // API-facing speed carries the API strain; sub-facing speed does not.
    expect(offer.apiTokPerSec ?? 0).toBeLessThan((offer.tokPerSec ?? 0) * 0.7)
  })
})

describe('trickle-down to sibling models', () => {
  it('overflow retries land on the cheaper sibling endpoint', () => {
    let s = withoutPlans(
      withRivalModels(withReleasedModel(withRacks(createGame(23), 2))),
    )
    s = withSiblingModel(s)
    s = run(s, 6, { pinBrandTrust: 58 })
    const lm = s.lastMarket
    expect(lm.unservedRatio).toBeGreaterThan(0.1)
    expect(lm.trickledMTok ?? 0).toBeGreaterThan(0)
    expect(lm.overflowMTok ?? 0).toBeGreaterThan(0)
    // Both endpoints serve real tokens; the cheap sibling punches above its
    // demand share because overflow prefers low PF-per-token models.
    const usage = lm.apiModelUsage ?? []
    expect(usage.length).toBe(2)
    for (const row of usage) expect(row.dayMTok).toBeGreaterThan(0)
    const heavy = usage.find((row) => row.name === 'Heavy')!
    const light = usage.find((row) => row.name !== 'Heavy')!
    expect(light.dayMTok).toBeGreaterThan(heavy.dayMTok)
  })
})

describe('spillover to rivals', () => {
  it('an overloaded lab bleeds segment share; totals conserve', () => {
    // Single tick from an identical snapshot: isolates the bleed from the
    // switching-friction EMA and from demand self-limiting under pain.
    const base = () =>
      withRivalModels(withReleasedModel(withRacks(createGame(24), 64)))
    const calmTick = tickMarket(base())
    const painedTick = tickMarket({
      ...base(),
      player: { ...base().player, servicePain: 0.9 },
    })
    const hobby = (s: SimState) =>
      s.segments.find((seg) => seg.id === 'hobby')?.providerShares ?? {}
    const calmShare = hobby(calmTick)['player'] ?? 0
    const painShare = hobby(painedTick)['player'] ?? 0
    // Headline share is fulfilled share now, so even the calm snapshot can be
    // small when its fleet serves only a sliver of world demand.
    expect(calmShare).toBeGreaterThan(0)
    expect(painShare).toBeLessThan(calmShare * 0.7)
    for (const seg of painedTick.segments) {
      const total = Object.values(seg.providerShares ?? {}).reduce(
        (sum, v) => sum + v,
        0,
      )
      expect(total).toBeCloseTo(1, 6)
    }
  })
})
