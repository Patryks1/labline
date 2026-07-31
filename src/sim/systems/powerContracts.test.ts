import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { MapTile } from '../types'
import { tileId } from '../world/ids'
import {
  citiesInGridConnectorRange,
  cityGridConnectorCapacity,
  evaluatePowerExportOffer,
  evaluatePowerImportOffer,
  powerBalance,
  powerExportNegotiationQuote,
  powerImportNegotiationQuote,
  signCityPowerContract,
  signPowerExportContract,
  tickPowerExportContracts,
} from './facilities'

describe('power contracts', () => {
  it('lists only cities within 50 tiles of a commissioned player connector', () => {
    const created = createGame(91_203)
    const templateCity = created.map.cities?.[0]
    if (!templateCity) throw new Error('Expected a generated city')
    const connector = {
      x: 0,
      y: 0,
      kind: 'substation',
      owner: 'player',
      buildingProgress: 1,
      buildingTarget: 1,
      mwCapacity: 12,
    } as MapTile
    const state = {
      ...created,
      map: {
        ...created.map,
        storage: 'legacy' as const,
        world: undefined,
        tiles: [connector],
        cities: [
          { ...templateCity, id: 'at-limit', cx: 50, cy: 50 },
          { ...templateCity, id: 'outside-limit', cx: 51, cy: 0 },
        ],
      },
    }

    expect(citiesInGridConnectorRange(state).map((city) => city.id)).toEqual(['at-limit'])

    for (const unusable of [
      { ...connector, buildingProgress: 0 },
      { ...connector, mwCapacity: 0 },
      { ...connector, owner: 'rival-0' },
    ] as MapTile[]) {
      expect(
        citiesInGridConnectorRange({
          ...state,
          map: { ...state.map, tiles: [unusable] },
        }),
      ).toEqual([])
    }
  })

  it('signs import and export commitments and settles delivered surplus', () => {
    const created = createGame(91_204)
    const city = created.map.cities?.[0]
    if (!city) throw new Error('Expected a generated city')
    const world = created.map.world
    if (!world) throw new Error('Expected a compact world')
    const sites = []
    for (let y = city.cy - city.powerRadius; y <= city.cy + city.powerRadius; y += 1) {
      for (let x = city.cx - city.powerRadius; x <= city.cx + city.powerRadius; x += 1) {
        if (x < 0 || y < 0 || x >= created.map.width || y >= created.map.height) continue
        const id = tileId(x, y, created.map.width, created.map.height)
        if (!world.getFacilityAt(id)) sites.push(id)
        if (sites.length === 2) break
      }
      if (sites.length === 2) break
    }
    const connectorSite = sites[0]!
    const generationSite = sites[1]!
    world.beginBatch()
      .addFacility({
        id: 'test-grid-connector',
        kind: 'substation',
        ownerId: 'player',
        anchor: connectorSite,
        footprint: [connectorSite],
        level: 1,
        constructionProgress: 1,
        constructionTarget: 1,
        stats: { mwCapacity: 6 },
      })
      .addFacility({
        id: 'test-solar-generation',
        kind: 'solar',
        ownerId: 'player',
        anchor: generationSite,
        footprint: [generationSite],
        level: 1,
        constructionProgress: 1,
        constructionTarget: 1,
        stats: { mwGeneration: 1_000 },
      })
      .commit()
    const state = {
      ...created,
      player: { ...created.player, cash: 1_000_000_000 },
      map: { ...created.map, worldRevision: world.revision },
    }

    const connector = cityGridConnectorCapacity(state, city.id)
    expect(connector.connectorCount).toBe(1)
    expect(connector.availableMw).toBe(6)

    const importQuote = powerImportNegotiationQuote(state, city.id, 8, 60)!
    expect(importQuote.contractMw).toBe(6)
    const lowBid = evaluatePowerImportOffer(importQuote, importQuote.floorPricePerMWh - 1)
    expect(lowBid.accepted).toBe(false)

    const importing = signCityPowerContract(state, city.id, 8, 60, lowBid.agreedPricePerMWh)
    expect(importing.cityPowerContracts).toHaveLength(1)
    expect(importing.cityPowerContracts[0]?.mw).toBe(6)

    const exportQuote = powerExportNegotiationQuote(importing, city.id, 5, 60)!
    const highAsk = evaluatePowerExportOffer(exportQuote, exportQuote.ceilingPricePerMWh + 1)
    expect(highAsk.accepted).toBe(false)
    const exporting = signPowerExportContract(importing, city.id, 5, 60, highAsk.agreedPricePerMWh)
    expect(exporting.powerExportContracts).toHaveLength(1)
    const balance = powerBalance(exporting)
    expect(balance.contractedExportMw).toBe(exportQuote.contractMw)
    expect(balance.exportMw).toBeGreaterThan(0)
    expect(balance.exportMw).toBeLessThanOrEqual(exportQuote.contractMw)
    expect(balance.exportRevenueDay).toBeGreaterThan(0)
    expect(balance.curtailedMw).toBeGreaterThanOrEqual(0)
  })

  it('refuses city imports without a commissioned connector in that city zone', () => {
    const created = createGame(91_205)
    const city = created.map.cities?.[0]
    if (!city) throw new Error('Expected a generated city')
    const withoutConnectors = {
      ...created,
      player: { ...created.player, cash: 1_000_000_000 },
      map: {
        ...created.map,
        tiles: created.map.tiles.map((tile) =>
          tile.owner === 'player' && tile.kind === 'substation'
            ? { ...tile, mwCapacity: 0 }
            : tile,
        ),
      },
    }
    const result = signCityPowerContract(withoutConnectors, city.id, 5, 60)
    expect(result.cityPowerContracts).toHaveLength(0)
    expect(result.alerts[0]?.message).toContain('grid interconnect')
  })

  it('expires export commitments', () => {
    const state = createGame(44_310)
    const city = state.map.cities?.[0]
    if (!city) throw new Error('Expected a generated city')
    const contract = {
      id: 'export-one-day',
      cityId: city.id,
      cityName: city.name,
      mw: 4,
      pricePerMWh: 70,
      daysLeft: 1,
      daysTotal: 30,
      signedDay: state.day,
    }
    const expired = tickPowerExportContracts({ ...state, powerExportContracts: [contract] })
    expect(expired.powerExportContracts).toEqual([])
  })
})
