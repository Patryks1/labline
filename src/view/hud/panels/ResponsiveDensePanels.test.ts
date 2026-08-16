import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import { mapTileAtAny } from '../../../sim/systems/worldAccess'
import { useGameStore } from '../../../store/gameStore'
import { useUiStore } from '../../../store/uiStore'
import { BuildingNameField } from '../ui/BuildingNameField'
import { BenchmarksPanel } from './BenchmarksPanel'
import { BuildingDisposeButtons } from './MapPanel'
import { DeploymentLimitSummary, InfrastructureOverview } from './InfrastructureOverview'
import { MarketPanel } from './MarketPanel'
import { CapitalActionSelector, OrgPanel } from './OrgPanel'
import { OverloadPolicyControl, PlansPanel } from './PlansPanel'
import { RivalIntelPanel } from './RivalIntelPanel'
import { StatsPanel } from './StatsPanel'

describe('dense workspace mobile presentation', () => {
  it('stacks the three deployment limits before the desktop breakpoint', () => {
    const markup = renderToStaticMarkup(
      createElement(DeploymentLimitSummary, {
        plannedCabinets: 18,
        affordableRacks: 12,
        maxRacks: 10,
      }),
    )

    expect(markup).toContain(
      'grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-3',
    )
    expect(markup).toContain('min-[420px]:col-span-2 sm:col-span-1')
    expect(markup).toContain('18 cabinets')
    expect(markup).toContain('10 racks')
  })

  it('keeps benchmark comparison tables scrollable and filter targets touch-sized', () => {
    useGameStore.setState({ state: createGame(64_210) })
    const markup = renderToStaticMarkup(createElement(BenchmarksPanel))

    expect(markup).toContain('overflow-x-auto overscroll-x-contain')
    expect(markup).toContain('sticky left-0')
    expect(markup).toContain('min-h-11')
  })

  it('keeps narrow market and strategy summaries from clipping their values', () => {
    useGameStore.setState({ state: createGame(64_217) })
    const market = renderToStaticMarkup(createElement(MarketPanel))
    const strategy = renderToStaticMarkup(
      createElement(OrgPanel, { workspace: 'marketing' }),
    )

    expect(market).toContain('grid grid-cols-2 gap-2')
    expect(market).not.toContain('sm:grid-cols-4')
    expect(strategy).toContain('grid grid-cols-2 gap-2')
    expect(strategy).not.toContain('sm:grid-cols-4')
  })

  it('wraps the Plans workload ledger and keeps rival labels compact', () => {
    const state = createGame(64_219)
    useGameStore.setState({ state })
    useUiStore.getState().setSelectedRivalId(state.rivals[0]?.id ?? null)
    const rivals = renderToStaticMarkup(createElement(RivalIntelPanel))

    expect(rivals).toContain('>Current bet</span>')
    expect(rivals).not.toContain('Current bet (')
  })

  it('stacks Overview capacity ledger rows before the compact-desktop breakpoint', () => {
    useGameStore.setState({ state: createGame(64_218) })
    const markup = renderToStaticMarkup(createElement(InfrastructureOverview))

    expect(markup).toContain('grid grid-cols-1 gap-x-4 min-[500px]:grid-cols-2')
    expect(markup).toContain('Fleet draw (electrical)')
    expect(markup).toContain('Grid pressure')
  })

  it('keeps rival rows touch-sized without duplicating the share beside its meter', () => {
    const state = createGame(64_211)
    useGameStore.setState({ state })
    useUiStore.getState().setSelectedRivalId(state.rivals[0]?.id ?? null)
    const markup = renderToStaticMarkup(createElement(RivalIntelPanel))

    expect(markup).toContain('min-h-12')
    expect(markup).toContain('overflow-x-auto overscroll-x-contain')
    expect(markup).toContain('sticky left-0 z-10 bg-void')
    expect(markup).not.toContain('w-14 shrink-0 text-right')
  })

  it('routes team management through HQ floors without duplicating talent controls', () => {
    useGameStore.setState({ state: createGame(64_212) })
    const markup = renderToStaticMarkup(createElement(OrgPanel))

    expect(markup).toContain('HQ floor plan')
    expect(markup).toContain('Team management lives on the floor')
    expect(markup).not.toContain('Poach rival talent')
    expect(markup).not.toContain('team seats')
  })

  it('uses no more than two plan values per row on phones', () => {
    useGameStore.setState({ state: createGame(64_213) })
    const markup = renderToStaticMarkup(createElement(StatsPanel))

    expect(markup).toContain('grid-cols-2')
    expect(markup).toContain('sm:grid-cols-3')
  })

  it('keeps contextual company and capacity controls out of nested tablists', () => {
    const overload = renderToStaticMarkup(
      createElement(OverloadPolicyControl, {
        throttlePolicy: 'balanced',
        onChange: () => undefined,
      }),
    )
    expect(overload).toContain('role="group" aria-label="Overload policy"')
    expect(overload).toContain('aria-pressed="true"')
    expect(overload).not.toContain('role="tablist"')

    const capital = renderToStaticMarkup(
      createElement(CapitalActionSelector, {
        active: 'ownership',
        onChange: () => undefined,
      }),
    )
    expect(capital).toContain('role="group" aria-label="Capital actions"')
    expect(capital).toContain('aria-pressed="true"')
    expect(capital).not.toContain('role="tablist"')

    useGameStore.setState({ state: createGame(64_215) })
    const plans = renderToStaticMarkup(createElement(PlansPanel))
    expect(plans.match(/role="tablist"/g) ?? []).toHaveLength(1)
    const company = renderToStaticMarkup(createElement(OrgPanel))
    // Company is a people-first surface now; HQ fit-out and hiring are inline,
    // so there is no nested Team / Capital / Policy tablist to trap mobile focus.
    expect(company.match(/role="tablist"/g) ?? []).toHaveLength(0)
  })

  it('uses shared HUD controls for ordinary company and commercial actions', () => {
    useGameStore.setState({ state: createGame(64_216) })
    const plans = renderToStaticMarkup(createElement(PlansPanel))
    const company = renderToStaticMarkup(createElement(OrgPanel))
    const rivals = renderToStaticMarkup(createElement(RivalIntelPanel))

    expect(plans).toContain('hud-button')
    expect(plans).toContain('hud-input')
    expect(plans).toContain('hud-range')
    expect(company).toContain('hud-button')
    expect(rivals).toContain('hud-button')
  })

  it('gives inline building rename controls a 48px mobile target', () => {
    const markup = renderToStaticMarkup(
      createElement(BuildingNameField, {
        compact: true,
        tile: {
          x: 4,
          y: 7,
          name: 'Foundry Mega',
          kind: 'dc',
          owner: 'player',
          campusRole: 'anchor',
        },
      }),
    )

    expect(markup).toContain('min-h-12')
    expect(markup).toContain('lg:min-h-0')
    expect(markup).not.toContain('sm:min-h-0')
    expect(markup).toContain('Foundry Mega')
  })

  it('keeps noncompact building disposal actions touch-sized', () => {
    const state = createGame(64_214)
    const baseTile = mapTileAtAny(state, 0, 0)
    expect(baseTile).toBeDefined()
    state.map = {
      ...state.map,
      storage: 'legacy',
      world: undefined,
      width: 1,
      height: 1,
      tiles: [
        {
          ...baseTile!,
          x: 0,
          y: 0,
          kind: 'dc',
          owner: 'player',
          buildingProgress: 1,
          buildingTarget: 1,
          campusId: 'facility:0,0',
          campusRole: 'anchor',
        },
      ],
    }
    useGameStore.setState({ state })

    const markup = renderToStaticMarkup(
      createElement(BuildingDisposeButtons, {
        x: 0,
        y: 0,
        constructing: false,
      }),
    )

    expect(markup).toContain('!min-h-11')
    expect(markup).toContain('Sell')
    expect(markup).toContain('data-hud-variant="danger"')
  })
})
