/**
 * Data-hall lifecycle: power down, sell halls, buy rival campuses,
 * and export surplus generation to cities / the grid.
 */
import type {
  CityPowerContract,
  MapCity,
  MapTile,
  PowerExportContract,
  SimState,
} from '../types'
import { ECONOMY } from '../balance/economy'
import { seededId } from '../rng'
import {
  resolvePlayerPowerMw,
  energyPriceForState,
  getBuildDef,
  isBuildableKind,
  isDcKind,
  isDcAnchor,
  mapTileAt,
} from './map'
import { computeSnapshot } from './compute'
import { tileCoords } from '../world/ids'
import {
  commitWorldBatch,
  compactTileIdAt,
  facilityAnchorTiles,
  facilityDataPatch,
  facilityFootprintTiles,
  usesCompactWorld,
} from './worldAccess'
import { splitEnergyContractLoad } from './energyAccounting'
import {
  acceptFacilityOffer,
  publicFacilityAsk,
  quoteFacilitySale,
  submitFacilityOffer,
} from './facilityMarket'
import { removeDataHallLayout } from './dataHallLayouts'
import { deriveCityStats } from './cityStats'

function alert(state: SimState, severity: 'info' | 'warn' | 'danger', message: string): SimState {
  return {
    ...state,
    alerts: [
      {
        id: seededId('fac-alert', state.seed, state.day, severity, message),
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function getTile(state: SimState, x: number, y: number): MapTile | undefined {
  return mapTileAt(state, x, y)
}

export function isHallPowered(t: MapTile): boolean {
  return t.powered !== false
}

/** Chebyshev distance. */
export function tileDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

export function citiesOf(state: SimState): MapCity[] {
  const raw = state.map.cities ?? []
  return raw.map((c, i) => enrichCity(c, i))
}

export const CITY_UTILITY_CONNECTOR_RANGE_TILES = 50

function commissionedPlayerGridConnectors(state: SimState): MapTile[] {
  return facilityAnchorTiles(state, { ownerId: 'player' }).filter(
    (tile) =>
      tile.kind === 'substation' &&
      tile.buildingProgress >= tile.buildingTarget &&
      tile.mwCapacity > 0,
  )
}

/** Cities reachable from at least one commissioned player grid connector. */
export function citiesInGridConnectorRange(state: SimState): MapCity[] {
  const connectors = commissionedPlayerGridConnectors(state)
  if (connectors.length === 0) return []
  return citiesOf(state).filter((city) =>
    connectors.some(
      (connector) =>
        tileDist(connector.x, connector.y, city.cx, city.cy) <=
        CITY_UTILITY_CONNECTOR_RANGE_TILES,
    ),
  )
}

function enrichCity(
  c: {
    id: string
    name: string
    cx: number
    cy: number
    radius: number
    population?: number
    powerRadius?: number
    powerBuyMw?: number
    powerBuyPriceMult?: number
    industry?: string
  },
  i: number,
): MapCity {
  const industries = ['tech', 'industrial', 'port', 'finance', 'mixed'] as const
  const pop =
    c.population ??
    Math.round(180_000 + c.radius * c.radius * 42_000 + i * 95_000)
  return {
    id: c.id,
    name: c.name,
    cx: c.cx,
    cy: c.cy,
    radius: c.radius,
    population: pop,
    powerRadius: c.powerRadius ?? Math.max(5, c.radius + 4),
    powerBuyMw: c.powerBuyMw ?? Math.max(4, 3 + c.radius * 1.4 + pop / 250_000),
    powerBuyPriceMult: c.powerBuyPriceMult ?? 0.72 + (i % 3) * 0.06,
    industry: c.industry ?? industries[i % industries.length]!,
  }
}

export function nearestCity(
  state: SimState,
  x: number,
  y: number,
): { city: MapCity; dist: number } | null {
  const cities = citiesOf(state)
  if (cities.length === 0) return null
  let best: { city: MapCity; dist: number } | null = null
  for (const city of cities) {
    const d = tileDist(x, y, city.cx, city.cy)
    if (!best || d < best.dist) best = { city, dist: d }
  }
  return best
}

export function tileInCityPowerZone(state: SimState, x: number, y: number): MapCity | null {
  const hit = nearestCity(state, x, y)
  if (!hit) return null
  return hit.dist <= hit.city.powerRadius ? hit.city : null
}

/** Live halls (player) contributing compute / power draw. */
export function playerLiveHalls(state: SimState): MapTile[] {
  return facilityAnchorTiles(state, { ownerId: 'player' }).filter(
    (t) =>
      isDcKind(t.kind) && isDcAnchor(t) &&
      t.buildingProgress >= t.buildingTarget &&
      isHallPowered(t),
  )
}

export function powerBalance(state: SimState): {
  demandMw: number
  genMw: number
  /** Completed on-site generation split by facility kind. */
  genBySourceMw: { solarMw: number; gasMw: number; nuclearMw: number; otherMw: number }
  surplusMw: number
  deficitMw: number
  gridImportMw: number
  exportMw: number
  contractedExportMw: number
  curtailedMw: number
  exportRevenueDay: number
  wholesalePerMWh: number
  cityBuyPerMWh: number
  generationUsedMw: number
  generationCostDay: number
} {
  const snap = computeSnapshot(state)
  // Snapshot demand already reflects live powered-hall fleet draw. Do not
  // discount again by powered fraction or export/import accounting double-cuts.
  const demandMw = Math.max(0, snap.mwDemand)

  const power = resolvePlayerPowerMw(state, demandMw)
  const surplusMw = Math.max(0, power.mwGeneration - demandMw)
  const deficitMw = Math.max(0, demandMw - power.mwGeneration)
  const wholesale = energyPriceForState(state)
  const generationUsedMw = Math.min(demandMw, power.mwGeneration)
  const generationCostDay = onsiteGenerationUpkeepDay(generationUsedMw, wholesale)

  // City buyback: average mult of cities covering our gen sites
  let cityMult = 0.75
  let cityMwCap = 0
  let n = 0
  const genBySourceMw = { solarMw: 0, gasMw: 0, nuclearMw: 0, otherMw: 0 }
  for (const t of facilityAnchorTiles(state, { ownerId: 'player' })) {
    if (t.buildingProgress < t.buildingTarget) continue
    if (t.mwGeneration <= 0) continue
    if (t.kind === 'solar') genBySourceMw.solarMw += t.mwGeneration
    else if (t.kind === 'gas') genBySourceMw.gasMw += t.mwGeneration
    else if (t.kind === 'nuclear') genBySourceMw.nuclearMw += t.mwGeneration
    else genBySourceMw.otherMw += t.mwGeneration
    const city = tileInCityPowerZone(state, t.x, t.y)
    if (city) {
      cityMult += city.powerBuyPriceMult
      cityMwCap += city.powerBuyMw
      n++
    }
  }
  if (n > 0) cityMult /= n
  else cityMult = 0.65

  const cityPrice = wholesale * cityMult
  const exportContracts = activePowerExportContracts(state)
  const contractedExportMw = exportContracts.reduce((sum, contract) => sum + contract.mw, 0)
  const exportMw = Math.min(surplusMw, contractedExportMw)
  let remainingExport = exportMw
  let exportRevenueDay = 0
  for (const contract of exportContracts) {
    if (remainingExport <= 0) break
    const delivered = Math.min(contract.mw, remainingExport)
    exportRevenueDay += delivered * 24 * contract.pricePerMWh
    remainingExport -= delivered
  }
  const curtailedMw = Math.max(0, surplusMw - exportMw)

  return {
    demandMw,
    genMw: power.mwGeneration,
    genBySourceMw,
    surplusMw,
    deficitMw,
    gridImportMw: power.mwGridImport,
    exportMw,
    contractedExportMw,
    curtailedMw,
    exportRevenueDay,
    wholesalePerMWh: wholesale,
    cityBuyPerMWh: cityPrice,
    generationUsedMw,
    generationCostDay,
  }
}

/** Daily window of power→compute efficiency samples kept on the player. */
export const POWER_EFFICIENCY_HISTORY_DAYS = 30

/**
 * Append today's raw-PF-per-drawn-MW sample for the Power panel trend.
 * Generated power feeds raw compute; the ratio rises with better chips and PUE.
 */
export function recordPowerEfficiencyDay(state: SimState): SimState {
  const snap = computeSnapshot(state)
  // Grid MW belongs to the local campus only. Remote/cloud PF is a contracted
  // workload and must never inflate a PF/MW ratio by sharing the local MW
  // denominator. Keep the combined effective PF separately for trend/metric
  // consumers that need the full serving capacity.
  const localPf = Math.max(0, snap.rawFlopsPf - snap.remoteFlopsPf)
  const localMw = Math.max(0, snap.mwDemand)
  const pfPerMw = localMw > 1e-6 ? localPf / localMw : 0
  const sample = {
    day: state.day,
    pfPerMw,
    localPf,
    cloudPf: Math.max(0, snap.remoteFlopsPf),
    localMw,
    combinedEffectivePf: Math.max(0, snap.effectiveFlopsPf),
    cloudEffectivePf: Math.max(0, snap.remoteEffectiveFlopsPf),
  }
  const history = state.player.powerEfficiencyHistory ?? []
  const last = history[history.length - 1]
  const next =
    last && last.day === state.day
      ? [...history.slice(0, -1), sample]
      : [...history, sample]
  return {
    ...state,
    player: {
      ...state.player,
      powerEfficiencyHistory: next.slice(-POWER_EFFICIENCY_HISTORY_DAYS),
    },
  }
}

/** Owned generation remains cheaper than grid power, but never free to run. */
export function onsiteGenerationUpkeepDay(
  generationUsedMw: number,
  gridPricePerMWh: number,
): number {
  return (
    Math.max(0, generationUsedMw) *
    24 *
    Math.max(0, gridPricePerMWh) *
    (ECONOMY.onsiteGenerationCostShare ?? 0.6)
  )
}

/** Day revenue from power export (called from market). */
export function powerExportDayRevenue(state: SimState): number {
  return powerBalance(state).exportRevenueDay
}

/** Active firm offtake contracts. */
export function activeCityPowerContracts(state: SimState): CityPowerContract[] {
  return (state.cityPowerContracts ?? []).filter((c) => c.daysLeft > 0)
}

export function activePowerExportContracts(state: SimState): PowerExportContract[] {
  return (state.powerExportContracts ?? []).filter((contract) => contract.daysLeft > 0)
}

export interface CityGridConnectorCapacity {
  connectorCount: number
  totalMw: number
  committedMw: number
  /** Municipal surplus still available to sell (after demand + existing imports). */
  surplusMw: number
  availableMw: number
}

/** Commissioned grid interconnects inside one city's utility zone. */
export function cityGridConnectorCapacity(
  state: SimState,
  cityId: string,
): CityGridConnectorCapacity {
  const city = citiesOf(state).find((candidate) => candidate.id === cityId)
  if (!city) {
    return { connectorCount: 0, totalMw: 0, committedMw: 0, surplusMw: 0, availableMw: 0 }
  }
  const connectors = commissionedPlayerGridConnectors(state).filter(
    (tile) =>
      tileDist(tile.x, tile.y, city.cx, city.cy) <= city.powerRadius,
  )
  const totalMw = connectors.reduce((sum, connector) => sum + connector.mwCapacity, 0)
  const committedMw = activeCityPowerContracts(state)
    .filter((contract) => contract.cityId === cityId)
    .reduce((sum, contract) => sum + contract.mw, 0)
  const stats = deriveCityStats(state).find((row) => row.cityId === cityId)
  // Sell only real municipal surplus. reserveMw already nets demand + committed
  // imports against plant capacity (+ player exports into the city).
  const surplusMw =
    stats && stats.municipalCapacityMw > 0
      ? Math.max(0, stats.reserveMw)
      : Math.max(0, city.powerBuyMw * 1.8 - committedMw)
  const connectorHeadroomMw = Math.max(0, totalMw - committedMw)
  return {
    connectorCount: connectors.length,
    totalMw,
    committedMw,
    surplusMw,
    availableMw: Math.max(0, Math.min(connectorHeadroomMw, surplusMw)),
  }
}

export interface PowerImportNegotiationQuote extends CityGridConnectorCapacity {
  cityId: string
  cityName: string
  requestedMw: number
  contractMw: number
  termDays: number
  askPricePerMWh: number
  floorPricePerMWh: number
}

export function powerImportNegotiationQuote(
  state: SimState,
  cityId: string,
  requestedMw: number,
  termDays: number,
): PowerImportNegotiationQuote | null {
  const city = citiesOf(state).find((candidate) => candidate.id === cityId)
  if (!city) return null
  const connector = cityGridConnectorCapacity(state, cityId)
  const term = Math.max(30, Math.min(180, Math.floor(termDays)))
  const requested = Math.max(1, requestedMw)
  const wholesale = energyPriceForState(state)
  const termFactor = 0.92 - Math.min(0.18, ((term - 30) / 180) * 0.18)
  const askPricePerMWh = Math.max(
    wholesale * 0.42,
    wholesale * city.powerBuyPriceMult * termFactor,
  )
  const floorPricePerMWh = askPricePerMWh * (0.9 - Math.min(0.04, (term - 30) / 1500))
  return {
    ...connector,
    cityId: city.id,
    cityName: city.name,
    requestedMw: requested,
    contractMw: Math.min(requested, connector.availableMw),
    termDays: term,
    askPricePerMWh,
    floorPricePerMWh,
  }
}

export function evaluatePowerImportOffer(
  quote: PowerImportNegotiationQuote,
  offeredPricePerMWh: number,
): { accepted: boolean; agreedPricePerMWh: number } {
  const offer = Math.max(0, offeredPricePerMWh)
  if (offer >= quote.floorPricePerMWh) {
    return { accepted: true, agreedPricePerMWh: Math.min(offer, quote.askPricePerMWh) }
  }
  return { accepted: false, agreedPricePerMWh: quote.floorPricePerMWh }
}

export interface PowerExportNegotiationQuote {
  cityId: string
  cityName: string
  generationMw: number
  availableMw: number
  contractMw: number
  termDays: number
  utilityOfferPerMWh: number
  ceilingPricePerMWh: number
}

export function powerExportNegotiationQuote(
  state: SimState,
  cityId: string,
  requestedMw: number,
  termDays: number,
): PowerExportNegotiationQuote | null {
  const city = citiesOf(state).find((candidate) => candidate.id === cityId)
  if (!city) return null
  const generationMw = facilityAnchorTiles(state, { ownerId: 'player' }).reduce(
    (sum, tile) =>
      tile.buildingProgress >= tile.buildingTarget &&
      tile.mwGeneration > 0 &&
      tileDist(tile.x, tile.y, city.cx, city.cy) <= city.powerRadius
        ? sum + tile.mwGeneration
        : sum,
    0,
  )
  const committedMw = activePowerExportContracts(state)
    .filter((contract) => contract.cityId === cityId)
    .reduce((sum, contract) => sum + contract.mw, 0)
  const availableMw = Math.max(0, Math.min(city.powerBuyMw, generationMw) - committedMw)
  const term = Math.max(30, Math.min(180, Math.floor(termDays)))
  const wholesale = energyPriceForState(state)
  const termDiscount = 0.96 - Math.min(0.12, ((term - 30) / 150) * 0.12)
  const utilityOfferPerMWh = wholesale * city.powerBuyPriceMult * termDiscount
  return {
    cityId: city.id,
    cityName: city.name,
    generationMw,
    availableMw,
    contractMw: Math.min(Math.max(1, requestedMw), availableMw),
    termDays: term,
    utilityOfferPerMWh,
    ceilingPricePerMWh: utilityOfferPerMWh * (1.06 + Math.min(0.04, (term - 30) / 1500)),
  }
}

export function evaluatePowerExportOffer(
  quote: PowerExportNegotiationQuote,
  requestedPricePerMWh: number,
): { accepted: boolean; agreedPricePerMWh: number } {
  const ask = Math.max(0, requestedPricePerMWh)
  if (ask <= quote.ceilingPricePerMWh) {
    return { accepted: true, agreedPricePerMWh: Math.max(ask, quote.utilityOfferPerMWh) }
  }
  return { accepted: false, agreedPricePerMWh: quote.ceilingPricePerMWh }
}

/** Sign a fixed-term sale of owned surplus generation to a city utility. */
export function signPowerExportContract(
  state: SimState,
  cityId: string,
  mwRequested: number,
  termDays: number,
  negotiatedPricePerMWh?: number,
): SimState {
  const quote = powerExportNegotiationQuote(state, cityId, mwRequested, termDays)
  if (!quote) return alert(state, 'warn', 'Unknown city.')
  if (quote.generationMw <= 0) {
    return alert(state, 'warn', `Build generation inside ${quote.cityName}'s power zone first.`)
  }
  if (quote.availableMw < 1 || quote.contractMw < 1) {
    return alert(state, 'warn', `${quote.cityName} has no remaining offtake capacity for your plants.`)
  }
  const pricePerMWh = negotiatedPricePerMWh == null
    ? quote.utilityOfferPerMWh
    : evaluatePowerExportOffer(quote, negotiatedPricePerMWh).agreedPricePerMWh
  const contract: PowerExportContract = {
    id: seededId('pwr-export', state.seed, state.day, quote.cityId, state.powerExportContracts.length),
    cityId: quote.cityId,
    cityName: quote.cityName,
    mw: quote.contractMw,
    pricePerMWh,
    daysLeft: quote.termDays,
    daysTotal: quote.termDays,
    signedDay: state.day,
  }
  return {
    ...state,
    powerExportContracts: [...state.powerExportContracts, contract],
    alerts: [
      {
        id: `pwr-export-${contract.id}`,
        day: state.day,
        severity: 'info' as const,
        message: `Export contract: ${contract.mw.toFixed(1)} MW to ${quote.cityName} @ $${contract.pricePerMWh.toFixed(0)}/MWh for ${quote.termDays}d.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function cancelPowerExportContract(state: SimState, contractId: string): SimState {
  const contract = state.powerExportContracts.find((candidate) => candidate.id === contractId)
  if (!contract) return alert(state, 'warn', 'Export contract not found.')
  const fee = Math.floor(contract.mw * contract.pricePerMWh * 24 * contract.daysLeft * 0.15)
  if (state.player.cash < fee) return alert(state, 'warn', `Break fee $${(fee / 1e3).toFixed(0)}k required.`)
  return {
    ...state,
    powerExportContracts: state.powerExportContracts.filter((candidate) => candidate.id !== contractId),
    player: { ...state.player, cash: state.player.cash - fee },
  }
}

/** Locked MW still available today (sum of contracts). */
export function contractedImportMw(state: SimState): number {
  return activeCityPowerContracts(state).reduce((s, c) => s + c.mw, 0)
}

/**
 * Split grid import into contracted vs spot MWh for billing.
 * Contracts cover firm MW at locked $/MWh; remainder at wholesale spot.
 */
export function powerImportBill(
  state: SimState,
  gridImportMw: number,
): {
  contractMw: number
  energyContractMw: number
  spotMw: number
  contractCostDay: number
  spotCostDay: number
  totalCostDay: number
  wholesalePerMWh: number
} {
  const wholesale = energyPriceForState(state)
  const contracts = activeCityPowerContracts(state)
  let remaining = Math.max(0, gridImportMw)
  let contractCostDay = 0
  let contractMw = 0
  for (const c of contracts) {
    if (remaining <= 1e-9) break
    const take = Math.min(c.mw, remaining)
    contractMw += take
    contractCostDay += take * 24 * c.pricePerMWh
    remaining -= take
  }
  // Long-term utility/PPAs are invoiced separately as take-or-pay by
  // tickEnergyContracts. They still displace spot purchases here, otherwise a
  // contracted MWh would be billed twice.
  const longTerm = splitEnergyContractLoad(state, state.playerLabId, remaining)
  const energyContractMw = longTerm.contractedMw
  const spotMw = longTerm.spotMw
  const spotCostDay = spotMw * 24 * wholesale
  return {
    contractMw,
    energyContractMw,
    spotMw,
    contractCostDay,
    spotCostDay,
    totalCostDay: contractCostDay + spotCostDay,
    wholesalePerMWh: wholesale,
  }
}

/**
 * Negotiate a firm power offtake from a city (locked $/MWh, locked term).
 * Longer terms → slightly better discount. A commissioned grid interconnect
 * inside the city's power zone is mandatory and caps contracted MW.
 */
export function signCityPowerContract(
  state: SimState,
  cityId: string,
  mw: number,
  termDays: number,
  negotiatedPricePerMWh?: number,
): SimState {
  const quote = powerImportNegotiationQuote(state, cityId, mw, termDays)
  if (!quote) return alert(state, 'warn', 'Unknown city.')
  if (quote.connectorCount === 0 || quote.totalMw <= 0) {
    return alert(
      state,
      'warn',
      `Build a grid interconnect inside ${quote.cityName}'s power zone before importing power.`,
    )
  }
  if (quote.availableMw < 1 || quote.contractMw < 1) {
    return alert(
      state,
      'warn',
      `${quote.cityName}'s grid connectors have no uncommitted import capacity.`,
    )
  }
  const wholesale = energyPriceForState(state)
  const pricePerMWh = negotiatedPricePerMWh == null
    ? quote.askPricePerMWh
    : evaluatePowerImportOffer(quote, negotiatedPricePerMWh).agreedPricePerMWh

  // Signing fee (legal / capacity reservation)
  const signFee = Math.floor(quote.contractMw * pricePerMWh * 24 * 2.5)
  if (state.player.cash < signFee) {
    return alert(
      state,
      'warn',
      `Need $${(signFee / 1e3).toFixed(0)}k reservation fee to lock ${quote.contractMw.toFixed(0)} MW.`,
    )
  }

  const contract: CityPowerContract = {
    id: seededId('pwr', state.seed, state.day, cityId, state.cityPowerContracts.length),
    cityId: quote.cityId,
    cityName: quote.cityName,
    mw: quote.contractMw,
    pricePerMWh,
    daysLeft: quote.termDays,
    daysTotal: quote.termDays,
  }

  return {
    ...state,
    cityPowerContracts: [...(state.cityPowerContracts ?? []), contract],
    player: {
      ...state.player,
      cash: state.player.cash - signFee,
    },
    alerts: [
      {
        id: `city-pwr-${contract.id}`,
        day: state.day,
        severity: 'info' as const,
        message: `Power contract: ${quote.contractMw.toFixed(1)} MW from ${quote.cityName} @ $${pricePerMWh.toFixed(0)}/MWh for ${quote.termDays}d (spot $${wholesale.toFixed(0)}). Fee $${(signFee / 1e3).toFixed(0)}k.`,
      },
      ...state.alerts,
    ].slice(0, 40),
    news: [
      `Day ${state.day}: ${state.player.name} locks ${quote.contractMw.toFixed(0)} MW from ${quote.cityName} utility (${quote.termDays}d @ $${pricePerMWh.toFixed(0)}/MWh).`,
      ...state.news,
    ].slice(0, 20),
  }
}

/** Early exit: pay remaining term × 40% of locked bill. */
export function cancelCityPowerContract(state: SimState, contractId: string): SimState {
  const contracts = [...(state.cityPowerContracts ?? [])]
  const i = contracts.findIndex((c) => c.id === contractId)
  if (i < 0) return alert(state, 'warn', 'Contract not found.')
  const c = contracts[i]!
  const fee = Math.floor(c.mw * c.pricePerMWh * 24 * c.daysLeft * 0.4)
  if (state.player.cash < fee) {
    return alert(state, 'warn', `Break fee $${(fee / 1e3).toFixed(0)}k required.`)
  }
  contracts.splice(i, 1)
  return {
    ...state,
    cityPowerContracts: contracts,
    player: { ...state.player, cash: state.player.cash - fee },
    alerts: [
      {
        id: `pwr-can-${contractId}`,
        day: state.day,
        severity: 'warn' as const,
        message: `Ended ${c.cityName} power contract early — fee $${(fee / 1e3).toFixed(0)}k.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

/** Age city power contracts (call from tick). */
export function tickCityPowerContracts(state: SimState): SimState {
  const contracts = (state.cityPowerContracts ?? [])
    .map((c) => ({ ...c, daysLeft: c.daysLeft - 1 }))
    .filter((c) => c.daysLeft > 0)
  const expired = (state.cityPowerContracts ?? []).length - contracts.length
  if (expired <= 0 && contracts.length === (state.cityPowerContracts ?? []).length) {
    // still need to write decremented days
  }
  let news = state.news
  if (expired > 0) {
    news = [
      `Day ${state.day}: ${expired} city power contract(s) expired — back on spot grid.`,
      ...news,
    ].slice(0, 20)
  }
  return { ...state, cityPowerContracts: contracts, news }
}

export function tickPowerExportContracts(state: SimState): SimState {
  const contracts = state.powerExportContracts
    .map((contract) => ({ ...contract, daysLeft: contract.daysLeft - 1 }))
    .filter((contract) => contract.daysLeft > 0)
  const expired = state.powerExportContracts.length - contracts.length
  return {
    ...state,
    powerExportContracts: contracts,
    news:
      expired > 0
        ? [`Day ${state.day}: ${expired} power export contract(s) expired.`, ...state.news].slice(0, 20)
        : state.news,
  }
}

export function setPowerExportEnabled(state: SimState, on: boolean): SimState {
  return {
    ...state,
    player: { ...state.player, powerExportEnabled: on },
  }
}

export function setHallPowered(
  state: SimState,
  x: number,
  y: number,
  powered: boolean,
): SimState {
  const t = getTile(state, x, y)
  if (!t) return state
  if (t.owner !== 'player' || !isDcKind(t.kind) || !isDcAnchor(t)) {
    return alert(state, 'warn', 'Select one of your data halls.')
  }
  if (t.buildingProgress < t.buildingTarget) {
    return alert(state, 'warn', 'Hall still under construction.')
  }
  if (usesCompactWorld(state)) {
    const facility = state.map.world!.getFacilityAt(compactTileIdAt(state, x, y)!)
    if (!facility) return state
    const batch = state.map.world!.beginBatch().updateFacility(facility.id, {
      powered,
      data: facilityDataPatch(facility, {
        note: powered
          ? 'Hall powered — racks contribute compute and draw MW.'
          : 'Powered down — no compute, no rack draw; still owns the shell.',
      }),
    })
    const committed = commitWorldBatch(state, batch)
    return {
      ...committed,
      alerts: [
        {
          id: `pwr-${state.day}-${x}-${y}`,
          day: state.day,
          severity: 'info' as const,
          message: powered
            ? `${t.name || 'Data hall'} powered on.`
            : `${t.name || 'Data hall'} powered down — saves energy, drops capacity.`,
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }
  const campusId = t.campusId
  const tiles = state.map.tiles.map((tile) => {
    const match =
      (tile.x === x && tile.y === y) ||
      (campusId && tile.campusId === campusId)
    if (!match) return tile
    return {
      ...tile,
      powered,
      note: powered
        ? 'Hall powered — racks contribute compute and draw MW.'
        : 'Powered down — no compute, no rack draw; still owns the shell.',
    }
  })
  return {
    ...state,
    map: { ...state.map, tiles },
    alerts: [
      {
        id: `pwr-${state.day}-${x}-${y}`,
        day: state.day,
        severity: 'info' as const,
        message: powered
          ? `${t.name || 'Data hall'} powered on.`
          : `${t.name || 'Data hall'} powered down — saves energy, drops capacity.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

function resolveSellTile(state: SimState, x: number, y: number): MapTile | null {
  const t = getTile(state, x, y)
  if (!t || t.owner !== 'player' || !isBuildableKind(t.kind)) return null
  // Multi-tile pads → sell via campus anchor
  if (t.campusRole === 'pad' && t.campusId) {
    const anchor = facilityFootprintTiles(state, t.campusId).find(
      (z) => z.campusRole === 'anchor',
    )
    return anchor ?? t
  }
  return t
}

function clearParcel(tile: MapTile): MapTile {
  return {
    ...tile,
    kind: 'empty' as const,
    owner: 'neutral' as const,
    name: '',
    level: 1,
    buildingProgress: 0,
    buildingTarget: 0,
    constructionExpedited: undefined,
    rackCapacity: 0,
    racksUsed: 0,
    mwCapacity: 0,
    mwGeneration: 0,
    capex: 0,
    opexPerDay: 0,
    powered: undefined,
    forSale: undefined,
    listPrice: undefined,
    campusId: undefined,
    campusRole: undefined,
    dcSize: undefined,
    hqSize: undefined,
    note: 'Former campus parcel — cleared for redevelopment.',
  }
}

export const CONSTRUCTION_FAST_TRACK_PREMIUM = 0.5
export const CONSTRUCTION_FAST_TRACK_MIN_DAYS = 15

export interface ConstructionFastTrackQuote {
  eligible: boolean
  reason?: string
  cost: number
  remainingDays: number
  acceleratedDays: number
}

/** One-time quote to halve a project's remaining schedule, never below the fast-track floor. */
export function constructionFastTrackQuote(
  state: SimState,
  x: number,
  y: number,
): ConstructionFastTrackQuote {
  const tile = resolveSellTile(state, x, y)
  if (!tile || tile.owner !== 'player') {
    return { eligible: false, reason: 'Select one of your construction projects.', cost: 0, remainingDays: 0, acceleratedDays: 0 }
  }
  const remainingDays = Math.max(0, tile.buildingTarget - tile.buildingProgress)
  const acceleratedDays = Math.max(
    CONSTRUCTION_FAST_TRACK_MIN_DAYS,
    Math.ceil(remainingDays / 2),
  )
  const cost = Math.floor(Math.max(0, tile.capex) * CONSTRUCTION_FAST_TRACK_PREMIUM)
  if (remainingDays <= 0) {
    return { eligible: false, reason: 'Construction is already complete.', cost, remainingDays, acceleratedDays: 0 }
  }
  if (tile.constructionExpedited) {
    return { eligible: false, reason: 'This project is already fast-tracked.', cost, remainingDays, acceleratedDays: remainingDays }
  }
  if (remainingDays <= CONSTRUCTION_FAST_TRACK_MIN_DAYS) {
    return { eligible: false, reason: `This project is already within ${CONSTRUCTION_FAST_TRACK_MIN_DAYS} days of completion.`, cost, remainingDays, acceleratedDays: remainingDays }
  }
  return { eligible: true, cost, remainingDays, acceleratedDays }
}

/** Pay a 50% capex premium to halve remaining construction time, with a short-schedule floor. */
export function fastTrackConstruction(state: SimState, x: number, y: number): SimState {
  const tile = resolveSellTile(state, x, y)
  const quote = constructionFastTrackQuote(state, x, y)
  if (!tile || !quote.eligible) {
    return alert(state, 'warn', quote.reason ?? 'Construction cannot be fast-tracked.')
  }
  if (state.player.cash < quote.cost) {
    return alert(
      state,
      'warn',
      `Fast-track needs $${(quote.cost / 1e6).toFixed(1)}M.`,
    )
  }

  const target = tile.buildingProgress + quote.acceleratedDays
  const note = `${tile.note.replace(/\s*·\s*Fast-track construction active\.?$/i, '')} · Fast-track construction active.`
  let next = state
  if (usesCompactWorld(state)) {
    const facility = state.map.world!.getFacilityAt(compactTileIdAt(state, tile.x, tile.y)!)
    if (!facility) return alert(state, 'warn', 'Construction project not found.')
    const batch = state.map.world!.beginBatch().updateFacility(facility.id, {
      constructionTarget: target,
      stats: {
        ...(facility.stats ?? {}),
        capex: (facility.stats?.capex ?? tile.capex) + quote.cost,
      },
      data: facilityDataPatch(facility, {
        note,
        constructionExpedited: true,
      }),
    })
    next = commitWorldBatch(state, batch)
  } else {
    const campusId = tile.campusId
    const tiles = state.map.tiles.map((current) => {
      const match =
        (current.x === tile.x && current.y === tile.y) ||
        (campusId !== undefined && current.campusId === campusId)
      if (!match) return current
      const anchor = current.x === tile.x && current.y === tile.y
      return {
        ...current,
        buildingTarget: target,
        constructionExpedited: true,
        capex: anchor ? current.capex + quote.cost : current.capex,
        note: anchor ? note : current.note,
      }
    })
    next = { ...state, map: { ...state.map, tiles } }
  }

  const label = tile.name || 'construction project'
  return {
    ...next,
    player: { ...next.player, cash: next.player.cash - quote.cost },
    alerts: [
      {
        id: seededId('fast-track', state.seed, state.day, tile.x, tile.y),
        day: state.day,
        severity: 'info' as const,
        message: `Fast-tracked ${label}: ${quote.remainingDays}d → ${quote.acceleratedDays}d for $${(quote.cost / 1e6).toFixed(1)}M.`,
      },
      ...state.alerts,
    ].slice(0, 40),
    news: [
      `Day ${state.day}: ${state.player.name} fast-tracks ${label} construction.`,
      ...state.news,
    ].slice(0, 20),
  }
}

/** Refund for cancelling construction mid-build (higher if barely started). */
export function estimateCancelRefund(state: SimState, x: number, y: number): number {
  const t = resolveSellTile(state, x, y)
  if (!t || t.owner !== 'player') return 0
  if (t.buildingTarget <= 0 || t.buildingProgress >= t.buildingTarget) return 0
  const frac = Math.min(1, Math.max(0, t.buildingProgress / t.buildingTarget))
  // Early cancel ~80% of capex; near-complete ~40%
  const rate = 0.8 - frac * 0.4
  return Math.floor(Math.max(0, t.capex) * rate)
}

/**
 * Sale value of any completed player building.
 * DCs include rack resale; other shells use capex / build def recovery.
 */
export function estimateBuildingSaleValue(state: SimState, x: number, y: number): number {
  const t = resolveSellTile(state, x, y)
  if (!t || t.owner !== 'player' || !isBuildableKind(t.kind)) return 0
  if (t.buildingProgress < t.buildingTarget) return estimateCancelRefund(state, t.x, t.y)
  if (isDcKind(t.kind) && isDcAnchor(t)) {
    return quoteFacilitySale(state, t.campusId ?? `facility:${t.x},${t.y}`)
  }

  let shell = Math.max(t.capex * 0.42, 0)
  try {
    const def = getBuildDef(t.kind)
    shell = Math.max(shell, def.cash * 0.32 * Math.max(1, t.level))
  } catch {
    /* ok */
  }
  return Math.floor(shell)
}

/** @deprecated use estimateBuildingSaleValue */
export function estimateHallSaleValue(state: SimState, x: number, y: number): number {
  const t = resolveSellTile(state, x, y)
  if (!t || !isDcKind(t.kind)) return 0
  return estimateBuildingSaleValue(state, t.x, t.y)
}

/** Cancel under-construction building and refund part of capex. */
export function cancelConstruction(state: SimState, x: number, y: number): SimState {
  const t = resolveSellTile(state, x, y)
  if (!t) return alert(state, 'warn', 'No building to cancel.')
  if (t.owner !== 'player') return alert(state, 'warn', 'Not your site.')
  if (t.buildingTarget <= 0 || t.buildingProgress >= t.buildingTarget) {
    return alert(state, 'warn', 'Nothing under construction — sell the completed building instead.')
  }
  const refund = estimateCancelRefund(state, t.x, t.y)
  const campusId = t.campusId
  if (usesCompactWorld(state) && campusId) {
    const batch = state.map.world!.beginBatch().removeFacility(campusId)
    const committed = commitWorldBatch(state, batch)
    const rackFleet = (state.player.rackFleet ?? []).filter(
      (rack) => !(rack.x === t.x && rack.y === t.y),
    )
    const sold = {
      ...committed,
      player: {
        ...committed.player,
        cash: committed.player.cash + refund,
        rackFleet,
      },
      alerts: [
        {
          id: `cancel-b-${state.day}-${t.x}-${t.y}`,
          day: state.day,
          severity: 'info' as const,
          message: `Cancelled ${t.name || 'construction'} — refund $${(refund / 1e6).toFixed(2)}M.`,
        },
        ...state.alerts,
      ].slice(0, 40),
    }
    return isDcKind(t.kind) ? removeDataHallLayout(sold, campusId) : sold
  }
  const tiles = state.map.tiles.map((tile) => {
    const clear =
      (tile.x === t.x && tile.y === t.y) || (campusId && tile.campusId === campusId)
    return clear ? clearParcel(tile) : tile
  })
  // Drop any pending rack orders to this site
  const rackFleet = (state.player.rackFleet ?? []).filter(
    (r) => !(r.x === t.x && r.y === t.y),
  )
  const sold = {
    ...state,
    map: { ...state.map, tiles },
    player: {
      ...state.player,
      cash: state.player.cash + refund,
      rackFleet,
    },
    alerts: [
      {
        id: `cancel-b-${state.day}-${t.x}-${t.y}`,
        day: state.day,
        severity: 'info' as const,
        message: `Cancelled ${t.name || 'construction'} — refund $${(refund / 1e6).toFixed(2)}M.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
  return campusId && isDcKind(t.kind) ? removeDataHallLayout(sold, campusId) : sold
}

/** Sell any completed player building (DCs include racks). Clears multi-tile campuses. */
export function sellPlayerBuilding(state: SimState, x: number, y: number): SimState {
  const t = resolveSellTile(state, x, y)
  if (!t) return alert(state, 'warn', 'No building to sell.')
  if (t.owner !== 'player' || !isBuildableKind(t.kind)) {
    return alert(state, 'warn', 'You can only sell your own buildings.')
  }
  if (t.buildingProgress < t.buildingTarget) {
    return cancelConstruction(state, t.x, t.y)
  }
  const value = estimateBuildingSaleValue(state, t.x, t.y)
  const rackFleet = isDcKind(t.kind)
    ? (state.player.rackFleet ?? []).filter((r) => !(r.x === t.x && r.y === t.y))
    : state.player.rackFleet
  const campusId = t.campusId
  const facilityId = campusId ?? `facility:${t.x},${t.y}`
  if (usesCompactWorld(state) && campusId) {
    const batch = state.map.world!.beginBatch().removeFacility(campusId)
    const committed = commitWorldBatch(state, batch)
    const label = t.name || (isDcKind(t.kind) ? 'data hall' : 'building')
    const sold = {
      ...committed,
      siteCapacities: isDcKind(t.kind)
        ? committed.siteCapacities.filter((site) => site.facilityId !== campusId)
        : committed.siteCapacities,
      player: {
        ...committed.player,
        cash: committed.player.cash + value,
        rackFleet,
      },
      alerts: [
        {
          id: `sell-b-${state.day}-${t.x}-${t.y}`,
          day: state.day,
          severity: 'info' as const,
          message: `Sold ${label} — recovered $${(value / 1e6).toFixed(2)}M${
            isDcKind(t.kind) ? ' (shell + racks)' : ''
          }.`,
        },
        ...state.alerts,
      ].slice(0, 40),
      news: [
        `Day ${state.day}: ${state.player.name} divests ${label}.`,
        ...state.news,
      ].slice(0, 20),
    }
    return isDcKind(t.kind) ? removeDataHallLayout(sold, campusId) : sold
  }
  const tiles = state.map.tiles.map((tile) => {
    const clear =
      (tile.x === t.x && tile.y === t.y) || (campusId && tile.campusId === campusId)
    return clear ? clearParcel(tile) : tile
  })
  const label = t.name || (isDcKind(t.kind) ? 'data hall' : 'building')
  const sold = {
    ...state,
    map: { ...state.map, tiles },
    siteCapacities: isDcKind(t.kind)
      ? state.siteCapacities.filter((site) => site.facilityId !== facilityId)
      : state.siteCapacities,
    player: {
      ...state.player,
      cash: state.player.cash + value,
      rackFleet,
    },
    alerts: [
      {
        id: `sell-b-${state.day}-${t.x}-${t.y}`,
        day: state.day,
        severity: 'info' as const,
        message: `Sold ${label} — recovered $${(value / 1e6).toFixed(2)}M${
          isDcKind(t.kind) ? ' (shell + racks)' : ''
        }.`,
      },
      ...state.alerts,
    ].slice(0, 40),
    news: [
      `Day ${state.day}: ${state.player.name} divests ${label}.`,
      ...state.news,
    ].slice(0, 20),
  }
  return isDcKind(t.kind) ? removeDataHallLayout(sold, facilityId) : sold
}

/** @deprecated use sellPlayerBuilding */
export function sellDataCenter(state: SimState, x: number, y: number): SimState {
  const t = resolveSellTile(state, x, y)
  if (!t || !isDcKind(t.kind)) {
    return alert(state, 'warn', 'You can only sell your completed data halls.')
  }
  return sellPlayerBuilding(state, t.x, t.y)
}

/** List price for a rival hall (what they'd accept). */
export function rivalHallAskPrice(state: SimState, t: MapTile): number {
  if (t.forSale && t.listPrice) return Math.floor(t.listPrice)
  return publicFacilityAsk(state, t.campusId ?? `facility:${t.x},${t.y}`)
}

/**
 * Compatibility entrypoint for the map UI. Acquisitions now enter the
 * cash-backed market instead of minting generic racks from abstract PF.
 */
export function buyRivalDataCenter(state: SimState, x: number, y: number): SimState {
  const t = getTile(state, x, y)
  if (!t) return state
  if (!isDcKind(t.kind) || !isDcAnchor(t) || t.buildingProgress < t.buildingTarget) {
    return alert(state, 'warn', 'Not a completed data hall.')
  }
  if (t.owner === 'player') return alert(state, 'warn', 'You already own this hall.')
  if (t.owner === 'neutral') return alert(state, 'warn', 'Utility land — build your own hall.')

  const ask = rivalHallAskPrice(state, t)
  if (state.player.cash < ask) {
    return alert(
      state,
      'warn',
      `Need $${(ask / 1e6).toFixed(1)}M to buy this campus (have $${(state.player.cash / 1e6).toFixed(1)}M).`,
    )
  }

  const offered = submitFacilityOffer(
    state,
    t.campusId ?? `facility:${t.x},${t.y}`,
    state.playerLabId,
    ask,
  )
  if (!t.forSale || !t.listPrice || offered === state) return offered
  const offer = offered.facilityMarket?.offers.find(
    (candidate) =>
      candidate.facilityId === (t.campusId ?? `facility:${t.x},${t.y}`) &&
      candidate.buyerLabId === state.playerLabId,
  )
  return offer?.status === 'pending' ? acceptFacilityOffer(offered, offer.id) : offered
}

/** Rival occasionally marks a small hall for sale. */
export function maybeListRivalHalls(state: SimState): SimState {
  if (state.day % 9 !== 0) return state
  if (usesCompactWorld(state)) {
    const world = state.map.world!
    const batch = world.beginBatch()
    let changed = false
    for (const rival of state.rivals) {
      if (rival.cash > 800_000_000 && rival.chips > 400) continue
      const halls = world
        .queryFacilities({ ownerId: rival.id, underConstruction: false })
        .filter((facility) => isDcKind(facility.kind))
      if (halls.length < 2) continue
      const victim = halls[halls.length - 1]!
      if (victim.forSale) continue
      const { x, y } = tileCoords(victim.anchor, world.descriptor.width)
      const tile = getTile(state, x, y)
      if (!tile) continue
      const ask = rivalHallAskPrice(state, tile)
      batch.updateFacility(victim.id, {
        forSale: true,
        listPrice: ask,
        data: facilityDataPatch(victim, {
          note: `${rival.name} is shopping this hall — cash-strapped expansion.`,
        }),
      })
      changed = true
    }
    if (!changed) {
      batch.rollback()
      return state
    }
    return commitWorldBatch(state, batch)
  }
  const tiles = state.map.tiles.map((t) => ({ ...t }))
  let changed = false
  for (const r of state.rivals) {
    if (r.cash > 800_000_000 && r.chips > 400) continue // healthy — not selling
    const halls = tiles.filter(
      (t) => t.owner === r.id && isDcKind(t.kind) && isDcAnchor(t) && t.buildingProgress >= t.buildingTarget,
    )
    if (halls.length < 2) continue
    const victim = halls[halls.length - 1]!
    const idx = tiles.findIndex((t) => t.x === victim.x && t.y === victim.y)
    if (idx < 0 || tiles[idx]!.forSale) continue
    const ask = rivalHallAskPrice(state, tiles[idx]!)
    tiles[idx] = {
      ...tiles[idx]!,
      forSale: true,
      listPrice: ask,
      note: `${r.name} is shopping this hall — cash-strapped expansion.`,
    }
    changed = true
  }
  if (!changed) return state
  return { ...state, map: { ...state.map, tiles } }
}

export function cityDashboard(state: SimState): {
  city: MapCity
  distToPlayer: number | null
  hallsInZone: number
  rivalHallsInZone: number
  genInZone: number
  connectorCount: number
  connectorMw: number
  connectorAvailableMw: number
}[] {
  const cities = citiesOf(state)
  const facilities = facilityAnchorTiles(state)
  const playerHalls = facilities.filter(
    (t) => t.owner === 'player' && isDcKind(t.kind) && isDcAnchor(t) && t.buildingProgress >= t.buildingTarget,
  )
  return cities.map((city) => {
    let distToPlayer: number | null = null
    for (const h of playerHalls) {
      const d = tileDist(h.x, h.y, city.cx, city.cy)
      if (distToPlayer == null || d < distToPlayer) distToPlayer = d
    }
    let hallsInZone = 0
    let rivalHallsInZone = 0
    let genInZone = 0
    for (const t of facilities) {
      const d = tileDist(t.x, t.y, city.cx, city.cy)
      if (d > city.powerRadius) continue
      if (isDcKind(t.kind) && isDcAnchor(t) && t.buildingProgress >= t.buildingTarget) {
        if (t.owner === 'player') hallsInZone++
        else if (t.owner !== 'neutral') rivalHallsInZone++
      }
      if (t.mwGeneration > 0 && t.owner === 'player') genInZone += t.mwGeneration
    }
    const connector = cityGridConnectorCapacity(state, city.id)
    return {
      city,
      distToPlayer,
      hallsInZone,
      rivalHallsInZone,
      genInZone,
      connectorCount: connector.connectorCount,
      connectorMw: connector.totalMw,
      connectorSurplusMw: connector.surplusMw,
      connectorAvailableMw: connector.availableMw,
    }
  })
}
