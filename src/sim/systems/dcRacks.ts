import { dataHallComputeMultiplier, isDcKind, isDcAnchor, mapTileAt } from './map'
/**
 * Data-hall rack inventory: buy racks into a DC, then commission them
 * gradually (RACK_COMMISSION_PER_DAY units per hall per day) until the
 * whole order is online.
 */
import { orderableMarketSkus, quoteRackOrder } from '../balance/rackSkus'
import type { HallAutoLayoutStrategy, MapTile, RackInstall, RackSku, SimState } from '../types'
import { eventExportBanGen } from './events'
import { aggregateEffects } from './research'
import { designToSku, resolveRackSku } from './racks'
import { commitWorldBatch, facilityAnchorTiles, usesCompactWorld } from './worldAccess'
import { tileCoords } from '../world'
import { seededId } from '../rng'
import {
  applyRackLayoutToInstalls,
  facilityIdForHall,
  layoutRackInstalls,
  moveRack,
  rackAddressAt,
  type RackAutoPlacePreview,
} from './rackLayouts'
import { ensureRackUnitIds, refreshDataHallAnalysis } from './dataHallLayouts'

/** Racks that come online per hall per day while an order is commissioning. */
export const RACK_COMMISSION_PER_DAY = 40

function appendRackUnitIds(install: RackInstall, amount: number): void {
  const normalized = ensureRackUnitIds(install)
  install.unitIds = [
    ...(normalized.unitIds ?? []),
    ...Array.from({ length: Math.max(0, amount) }, (_, index) =>
      `${install.id}:unit:${String((normalized.unitIds?.length ?? 0) + index + 1).padStart(4, '0')}`),
  ]
}

