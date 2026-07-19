import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { RackBlueprint, SimState } from '../types'
import {
  BLUEPRINT_PROFILE_KEY,
  instantiateBlueprint,
  loadProfileBlueprints,
  normalizeBlueprint,
  saveBlueprint,
  saveProfileBlueprint,
  validateBlueprint,
  type BlueprintProfileStorage,
} from './blueprints'

function validBlueprint(id = 'balanced-node'): RackBlueprint {
  return {
    id,
    name: ' Balanced node ',
    chassisId: 'case_8u',
    placements: [
      { instanceId: `${id}-nic`, moduleId: 'nic_400', slotId: 'm4' },
      { instanceId: `${id}-gpu`, moduleId: 'gpu_h100', slotId: 'g1' },
      { instanceId: `${id}-psu`, moduleId: 'psu_3k', slotId: 'm3' },
      { instanceId: `${id}-cpu`, moduleId: 'cpu_std', slotId: 'm1' },
      { instanceId: `${id}-cool`, moduleId: 'cool_liquid', slotId: 'm2' },
    ],
  }
}

function denseBlueprint(id = 'dense-node'): RackBlueprint {
  return {
    id,
    name: 'Dense node',
    chassisId: 'case_8u',
    placements: [
      ...['g1', 'g2', 'g3', 'g4'].map((slotId, index) => ({
        instanceId: `${id}-gpu-${index}`,
        moduleId: 'gpu_b200',
        slotId,
      })),
      { instanceId: `${id}-cpu`, moduleId: 'cpu_std', slotId: 'm1' },
      ...['m2', 'm3', 'm4', 'm5'].map((slotId, index) => ({
        instanceId: `${id}-cool-${index}`,
        moduleId: 'cool_liquid',
        slotId,
      })),
      { instanceId: `${id}-nic`, moduleId: 'nic_400', slotId: 'm6' },
      { instanceId: `${id}-psu`, moduleId: 'psu_8k', slotId: 'x1' },
    ],
  }
}

function withDataHall(state: SimState, includePower = true): SimState {
  const sites = state.map.tiles.filter(
    (tile) => tile.kind === 'empty' && tile.owner === 'neutral' && tile.regionId !== 'void',
  )
  const hall = sites[0]!
  const substation = sites[1]!
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) => {
        if (tile.x === hall.x && tile.y === hall.y) {
          return {
            ...tile,
            kind: 'dc' as const,
            owner: 'player' as const,
            name: 'Blueprint test hall',
            buildingProgress: 1,
            buildingTarget: 1,
            rackCapacity: 24,
            racksUsed: 0,
            powered: true,
          }
        }
        if (includePower && tile.x === substation.x && tile.y === substation.y) {
          return {
            ...tile,
            kind: 'substation' as const,
            owner: 'player' as const,
            name: 'Blueprint test interconnect',
            buildingProgress: 1,
            buildingTarget: 1,
            mwCapacity: 10,
          }
        }
        return tile
      }),
    },
    player: {
      ...state.player,
      cash: 50_000_000,
      finance: { ...state.player.finance, cash: 50_000_000 },
      rackFleet: [],
      rackDesigns: [],
    },
  }
}

function hallCoordinates(state: SimState): { x: number; y: number } {
  const hall = state.map.tiles.find(
    (tile) => tile.kind === 'dc' && tile.owner === 'player' && tile.name === 'Blueprint test hall',
  )!
  return { x: hall.x, y: hall.y }
}

