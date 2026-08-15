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
import { DeploymentLimitSummary } from './InfrastructureOverview'
import { OrgPanel } from './OrgPanel'
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

  it('stacks company talent actions and pulse controls on phones', () => {
    useGameStore.setState({ state: createGame(64_212) })
    const markup = renderToStaticMarkup(createElement(OrgPanel))

    expect(markup).toContain('min-[500px]:flex-row')
    expect(markup).toContain('[&amp;&gt;:last-child]:col-span-2')
    expect(markup).toContain('grid w-full grid-cols-5')
    expect(markup).toContain('min-h-11')
  })

  it('uses no more than two plan values per row on phones', () => {
    useGameStore.setState({ state: createGame(64_213) })
    const markup = renderToStaticMarkup(createElement(StatsPanel))

    expect(markup).toContain('grid-cols-2')
    expect(markup).toContain('sm:grid-cols-3')
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
  })
})
