import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildScaledModel } from '../../../sim/balance/modelBuild'
import { createGame } from '../../../sim/createGame'
import type { PlanDayStats } from '../../../sim/types'
import { servePoolLoad } from '../../../sim/systems/computeBreakdown'
import {
  PeakPricingStrip,
  PoolLoadBar,
  ServeModelLoadBar,
  ServeOutageBanner,
  channelLoadsFromServePool,
} from './ComputeLoadBars'

function withServeMarket(seed: number) {
  const base = createGame(seed)
  const model = {
    ...buildScaledModel({
      id: 'm-serve',
      name: 'ServeTest',
      paramsB: 8,
      family: 'dense',
      day: 1,
      dataCoverage: 30,
      dataQuality: 75,
    }),
    capability: 70,
    release: 'released' as const,
    shipped: true,
    commerciallyOffered: true,
  }
  const state = {
    ...base,
    player: {
      ...base.player,
      models: [model],
      pricing: {
        ...base.player.pricing,
        activeModelId: model.id,
        apiModelIds: [model.id],
        plans: base.player.pricing.plans.map((plan) => ({
          ...plan,
          enabled: plan.id === 'plan-plus',
          modelIds: plan.id === 'plan-plus' ? [model.id] : [],
        })),
      },
    },
    lastMarket: {
      ...base.lastMarket,
      capacityPf: 50,
      servedPf: 40,
      apiPoolPf: 25,
      subPoolPf: 25,
      apiModelUsage: [
        {
          modelId: model.id,
          name: model.name,
          dayMTok: 5,
          dayInferPf: 10,
          share: 1,
          costPerMTok: 0.1,
        },
      ],
      planStats: [
        {
          planId: 'plan-plus',
          name: 'Plus',
          subscribers: 100,
          dayRevenue: 10,
          dayCogs: 4,
          allocatedComputeCostDay: 4,
          dayMTok: 8,
          dayInferPf: 12,
          computePfPerSubscriber: 0.12,
          modelUsage: [
            {
              modelId: model.id,
              name: model.name,
              dayMTok: 8,
              dayInferPf: 12,
              share: 1,
              costPerMTok: 0.1,
            },
          ],
          costPerSubDay: 0.04,
          marginPerSubMonth: 5,
          isFree: false,
          usageRate: 0.6,
        },
      ] satisfies PlanDayStats[],
      unservedRatio: 0.45,
      playerDemandMTok: 20,
      serveOutage: true,
    },
  }
  return { state, model }
}

describe('ComputeLoadBars', () => {
  it('renders stacked serve pool load with progressbar semantics', () => {
    const markup = renderToStaticMarkup(
      createElement(PoolLoadBar, {
        pool: 'serve',
        fill: 0.8,
        apiShare: 0.25,
        warn: false,
        live: true,
      }),
    )
    expect(markup).toContain('role="progressbar"')
    expect(markup).toContain('data-testid="pool-load-serve"')
    expect(markup).toContain('hud-progress--stacked')
  })

  it('labels an active train pool as in-use occupancy, not idle leftover PF', () => {
    const markup = renderToStaticMarkup(
      createElement(PoolLoadBar, {
        pool: 'train',
        fill: 1,
        powerMw: 0,
        idlePf: 0,
        usedPf: 8.16,
        poolPf: 8.16,
        live: true,
      }),
    )
    expect(markup).toContain('data-testid="pool-load-train"')
    expect(markup).toContain('100.00%')
    expect(markup).toContain('cloud')
    expect(markup).toContain('In use 8.16 PF / 8.16 PF')
    expect(markup).not.toContain('Idle')
    expect(markup).not.toContain('0.000 MW')
  })

  it('still says Idle when the train pool has no assigned jobs', () => {
    const markup = renderToStaticMarkup(
      createElement(PoolLoadBar, {
        pool: 'train',
        fill: 0,
        powerMw: 0,
        idlePf: 4.08,
        usedPf: 0,
        poolPf: 4.08,
        live: false,
      }),
    )
    expect(markup).toContain('Idle 4.08 PF')
    expect(markup).not.toContain('In use')
  })

  it('derives channel loads from serve pool PF', () => {
    const { state } = withServeMarket(9_501)
    const load = servePoolLoad(state)
    const channels = channelLoadsFromServePool(load, 25, 25)
    expect(channels.apiLoad).toBeCloseTo(load.apiUsedPf / 25, 5)
    expect(channels.subLoad).toBeCloseTo(load.subUsedPf / 25, 5)
    expect(load.apiUsedPf + load.subUsedPf).toBeCloseTo(40, 5)
  })

  it('shows outage banner with pause controls when serve is down', () => {
    const { state } = withServeMarket(9_502)
    const markup = renderToStaticMarkup(
      createElement(ServeOutageBanner, {
        state,
        onPauseApi: () => undefined,
        onPauseSubs: () => undefined,
      }),
    )
    expect(markup).toContain('data-testid="serve-outage-banner"')
    expect(markup).toContain('Pause new API')
    expect(markup).toContain('Pause new subs')
  })

  it('renders peak pricing copy when surge is live', () => {
    const markup = renderToStaticMarkup(
      createElement(PeakPricingStrip, {
        listPrice: 2,
        peakPrice: 3,
        extraRevenue: 1200,
      }),
    )
    expect(markup).toContain('data-testid="peak-pricing-strip"')
    expect(markup).toContain('List $2.00/M')
    expect(markup).toContain('peak $3.00/M')
    expect(markup).toContain('extra $1.20K today')
  })

  it('renders per-model hover mix from servePoolLoad rows', () => {
    const { state, model } = withServeMarket(9_503)
    const row = servePoolLoad(state).models.find((entry) => entry.modelId === model.id)!
    const markup = renderToStaticMarkup(
      createElement(ServeModelLoadBar, { row, live: true, defaultExpanded: true }),
    )
    expect(markup).toContain('data-testid="serve-model-load-m-serve"')
    expect(markup).toContain('API')
    expect(markup).toContain('Plus')
    expect(markup).not.toContain('PF PF')
  })
})
