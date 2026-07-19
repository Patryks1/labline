import { describe, expect, it } from 'vitest'
import { createGame } from '../../sim/createGame'
import { getBuildDef } from '../../sim/systems/map'
import type { Facility, TileId } from '../../sim/world'
import {
  primaryRivalMapSites,
  rivalMapSites,
  rivalSiteIsConstructing,
} from './rivalMapSites'

describe('rival map sites', () => {
  it('projects every compact-world rival facility into a branded map location', () => {
    const state = createGame({
      seed: 812,
      advanced: { mapWidth: 128, mapHeight: 128, cityCount: 3, rivalCount: 5 },
    })
    const sites = rivalMapSites(state)

    expect(new Set(sites.map((site) => site.ownerId))).toEqual(
      new Set(state.rivals.map((rival) => rival.id)),
    )
    expect(primaryRivalMapSites(sites)).toHaveLength(state.rivals.length)
  })

  it('prioritizes active construction over completed HQ and compute sites', () => {
    const state = createGame({
      seed: 813,
      advanced: { mapWidth: 128, mapHeight: 128, cityCount: 3, rivalCount: 1 },
    })
    const rival = state.rivals[0]!
    const world = state.map.world!
    let anchor: TileId | undefined
    for (let id = 0; id < state.map.width * state.map.height; id++) {
      const tile = id as TileId
      if (!world.getFacilityAt(tile)) {
        anchor = tile
        break
      }
    }
    const def = getBuildDef('hq')
    const hq: Facility = {
      id: 'rival-hq-building',
      kind: 'hq',
      ownerId: rival.id,
      anchor: anchor!,
      footprint: [anchor!],
      level: 1,
      constructionProgress: 3,
      constructionTarget: def.days,
      stats: { opexPerDay: def.opexPerDay },
      data: { name: `${rival.name} HQ` },
    }
    world.beginBatch().addFacility(hq).commit()

    const primary = primaryRivalMapSites(rivalMapSites(state))[0]!
    expect(primary.id).toBe(hq.id)
    expect(rivalSiteIsConstructing(primary)).toBe(true)
  })
})
