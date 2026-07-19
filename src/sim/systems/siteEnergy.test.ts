import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { buildSaveFile, parseSave, serializeSave } from '../save'
import { tickDay } from '../tick'
import type { LabId, SimState, SiteCapacity } from '../types'
import { computeLabSnapshot, getLab, updateLab } from './labEngine'
import { resolvePlayerPowerMw } from './map'
import { powerImportBill } from './facilities'
import { splitEnergyContractLoad } from './energyAccounting'
import { tickMarket } from './market'
import {
  cancelSiteProject,
  labFirmSiteCapacityMw,
  normalizeSiteEnergyState,
  quoteEnergyContract,
  quoteSiteProject,
  signEnergyContract,
  startSiteProject,
  tickEnergyContracts,
  tickSiteProjects,
} from './siteEnergy'

function withCash(state: SimState, labId: LabId, cash = 1_000_000_000): SimState {
  return updateLab(state, labId, (lab) => ({
    ...lab,
    cash,
    finance: { ...lab.finance, cash },
  }))
}

function advanceSites(state: SimState, days: number): SimState {
  let next = state
  for (let day = 0; day < days; day++) {
    next = tickSiteProjects({ ...next, day: next.day + 1 })
  }
  return next
}

describe('shared site and energy runtime', () => {
  it('creates save-backed ledgers and deterministic grounded lead-time quotes', () => {
    const state = createGame(1_401)
    const regionId = state.map.regions[0]!.id
    const coloA = quoteSiteProject(state, {
      labId: state.playerLabId,
      route: 'colocation',
      regionId,
      targetMw: 2,
    })
    const coloB = quoteSiteProject(state, {
      labId: state.playerLabId,
      route: 'colocation',
      regionId,
      targetMw: 2,
    })
    const owned = quoteSiteProject(state, {
      labId: state.playerLabId,
      route: 'owned',
      regionId,
      targetMw: 2,
    })

    expect(state.siteProjects).toEqual([])
    expect(state.siteCapacities).toHaveLength(state.rivals.length)
    expect(state.siteCapacities.every((capacity) => capacity.labId !== state.playerLabId)).toBe(true)
    expect(state.energyContracts).toEqual([])
    expect(state.regionInterconnections).toHaveLength(state.map.regions.length)
    expect(coloA).toEqual(coloB)
    expect(coloA.constructionDays).toBeGreaterThanOrEqual(90)
    expect(coloA.constructionDays).toBeLessThanOrEqual(180)
    expect(owned.constructionDays).toBeGreaterThanOrEqual(180)
    expect(owned.constructionDays).toBeLessThanOrEqual(720)
  })

  it('allocates one finite regional pool across player and rivals without overbooking', () => {
    let state = createGame(1_402)
    const rivalId = state.rivals[0]!.id
    const regionId = state.map.regions[0]!.id
    state = withCash(withCash(state, state.playerLabId), rivalId)
    const initiallyAllocated = state.regionInterconnections.find(
      (grid) => grid.regionId === regionId,
    )!.allocatedMw
    state = {
      ...state,
      regionInterconnections: state.regionInterconnections.map((grid) =>
        grid.regionId === regionId
          ? { ...grid, firmCapacityMw: initiallyAllocated + 10 }
          : grid,
      ),
    }

    state = startSiteProject(
      state,
      quoteSiteProject(state, {
        labId: state.playerLabId,
        route: 'colocation',
        regionId,
        targetMw: 7,
      }),
    )
    state = startSiteProject(
      state,
      quoteSiteProject(state, {
        labId: rivalId,
        route: 'colocation',
        regionId,
        targetMw: 7,
      }),
    )
    state = tickSiteProjects(state)

    const grid = state.regionInterconnections.find((entry) => entry.regionId === regionId)!
    expect(grid.allocatedMw).toBeCloseTo(initiallyAllocated + 7)
    expect(grid.queuedMw).toBe(7)
    expect(grid.allocatedMw).toBeLessThanOrEqual(grid.firmCapacityMw)
    expect(state.siteProjects.filter((project) => project.status === 'construction')).toHaveLength(1)
    expect(state.siteProjects.filter((project) => project.status === 'grid_queue')).toHaveLength(1)

    const awarded = state.siteProjects.find((project) => project.status === 'construction')!
    const waiting = state.siteProjects.find((project) => project.status === 'grid_queue')!
    state = cancelSiteProject(state, awarded.id)
    expect(
      state.regionInterconnections.find((entry) => entry.regionId === regionId)!.allocatedMw,
    ).toBeCloseTo(initiallyAllocated)
    state = tickSiteProjects(state)
    expect(state.siteProjects.find((project) => project.id === waiting.id)?.status).toBe(
      'construction',
    )
    expect(
      state.regionInterconnections.find((entry) => entry.regionId === regionId)!.allocatedMw,
    ).toBeCloseTo(initiallyAllocated + 7)
  })

  it('commissions firm MW without creating accelerator PF and replays deterministically', () => {
    function run(seed: number): SimState {
      let state = withCash(createGame(seed), 'player')
      const regionId = state.map.regions[0]!.id
      state = startSiteProject(
        state,
        quoteSiteProject(state, {
          labId: state.playerLabId,
          route: 'colocation',
          regionId,
          targetMw: 3,
        }),
      )
      return advanceSites(state, 200)
    }

    const initial = createGame(1_403)
    const beforePf = computeLabSnapshot(initial, initial.playerLabId).rawFlopsPf
    const first = run(1_403)
    const second = run(1_403)

    expect(first.siteProjects).toEqual(second.siteProjects)
    expect(first.siteCapacities).toEqual(second.siteCapacities)
    expect(first.regionInterconnections).toEqual(second.regionInterconnections)
    expect(first.siteCapacities).toHaveLength(first.rivals.length + 1)
    expect(labFirmSiteCapacityMw(first, first.playerLabId)).toBe(3)
    expect(computeLabSnapshot(first, first.playerLabId).rawFlopsPf).toBe(beforePf)
  })

  it('settles take-or-pay identically for player and rival even with no compute load', () => {
    let state = createGame(1_404)
    const rivalId = state.rivals[0]!.id
    const regionId = state.map.regions[0]!.id
    const capacities: SiteCapacity[] = [
      {
        id: 'player-site',
        projectId: 'legacy-player-site',
        labId: state.playerLabId,
        route: 'owned',
        regionId,
        siteMw: 2,
        firmMw: 2,
        commissionedDay: state.day,
        status: 'active',
      },
      {
        id: 'rival-site',
        projectId: 'legacy-rival-site',
        labId: rivalId,
        route: 'owned',
        regionId,
        siteMw: 2,
        firmMw: 2,
        commissionedDay: state.day,
        status: 'active',
      },
    ]
    state = normalizeSiteEnergyState({ ...state, siteCapacities: capacities })

    const playerQuote = quoteEnergyContract(state, {
      labId: state.playerLabId,
      kind: 'ppa',
      regionId,
      mw: 1,
      termDays: 365,
    })
    state = signEnergyContract(state, playerQuote)
    const rivalQuote = quoteEnergyContract(state, {
      labId: rivalId,
      kind: 'ppa',
      regionId,
      mw: 1,
      termDays: 365,
    })
    state = signEnergyContract(state, rivalQuote)
    const playerBefore = getLab(state, state.playerLabId).cash
    const rivalBefore = getLab(state, rivalId).cash

    state = tickEnergyContracts(state)

    expect(playerQuote.dailyTakeOrPayCost).toBeCloseTo(rivalQuote.dailyTakeOrPayCost, 8)
    expect(playerBefore - getLab(state, state.playerLabId).cash).toBeCloseTo(
      playerQuote.dailyTakeOrPayCost,
      8,
    )
    expect(rivalBefore - getLab(state, rivalId).cash).toBeCloseTo(
      rivalQuote.dailyTakeOrPayCost,
      6,
    )
    expect(getLab(state, state.playerLabId).finance.dayEnergyCost).toBeCloseTo(
      playerQuote.dailyTakeOrPayCost,
      8,
    )
    expect(getLab(state, rivalId).finance.dayEnergyCost).toBeCloseTo(
      rivalQuote.dailyTakeOrPayCost,
      8,
    )
  })

  it('uses a PPA as firm player supply and displaces spot billing without refunding unused MW', () => {
    let state = createGame(1_407)
    const regionId = state.map.regions[0]!.id
    const capacity: SiteCapacity = {
      id: 'player-ppa-site',
      projectId: 'player-ppa-project',
      labId: state.playerLabId,
      route: 'owned',
      regionId,
      siteMw: 2,
      firmMw: 2,
      commissionedDay: state.day,
      status: 'active',
    }
    state = normalizeSiteEnergyState({
      ...state,
      siteCapacities: [...state.siteCapacities, capacity],
    })
    const quote = quoteEnergyContract(state, {
      labId: state.playerLabId,
      kind: 'ppa',
      regionId,
      mw: 1,
      termDays: 365,
    })
    state = signEnergyContract(state, quote)

    const power = resolvePlayerPowerMw(state, 1.5)
    const bill = powerImportBill(state, power.mwGridImport)
    const split = splitEnergyContractLoad(state, state.playerLabId, 1.5)
    const cashBefore = state.player.cash
    const settled = tickEnergyContracts(state)

    expect(power.mwEnergyContractImport).toBeCloseTo(1, 8)
    expect(power.mwAvailable).toBeCloseTo(1.5, 8)
    expect(bill.energyContractMw).toBeCloseTo(1, 8)
    expect(bill.spotMw).toBeCloseTo(0.5, 8)
    expect(bill.spotCostDay).toBeCloseTo(
      0.5 * 24 * bill.wholesalePerMWh,
      8,
    )
    expect(split.takeOrPayCostDay).toBeCloseTo(quote.dailyTakeOrPayCost, 8)
    expect(cashBefore - settled.player.cash).toBeCloseTo(
      quote.dailyTakeOrPayCost,
      8,
    )
  })

  it('settles rival spot power only above its take-or-pay contract coverage', () => {
    let state = createGame(1_408)
    const rivalId = state.rivals[0]!.id
    const regionId = state.rivals[0]!.regionId
    const availableSiteMw = labFirmSiteCapacityMw(state, rivalId, regionId)
    expect(availableSiteMw).toBeGreaterThan(0)
    const quote = quoteEnergyContract(state, {
      labId: rivalId,
      kind: 'utility',
      regionId,
      mw: Math.min(1, availableSiteMw),
      termDays: 90,
    })
    state = signEnergyContract(state, quote)
    const physical = computeLabSnapshot(state, rivalId)
    const split = splitEnergyContractLoad(state, rivalId, physical.powerMw)
    const expectedSpotCost = split.spotMw * 24 * state.map.energyPricePerMWh

    state = tickEnergyContracts(tickMarket(state))
    const finance = getLab(state, rivalId).finance

    expect(split.contractedMw).toBeGreaterThan(0)
    expect(finance.dayEnergyCost).toBeCloseTo(
      expectedSpotCost + quote.dailyTakeOrPayCost,
      6,
    )
  })

  it('round-trips projects, capacities, contracts, and grid allocation in save v4', () => {
    let state = withCash(createGame(1_405), 'player')
    const regionId = state.map.regions[0]!.id
    state = startSiteProject(
      state,
      quoteSiteProject(state, {
        labId: state.playerLabId,
        route: 'colocation',
        regionId,
        targetMw: 2,
      }),
    )
    state = tickSiteProjects(state)
    const loaded = parseSave(serializeSave(buildSaveFile(state, 'auto'))).state

    expect(loaded.siteProjects).toEqual(state.siteProjects)
    expect(loaded.siteCapacities).toEqual(state.siteCapacities)
    expect(loaded.energyContracts).toEqual(state.energyContracts)
    expect(loaded.regionInterconnections).toEqual(state.regionInterconnections)
  })

  it('advances both ledgers through the canonical daily tick', () => {
    let state = withCash(createGame(1_406), 'player')
    const regionId = state.map.regions[0]!.id
    const capacity: SiteCapacity = {
      id: 'tick-site',
      projectId: 'tick-site-legacy',
      labId: state.playerLabId,
      route: 'owned',
      regionId,
      siteMw: 2,
      firmMw: 2,
      commissionedDay: state.day,
      status: 'active',
    }
    state = normalizeSiteEnergyState({ ...state, siteCapacities: [capacity] })
    state = signEnergyContract(
      state,
      quoteEnergyContract(state, {
        labId: state.playerLabId,
        kind: 'utility',
        regionId,
        mw: 1,
        termDays: 90,
      }),
    )
    state = startSiteProject(
      state,
      quoteSiteProject(state, {
        labId: state.playerLabId,
        route: 'colocation',
        regionId,
        targetMw: 1,
      }),
    )
    const contractId = state.energyContracts[0]!.id
    const projectId = state.siteProjects[0]!.id

    state = tickDay(state)

    expect(state.energyContracts.find((contract) => contract.id === contractId)?.daysLeft).toBe(
      89,
    )
    expect(state.siteProjects.find((project) => project.id === projectId)?.status).toBe(
      'construction',
    )
  })
})
