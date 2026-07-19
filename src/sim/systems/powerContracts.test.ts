import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import {
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
  it('signs import and export commitments and settles delivered surplus', () => {
    const created = createGame(91_204)
    const city = created.map.cities?.[0]
    if (!city) throw new Error('Expected a generated city')
    const sites = created.map.tiles.filter(
      (tile) =>
        tile.kind === 'empty' &&
        tile.owner === 'neutral' &&
        Math.max(Math.abs(tile.x - city.cx), Math.abs(tile.y - city.cy)) <= city.powerRadius,
    )
    const connectorSite = sites[0]!
    const generationSite = sites[1]!
    const state = {
      ...created,
      player: { ...created.player, cash: 1_000_000_000 },
      map: {
        ...created.map,
        tiles: created.map.tiles.map((tile) =>
          tile.x === connectorSite.x && tile.y === connectorSite.y
            ? {
                ...tile,
                kind: 'substation' as const,
                owner: 'player' as const,
                campusRole: 'anchor' as const,
                mwCapacity: 6,
                buildingProgress: 20,
                buildingTarget: 20,
              }
            : tile.x === generationSite.x && tile.y === generationSite.y
              ? {
                ...tile,
                kind: 'solar' as const,
                owner: 'player' as const,
                campusRole: 'anchor' as const,
                mwGeneration: 1_000,
                buildingProgress: 20,
                buildingTarget: 20,
              }
            : tile,
        ),
      },
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
    expect(balance.contractedExportMw).toBe(5)
    expect(balance.exportMw).toBeGreaterThan(0)
    expect(balance.exportMw).toBeLessThanOrEqual(5)
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
