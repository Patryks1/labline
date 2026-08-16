import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import {
  signCityPowerContract,
  signPowerExportContract,
} from '../../../sim/systems/facilities'
import { tileId } from '../../../sim/world/ids'
import { useGameStore } from '../../../store/gameStore'
import {
  PowerPanel,
  UtilityContractsCard,
} from './PowerPanel'
import {
  renewCityPowerContract,
  renewPowerExportContract,
} from './powerPanelActions'

/**
 * Player campus with a commissioned interconnect and solar inside the first
 * city's power zone, plus one live import and one live export contract.
 */
function stateWithUtilityContracts() {
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
  world
    .beginBatch()
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
  const connected = {
    ...created,
    player: { ...created.player, cash: 1_000_000_000 },
    map: { ...created.map, worldRevision: world.revision },
  }
  const importing = signCityPowerContract(connected, city.id, 8, 60)
  const exporting = signPowerExportContract(importing, city.id, 5, 60)
  return { state: exporting, city }
}

describe('Utility desk organization', () => {
  it('lists city contracts with capacity, price, remaining term, delivery, and renew/break actions', () => {
    const base = createGame(6_404)
    const state = {
      ...base,
      cityPowerContracts: [
        {
          id: 'imp-1',
          cityId: 'city-a',
          cityName: 'Meridian Falls',
          mw: 8,
          pricePerMWh: 54,
          daysLeft: 42,
          daysTotal: 60,
        },
      ],
      powerExportContracts: [
        {
          id: 'exp-1',
          cityId: 'city-a',
          cityName: 'Meridian Falls',
          mw: 3,
          pricePerMWh: 61,
          daysLeft: 10,
          daysTotal: 30,
          signedDay: base.day,
        },
      ],
    }
    const markup = renderToStaticMarkup(
      createElement(UtilityContractsCard, { state }),
    )
    expect(markup).toContain('Current city contracts')
    expect(markup).toContain('2 live')
    expect(markup).toContain('Import')
    expect(markup).toContain('Export')
    expect(markup).toContain('Meridian Falls')
    expect(markup).toContain('8.00 MW')
    expect(markup).toContain('$54.00/MWh')
    expect(markup).toContain('$61.00/MWh')
    expect(markup).toContain('42 of 60d remaining')
    expect(markup).toContain('10 of 30d remaining')
    expect(markup).toMatch(/Delivering|Standby/)
    expect(markup).toContain('Renew')
    expect(markup).toContain('Break')
  })

  it('renders nothing when there are no active contracts', () => {
    const markup = renderToStaticMarkup(
      createElement(UtilityContractsCard, { state: createGame(6_405) }),
    )
    expect(markup).toBe('')
  })

  it('keeps contracts inside the Utility desk with no separate Contracts tab', () => {
    useGameStore.setState({ state: createGame(6_406) })
    const markup = renderToStaticMarkup(createElement(PowerPanel))
    expect(markup).toContain('Utility desk')
    expect(markup).not.toContain('Contracts (')
  })
})

describe('utility contract renewal', () => {
  it('renews an import contract for a fresh full term at the re-evaluated price', () => {
    const { state } = stateWithUtilityContracts()
    const original = state.cityPowerContracts[0]!
    const aged = {
      ...state,
      cityPowerContracts: state.cityPowerContracts.map((contract) => ({
        ...contract,
        daysLeft: 12,
      })),
    }

    const renewed = renewCityPowerContract(aged, original.id)

    expect(renewed.cityPowerContracts).toHaveLength(1)
    const next = renewed.cityPowerContracts[0]!
    expect(next.daysLeft).toBe(original.daysTotal)
    expect(next.mw).toBe(original.mw)
    expect(next.pricePerMWh).toBeCloseTo(original.pricePerMWh, 8)
  })

  it('renews an export contract for a fresh full term', () => {
    const { state } = stateWithUtilityContracts()
    const original = state.powerExportContracts[0]!
    const aged = {
      ...state,
      powerExportContracts: state.powerExportContracts.map((contract) => ({
        ...contract,
        daysLeft: 7,
      })),
    }

    const renewed = renewPowerExportContract(aged, original.id)

    expect(renewed.powerExportContracts).toHaveLength(1)
    const next = renewed.powerExportContracts[0]!
    expect(next.daysLeft).toBe(original.daysTotal)
    expect(next.mw).toBe(original.mw)
  })

  it('keeps the original contract and the refusal alert when renewal fails', () => {
    const { state } = stateWithUtilityContracts()
    const original = state.cityPowerContracts[0]!
    const aged = {
      ...state,
      cityPowerContracts: state.cityPowerContracts.map((contract) => ({
        ...contract,
        daysLeft: 12,
      })),
    }
    const broke = { ...aged, player: { ...aged.player, cash: 0 } }

    const failed = renewCityPowerContract(broke, original.id)

    expect(failed.cityPowerContracts).toHaveLength(1)
    expect(failed.cityPowerContracts[0]!.daysLeft).toBe(12)
    expect(failed.alerts[0]?.message).toContain('reservation fee')
  })

  it('ignores unknown contract ids', () => {
    const { state } = stateWithUtilityContracts()
    expect(renewCityPowerContract(state, 'missing')).toBe(state)
    expect(renewPowerExportContract(state, 'missing')).toBe(state)
  })
})
