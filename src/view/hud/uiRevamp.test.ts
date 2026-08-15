import { describe, expect, it } from 'vitest'
import { createGame } from '../../sim/createGame'
import { useGameStore } from '../../store/gameStore'
import { resolveAutoScale } from '../../store/uiStore'
import { buildObjectives } from './objectives'
import { FULL_BLEED_MAP_STYLE } from './layout'
import { groupForPanel, panelPresentation } from './navConfig'

describe('interface scaling', () => {
  it('uses display height and keeps ultrawide 1080p at the base scale', () => {
    expect(resolveAutoScale(768)).toBe(0.9)
    expect(resolveAutoScale(1080)).toBe(1)
    expect(resolveAutoScale(1440)).toBe(1.15)
    expect(resolveAutoScale(2160)).toBe(1.35)
  })
})

describe('workspace presentation', () => {
  it('routes complex workflows to the workbench and routine actions to drawers', () => {
    expect(panelPresentation('research')).toBe('immersive')
    expect(panelPresentation('models')).toBe('workbench')
    expect(panelPresentation('plans')).toBe('workbench')
    expect(panelPresentation('map')).toBe('drawer')
    expect(panelPresentation('power')).toBe('drawer')
  })

  it('promotes Build to its own top-level workspace', () => {
    expect(groupForPanel('build').id).toBe('build')
    expect(groupForPanel('map').items.some((item) => item.id === 'build')).toBe(false)
  })

  it('promotes Marketing out of Company into its own workspace', () => {
    expect(groupForPanel('marketing').id).toBe('marketing')
    expect(groupForPanel('org').items.some((item) => item.id === 'marketing')).toBe(false)
  })

  it('routes custom silicon through the combined Hardware workspace', () => {
    expect(groupForPanel('chips').id).toBe('infrastructure')
    expect(groupForPanel('chips').items.find((item) => item.id === 'racks')?.label).toBe('Hardware')
    expect(panelPresentation('chips')).toBe('workbench')
  })

  it('keeps the map full-bleed while workspace tracks expand over it', () => {
    expect(FULL_BLEED_MAP_STYLE).toEqual({
      gridColumn: '1 / -1',
      gridRow: '1 / -1',
      zIndex: 0,
    })
  })
})

describe('map navigation', () => {
  it('keeps the Build workspace open when placement mode starts', () => {
    useGameStore.setState({
      activePanel: 'map',
      leftRailOpen: false,
      selectedTile: { x: 4, y: 7 },
      buildMode: null,
    })

    useGameStore.getState().setBuildMode('dc')

    expect(useGameStore.getState()).toMatchObject({
      activePanel: 'build',
      leftRailOpen: true,
      selectedTile: null,
      buildMode: 'dc',
    })
  })

  it('retains the chosen blueprint for consecutive map placements', () => {
    // Dense-tile legacy map: compact worlds keep no dense tile storage.
    const state = createGame({
      seed: 813,
      difficulty: 'easy',
      legacyMapFixture: true,
      advanced: { mapWidth: 60, mapHeight: 60, cityCount: 3, rivalCount: 1 },
    })
    const open = state.map.tiles.filter(
      (tile) =>
        tile.kind === 'empty' &&
        tile.owner === 'neutral' &&
        tile.regionId !== 'void',
    )
    expect(open.length).toBeGreaterThanOrEqual(2)
    const first = open[0]!
    const second = open[1]!
    useGameStore.setState({
      phase: 'playing',
      state: {
        ...state,
        player: { ...state.player, cash: 1_000_000_000_000 },
      },
      activePanel: 'build',
      leftRailOpen: true,
      selectedTile: null,
      buildMode: null,
    })

    useGameStore.getState().setBuildMode('solar')
    useGameStore.getState().selectTile(first.x, first.y)
    useGameStore.getState().selectTile(second.x, second.y)

    const placed = useGameStore.getState()
    expect(placed.buildMode).toBe('solar')
    expect(placed.activePanel).toBe('build')
    expect(placed.state.map.tiles.find((tile) => tile.x === first.x && tile.y === first.y)?.kind).toBe('solar')
    expect(placed.state.map.tiles.find((tile) => tile.x === second.x && tile.y === second.y)?.kind).toBe('solar')
  })

  it('issues repeatable focus requests for rival facility shortcuts', () => {
    useGameStore.setState({ mapFocusRequest: null, selectedTile: null, buildMode: 'dc' })
    useGameStore.getState().focusMapTile(17, 23)
    const first = useGameStore.getState()

    expect(first.selectedTile).toEqual({ x: 17, y: 23 })
    expect(first.mapFocusRequest).toEqual({ x: 17, y: 23, sequence: 1, preserveZoom: false })
    expect(first.buildMode).toBeNull()

    useGameStore.getState().focusMapTile(17, 23)
    expect(useGameStore.getState().mapFocusRequest?.sequence).toBe(2)
  })
})

describe('mission-control objectives', () => {
  it('starts with the place-HQ onboarding decision', () => {
    const state = createGame({ seed: 3, difficulty: 'easy' })
    expect(buildObjectives(state, true)[0]?.id).toBe('place-hq')
  })

  it('prioritizes runway risk above guidance', () => {
    const state = createGame({ seed: 4, difficulty: 'easy' })
    state.player.finance.runwayDays = 9
    expect(buildObjectives(state, true)[0]?.id).toBe('runway-risk')
  })

  it('can hide starter guidance without hiding operational risk', () => {
    const state = createGame({ seed: 5, difficulty: 'easy' })
    expect(buildObjectives(state, false)).toEqual([])
    state.player.finance.runwayDays = 12
    expect(buildObjectives(state, false)[0]?.id).toBe('runway-risk')
  })
})

describe('onboarding visibility', () => {
  it('starts enabled and can be changed in both directions', async () => {
    const store = useGameStore.getState()
    await store.startGame({ seed: 6, difficulty: 'easy' })
    expect(useGameStore.getState().state.onboardingDismissed).toBe(false)
    useGameStore.getState().setOnboardingDismissed(true)
    expect(useGameStore.getState().state.onboardingDismissed).toBe(true)
    useGameStore.getState().setOnboardingDismissed(false)
    expect(useGameStore.getState().state.onboardingDismissed).toBe(false)
  })
})