class MemoryStorage implements BlueprintProfileStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('rack blueprint services', () => {
  it('validates thermal, power, memory, and network constraints without throwing', () => {
    const valid = validateBlueprint(validBlueprint(), { requiredVramGb: 80 })
    expect(valid.valid).toBe(true)
    expect(valid.networkGbps).toBe(400)
    expect(valid.stats?.vramGb).toBe(80)

    const missingNetwork = validBlueprint('offline')
    missingNetwork.placements = missingNetwork.placements.filter(
      (placement) => placement.moduleId !== 'nic_400',
    )
    const constrained = validateBlueprint(missingNetwork, {
      requiredVramGb: 160,
      powerBudgetMw: 0.0005,
    })
    expect(constrained.valid).toBe(false)
    expect(constrained.errors).toContain('Network fabric provides 0 Gbps; 400 Gbps is required.')
    expect(constrained.errors.some((error) => error.startsWith('Memory fit failed:'))).toBe(true)
    expect(constrained.errors.some((error) => error.startsWith('Power envelope exceeded:'))).toBe(true)

    const retired = validBlueprint('retired')
    retired.placements[0] = { ...retired.placements[0]!, moduleId: 'retired_nic' }
    expect(() => validateBlueprint(retired)).not.toThrow()
    expect(validateBlueprint(retired).errors).toContain('Unknown module: retired_nic.')
  })

  it('normalizes saved blueprints and freezes instantiated hardware revisions', () => {
    let state = withDataHall(createGame(610), true)
    const blueprint = validBlueprint()
    state = saveBlueprint(state, blueprint)
    expect(state.player.rackDesigns).toEqual([normalizeBlueprint(blueprint)])

    const destination = hallCoordinates(state)
    state = instantiateBlueprint(state, { ...destination, blueprintId: blueprint.id, count: 2 })
    expect(state.player.rackFleet).toEqual([
      expect.objectContaining({ skuId: `design:${blueprint.id}`, count: 2, status: 'ordered' }),
    ])

    const before = state.player.rackDesigns[0]
    const changed = validBlueprint()
    changed.placements[1] = { ...changed.placements[1]!, moduleId: 'gpu_h200' }
    const next = saveBlueprint(state, changed)
    expect(next.player.rackDesigns[0]).toEqual(before)
    expect(next.alerts[0]?.message).toContain('already instantiated')
  })

  it('delegates deterministic batch ordering to the data-center system', () => {
    let first = withDataHall(createGame(811), true)
    let second = withDataHall(createGame(811), true)
    const blueprint = validBlueprint('batch-node')
    first = saveBlueprint(first, blueprint)
    second = saveBlueprint(second, blueprint)
    const destination = hallCoordinates(first)
    const cash = first.player.cash

    first = instantiateBlueprint(first, { ...destination, blueprintId: blueprint.id, count: 3 })
    second = instantiateBlueprint(second, { ...destination, blueprintId: blueprint.id, count: 3 })

    expect(first.player.cash).toBeLessThan(cash)
    expect(first.player.rackFleet[0]).toEqual(
      expect.objectContaining({ skuId: `design:${blueprint.id}`, count: 3, daysLeft: 5 }),
    )
    expect(first.player.rackFleet).toEqual(second.player.rackFleet)
    expect(first.player.cash).toBe(second.player.cash)
  })

  it('blocks instantiation when the site cannot provide firm power', () => {
    let state = withDataHall(createGame(912), false)
    const blueprint = denseBlueprint('unpowered-node')
    state = saveBlueprint(state, blueprint)
    const destination = hallCoordinates(state)
    const cash = state.player.cash

    state = instantiateBlueprint(state, { ...destination, blueprintId: blueprint.id, count: 12 })

    expect(state.player.cash).toBe(cash)
    expect(state.player.rackFleet).toEqual([])
    expect(state.alerts[0]?.message).toContain('Insufficient firm power')
  })

  it('persists a validated, deduplicated profile library outside campaign saves', () => {
    const storage = new MemoryStorage()
    const beta = validBlueprint('beta')
    const alpha = validBlueprint('alpha')
    expect(saveProfileBlueprint(beta, storage)).toHaveLength(1)
    expect(saveProfileBlueprint(alpha, storage).map((entry) => entry.id)).toEqual([
      'alpha',
      'beta',
    ])
    beta.name = 'Beta revision'
    expect(saveProfileBlueprint(beta, storage)).toHaveLength(2)
    expect(loadProfileBlueprints(storage).find((entry) => entry.id === 'beta')?.name).toBe(
      'Beta revision',
    )

    storage.setItem(
      BLUEPRINT_PROFILE_KEY,
      JSON.stringify({
        version: 1,
        blueprints: [alpha, { ...beta, chassisId: 'retired-case' }, alpha],
      }),
    )
    expect(loadProfileBlueprints(storage)).toEqual([normalizeBlueprint(alpha)])
  })
})