function alert(state: SimState, severity: 'info' | 'warn' | 'danger', message: string): SimState {
  return {
    ...state,
    alerts: [
      { id: `dcr-${state.day}-${message.slice(0, 18)}`, day: state.day, severity, message },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function getPlayerDc(state: SimState, x: number, y: number): MapTile | null {
  const t = mapTileAt(state, x, y)
  if (!t || (!isDcKind(t.kind) || !isDcAnchor(t)) || t.owner !== 'player') return null
  if (t.buildingProgress < t.buildingTarget) return null
  return t
}

/** Physical, operational, and staged rack-width units for one hall. */
export function dcBayUsage(state: SimState, x: number, y: number): {
  /** Concrete floor footprint: assigned, purchase-draft, and reserved racks. */
  used: number
  placed: number
  reserved: number
  /** Hardware with no concrete placement consumes no floor space. */
  staged: number
  ordered: number
  /** Delivered racks with valid utility and access routes. */
  live: number
  mwLive: number
  flopsLive: number
  vramLive: number
} {
  const dc = getPlayerDc(state, x, y)
  const hallCompute = dc ? dataHallComputeMultiplier(dc) : 1
  const facilityId = dc?.campusId ?? (dc ? facilityIdForHall(x, y) : undefined)
  const layout = facilityId ? state.dataHallLayouts?.[facilityId] : undefined
  const representedUnitIds = new Set(
    layout?.objects.flatMap((object) =>
      object.kind === 'rack' && object.rackUnitId ? [object.rackUnitId] : [],
    ) ?? [],
  )
  const designs = state.player.rackDesigns ?? []
  const rackWidthForSku = (skuId: string) => {
    try {
      return Math.max(1, resolveRackSku(skuId, designs).rackUnits)
    } catch {
      return 1
    }
  }
  let placed = 0
  let reserved = 0
  for (const object of layout?.objects ?? []) {
    if (object.kind !== 'rack') continue
    const width = rackWidthForSku(object.catalogId)
    if (object.reserved) reserved += width
    else placed += width
  }
  let live = 0
  let staged = 0
  let ordered = 0
  let mwLive = 0
  let flopsLive = 0
  let vramLive = 0
  for (const r of state.player.rackFleet) {
    if (r.x !== x || r.y !== y) continue
    let sku: RackSku
    try {
      sku = resolveRackSku(r.skuId, designs)
    } catch {
      continue
    }
    const rackWidth = r.rackUnits || sku.rackUnits
    const normalized = ensureRackUnitIds(r)
    const unitIds = normalized.unitIds ?? []
    staged +=
      unitIds.filter((unitId) => !representedUnitIds.has(unitId)).length *
      rackWidth
    if (r.status === 'live') {
      const operational = layout ? new Set(layout.analysis.operationalRackUnitIds) : null
      const activeCount = operational ? unitIds.filter((unitId) => operational.has(unitId)).length : r.count
      live += rackWidth * activeCount
      mwLive += sku.mw * activeCount
      flopsLive += sku.flopsPf * activeCount * hallCompute * (layout?.analysis.throughputMultiplier ?? 1)
      vramLive += sku.vramGb * activeCount
    } else {
      ordered += rackWidth * r.count
    }
  }
  // Market orders are staged commitments until a concrete floor placement is
  // commissioned. They never reserve an abstract bay behind the editor.
  for (const order of state.worldMarkets.orders) {
    if (
      order.kind !== 'accelerator' ||
      order.labId !== state.playerLabId ||
      order.destination?.x !== x ||
      order.destination?.y !== y
    ) continue
    let sku: RackSku
    try {
      sku = resolveRackSku(order.resourceId, designs)
    } catch {
      continue
    }
    const remaining = Math.max(0, order.quantity - order.quantityFilled)
    const width = remaining * Math.max(1, sku.rackUnits)
    ordered += width
    staged += width
  }
  return {
    used: placed + reserved,
    placed,
    reserved,
    staged,
    ordered,
    live,
    mwLive,
    flopsLive,
    vramLive,
  }
}

export function racksOnDc(state: SimState, x: number, y: number): RackInstall[] {
  return state.player.rackFleet.filter((r) => r.x === x && r.y === y)
}

/** Exact, deterministic operations layout for a completed player hall. */
export function rackLayoutOnDc(state: SimState, x: number, y: number): RackAutoPlacePreview | null {
  const dc = getPlayerDc(state, x, y)
  if (!dc) return null
  return layoutRackInstalls(
    x,
    y,
    dc.rackCapacity,
    state.player.rackFleet,
    dc.campusId ?? facilityIdForHall(x, y),
  )
}

/** Persist deterministic first-fit positions for every live and inbound rack in a hall. */
export function autoArrangeRacksInDc(state: SimState, x: number, y: number): SimState {
  const dc = getPlayerDc(state, x, y)
  if (!dc) return alert(state, 'warn', 'Select a completed player data hall.')
  // Auto-arrange is a full deterministic repack. Persisted manual starts are
  // intentionally removed here so confirmation matches the UI preview.
  const installs = state.player.rackFleet.map((install) =>
    install.x === x && install.y === y ? { ...install, bayStarts: undefined } : install)
  const preview = layoutRackInstalls(
    x,
    y,
    dc.rackCapacity,
    installs,
    dc.campusId ?? facilityIdForHall(x, y),
  )
  if (!preview.valid) return alert(state, 'warn', preview.unplaced[0]?.reason ?? 'Rack layout is invalid.')
  return {
    ...state,
    player: {
      ...state.player,
      rackFleet: applyRackLayoutToInstalls(state.player.rackFleet, x, y, preview.layout),
    },
  }
}

/** Move one physical rack to an exact bay; multi-unit racks remain contiguous. */
export function moveRackInDc(
  state: SimState,
  x: number,
  y: number,
  placementId: string,
  targetBay: number,
): SimState {
  const preview = rackLayoutOnDc(state, x, y)
  if (!preview) return alert(state, 'warn', 'Select a completed player data hall.')
  let target
  try {
    target = rackAddressAt(preview.layout.facilityId, preview.layout.templateId, targetBay)
  } catch {
    return alert(state, 'warn', 'That bay is outside the data hall.')
  }
  const moved = moveRack(preview.layout, placementId, target)
  if (moved.errors.length > 0) return alert(state, 'warn', moved.errors[0]!)
  return {
    ...state,
    player: {
      ...state.player,
      rackFleet: applyRackLayoutToInstalls(state.player.rackFleet, x, y, moved.layout),
    },
  }
}

/** Buy racks into a live player data hall; units commission 20/day per hall. */
export function orderRacksIntoDc(
  state: SimState,
  x: number,
  y: number,
  skuId: string,
  count: number,
): SimState {
  if (count <= 0) return alert(state, 'warn', 'Order at least one rack.')
  const dc = getPlayerDc(state, x, y)
  if (!dc) return alert(state, 'warn', 'Select a completed player data hall.')

  let sku: RackSku
  try {
    sku = resolveRackSku(skuId, state.player.rackDesigns)
  } catch {
    return alert(state, 'warn', 'Unknown rack type.')
  }
  // Custom fab SKU only when volume fab is online
  if (sku.id === 'rack_custom_l1' && state.player.fab.phase !== 'volume') {
    return alert(state, 'warn', 'Custom L1 racks unlock when fab reaches volume.')
  }
  // Blueprint customs are always orderable; other customs need catalog rules
  if (sku.custom && !sku.id.startsWith('design:') && sku.id !== 'rack_custom_l1') {
    return alert(state, 'warn', 'That custom rack is not available to order.')
  }
  if (sku.requiresResearch && !state.player.researchUnlocked.includes(sku.requiresResearch)) {
    return alert(state, 'warn', `Research required for ${sku.name}.`)
  }

  const ban = eventExportBanGen(state)
  if (ban != null && sku.generation >= ban && !sku.id.startsWith('design:')) {
    return alert(state, 'danger', `Export controls block ${sku.name} orders.`)
  }

  const effects = aggregateEffects(state.player.researchUnlocked)
  const discount = effects.chipDiscount ?? 0
  const quote = quoteRackOrder(sku, count, {
    discount,
    cash: state.player.cash,
    pue: state.player.pue,
  })
  if (!quote.canAfford) {
    return alert(
      state,
      'warn',
      `Need $${(quote.totalPrice / 1e6).toFixed(2)}M for ${quote.qty}× ${sku.name}.`,
    )
  }

  const fleet = state.player.rackFleet.map((r) => ({ ...r }))
  const unit = quote.unitPrice
  const existing = fleet.find(
    (r) => r.x === x && r.y === y && r.skuId === skuId && r.status === 'ordered',
  )
  if (existing) {
    const prevPaid = existing.paidEach * existing.count
    appendRackUnitIds(existing, quote.qty)
    existing.count += quote.qty
    existing.paidEach = Math.round((prevPaid + unit * quote.qty) / existing.count)
    existing.rackUnits = sku.rackUnits
    existing.facilityId = existing.facilityId ?? dc.campusId ?? facilityIdForHall(x, y)
  } else {
    const id = seededId('rk', state.seed, state.day, x, y, skuId, fleet.length)
    fleet.push({
      id,
      skuId,
      x,
      y,
      count: quote.qty,
      status: 'ordered',
      daysLeft: 0,
      paidEach: unit,
      rackUnits: sku.rackUnits,
      facilityId: dc.campusId ?? facilityIdForHall(x, y),
      unitIds: Array.from({ length: quote.qty }, (_, index) => `${id}:unit:${String(index + 1).padStart(4, '0')}`),
    })
  }

  const days = Math.ceil(quote.qty / RACK_COMMISSION_PER_DAY)
  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - quote.totalPrice,
      rackFleet: fleet,
    },
    alerts: [
      {
        id: `order-rack-${state.day}-${skuId}`,
        day: state.day,
        severity: 'info' as const,
        message: `Ordered ${quote.qty}× ${sku.name} → ${dc.name || 'DC'} — $${(quote.totalPrice / 1e6).toFixed(2)}M · +${quote.mw.toFixed(3)} MW · online in ~${days}d at ${RACK_COMMISSION_PER_DAY}/day`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

/** Sell live racks from a hall (cash back at sellBackRate). Frees bays for upgrades. */
export function sellRacksFromDc(
  state: SimState,
  x: number,
  y: number,
  skuId: string,
  count: number,
): SimState {
  if (count <= 0) return alert(state, 'warn', 'Sell at least one rack.')
  const dc = getPlayerDc(state, x, y)
  if (!dc) return alert(state, 'warn', 'Select a player data hall.')

  let sku: RackSku
  try {
    sku = resolveRackSku(skuId, state.player.rackDesigns)
  } catch {
    return alert(state, 'warn', 'Unknown rack type.')
  }

  const fleet = state.player.rackFleet.map((r) => ({ ...r }))
  const group = fleet.find((r) => r.x === x && r.y === y && r.skuId === skuId && r.status === 'live')
  if (!group || group.count < count) {
    return alert(state, 'warn', `Only ${group?.count ?? 0} live ${sku.name} in this hall.`)
  }

  const refund = Math.floor(group.paidEach * sku.sellBackRate * count)
  const normalizedGroup = ensureRackUnitIds(group)
  const removedUnitIds = new Set((normalizedGroup.unitIds ?? []).slice(Math.max(0, group.count - count)))
  group.count -= count
  if (group.bayStarts) group.bayStarts = group.bayStarts.slice(0, group.count)
  group.unitIds = (normalizedGroup.unitIds ?? []).slice(0, group.count)
  const nextFleet = fleet.filter((r) => r.count > 0)
  const facilityId = group.facilityId ?? dc.campusId ?? facilityIdForHall(x, y)
  const layout = state.dataHallLayouts?.[facilityId]
  const dataHallLayouts = layout ? {
    ...state.dataHallLayouts,
    [facilityId]: {
      ...layout,
      revision: layout.revision + 1,
      objects: layout.objects.filter((object) => !object.rackUnitId || !removedUnitIds.has(object.rackUnitId)),
    },
  } : state.dataHallLayouts

  const soldState: SimState = {
    ...state,
    dataHallLayouts,
    player: {
      ...state.player,
      cash: state.player.cash + refund,
      rackFleet: nextFleet,
    },
    alerts: [
      {
        id: `sell-rack-${state.day}-${skuId}`,
        day: state.day,
        severity: 'info' as const,
        message: `Sold ${count}× ${sku.name} from ${dc.name || 'DC'} — recovered $${(refund / 1e6).toFixed(2)}M (${Math.round(sku.sellBackRate * 100)}% resale)`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
  return refreshDataHallAnalysis(soldState, facilityId)
}

/** Cancel pending order (partial refund). */
export function cancelRackOrder(
  state: SimState,
  x: number,
  y: number,
  skuId: string,
  count: number,
): SimState {
  if (count <= 0) return state
  const fleet = state.player.rackFleet.map((r) => ({ ...r }))
  const group = fleet.find(
    (r) => r.x === x && r.y === y && r.skuId === skuId && r.status === 'ordered',
  )
  if (!group || group.count < count) {
    return alert(state, 'warn', 'Not enough racks on order.')
  }
  const refund = Math.floor(group.paidEach * 0.85 * count)
  group.count -= count
  let sku: RackSku
  try {
    sku = resolveRackSku(skuId, state.player.rackDesigns)
  } catch {
    sku = {
      id: skuId,
      name: 'Rack',
      blurb: '',
      generation: 1,
      rackUnits: 1,
      flopsPf: 0,
      vramGb: 0,
      mw: 0,
      tokPerSec: 0,
      price: 0,
      leadTimeDays: 0,
      sellBackRate: 0.4,
    }
  }
  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash + refund,
      rackFleet: fleet.filter((r) => r.count > 0),
    },
    alerts: [
      {
        id: `cancel-order-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `Cancelled ${count}× ${sku.name} order — $${(refund / 1e6).toFixed(2)}M refunded (15% restocking).`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

/** Full order catalog: custom blueprints first, then market (+ fab L1 when ready). */
export function fullOrderCatalog(state: SimState): RackSku[] {
  const customs = (state.player.rackDesigns ?? [])
    .map(designToSku)
    .filter((s): s is RackSku => s != null)
  const market = orderableMarketSkus(state.player.researchUnlocked, state.player.fab.phase)
  return [...customs, ...market]
}

/** Pick the orderable rack SKU a hall auto-layout strategy should buy. */
export function strategyRackSku(state: SimState, strategy: HallAutoLayoutStrategy): RackSku | undefined {
  const catalog = fullOrderCatalog(state)
  if (catalog.length === 0) return undefined
  const score = (sku: RackSku): number =>
    strategy === 'density'
      ? sku.flopsPf / Math.max(1, sku.rackUnits)
      : strategy === 'resilience'
        ? sku.flopsPf / Math.max(1, sku.price)
        : sku.flopsPf / Math.max(1e-9, sku.mw) // efficiency
  return [...catalog].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0]
}

/**
 * Commission ordered racks gradually: up to RACK_COMMISSION_PER_DAY units per
 * hall come online each day, oldest installs first, until every order is on.
 */
export function tickRackDeliveries(state: SimState): SimState {
  const fleet: RackInstall[] = state.player.rackFleet.map((r) => ({ ...r }))
  const remainingByHall = new Map<string, number>()
  const affectedHalls = new Set<string>()
  let commissioned = 0
  for (const install of fleet) {
    if (install.status !== 'ordered' || install.count <= 0) continue
    const key = `${install.x},${install.y}`
    const remaining = remainingByHall.get(key) ?? RACK_COMMISSION_PER_DAY
    if (remaining <= 0) continue
    const qty = Math.min(remaining, install.count)
    remainingByHall.set(key, remaining - qty)
    const movedIds = (ensureRackUnitIds(install).unitIds ?? []).slice(0, qty)
    const keptIds = (ensureRackUnitIds(install).unitIds ?? []).slice(qty)
    const live = fleet.find(
      (candidate) =>
        candidate !== install &&
        candidate.x === install.x &&
        candidate.y === install.y &&
        candidate.skuId === install.skuId &&
        candidate.status === 'live',
    )
    if (live) {
      const prev = live.paidEach * live.count
      live.unitIds = [...(ensureRackUnitIds(live).unitIds ?? []), ...movedIds]
      live.count += qty
      live.paidEach = Math.round((prev + install.paidEach * qty) / live.count)
      live.rackUnits = install.rackUnits || live.rackUnits
      live.facilityId = live.facilityId ?? install.facilityId
      install.count -= qty
      install.unitIds = keptIds
    } else if (qty === install.count) {
      // Whole order commissions at once — convert in place, keeping the id.
      install.status = 'live'
      install.daysLeft = 0
    } else {
      fleet.push({
        ...install,
        id: `${install.id}:live`,
        count: qty,
        status: 'live',
        daysLeft: 0,
        unitIds: movedIds,
      })
      install.count -= qty
      install.unitIds = keptIds
    }
    commissioned += qty
    affectedHalls.add(install.facilityId ?? `coords:${install.x},${install.y}`)
  }

  const nextFleet = fleet.filter((r) => r.count > 0)
  if (commissioned <= 0) {
    return { ...state, player: { ...state.player, rackFleet: nextFleet } }
  }

  let next: SimState = {
    ...state,
    player: { ...state.player, rackFleet: nextFleet },
    alerts: [
      {
        id: `rack-commission-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `${commissioned} rack(s) commissioned and powered on in your data halls.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
  // Commissioned units flip to delivered, so refresh each affected hall's
  // cached analysis — otherwise racks placed by an applied plan stay
  // "not operational" forever and count as zero owned compute.
  if (affectedHalls.size > 0) {
    const anchors = new Map<string, string>(
      facilityAnchorTiles(next).map(
        (tile) => [`${tile.x},${tile.y}`, tile.campusId ?? `facility:${tile.x},${tile.y}`] as const,
      ),
    )
    for (const key of affectedHalls) {
      const facilityId = key.startsWith('coords:') ? anchors.get(key.slice('coords:'.length)) : key
      if (facilityId) next = refreshDataHallAnalysis(next, facilityId)
    }
  }
  return next
}

/** Sync tile.racksUsed from rackFleet (per-hall, not a global spill). */
export function applyRackUsageToTiles(state: SimState): SimState {
  if (usesCompactWorld(state)) {
    const world = state.map.world!
    const batch = world.beginBatch()
    let changed = false
    for (const facility of world.queryFacilities({ ownerId: 'player' })) {
      if (!isDcKind(facility.kind)) continue
      const { x, y } = tileCoords(facility.anchor, world.descriptor.width)
      const usage = dcBayUsage(state, x, y)
      const stats = facility.stats ?? {}
      const racksUsed = usage.used
      if (racksUsed === (stats.racksUsed ?? 0)) continue
      batch.updateFacility(facility.id, { stats: { ...stats, racksUsed } })
      changed = true
    }
    if (!changed) {
      batch.rollback()
      return state
    }
    return commitWorldBatch(state, batch)
  }
  const tiles = state.map.tiles.map((t) => {
    if ((!isDcKind(t.kind) || !isDcAnchor(t)) || t.owner !== 'player') return t
    const usage = dcBayUsage(state, t.x, t.y)
    return { ...t, racksUsed: usage.used }
  })
  return { ...state, map: { ...state.map, tiles } }
}

export { quoteRackOrder, resolveRackSku, designToSku }
