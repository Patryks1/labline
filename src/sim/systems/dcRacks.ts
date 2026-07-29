import { dataHallComputeMultiplier, isDcKind, isDcAnchor, mapTileAt } from './map'
/**
 * Data-hall rack inventory: order complete racks into a DC, sell them back, deliver over lead time.
 */
import { orderableMarketSkus, quoteRackOrder } from '../balance/rackSkus'
import type { MapTile, RackInstall, RackSku, SimState } from '../types'
import { eventChipLeadMult, eventExportBanGen } from './events'
import { aggregateEffects } from './research'
import { designToSku, resolveRackSku } from './racks'
import { commitWorldBatch, facilityAnchorTiles, usesCompactWorld } from './worldAccess'
import { tileCoords } from '../world'
import { seededId } from '../rng'
import { queueAcceleratorBid } from './sharedMarkets'
import { transportAccessFactorAt } from './transport'
import {
  applyRackLayoutToInstalls,
  facilityIdForHall,
  layoutRackInstalls,
  moveRack,
  rackAddressAt,
  type RackAutoPlacePreview,
} from './rackLayouts'
import { ensureRackUnitIds, refreshDataHallAnalysis } from './dataHallLayouts'

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

/**
 * Old saves can still contain globally deployed chassis and loose chips. They
 * consume real data-hall bays even though they do not carry hall coordinates.
 * Assign them deterministically after explicitly placed rack installs so every
 * capacity check sees the same occupancy as the map projection.
 */
function legacyBayUsageByHall(state: SimState): Map<string, number> {
  let remaining = (state.player.chips ?? []).reduce(
    (sum, inventory) => sum + Math.max(0, inventory.count),
    0,
  )
  for (const deployed of state.player.deployedRacks ?? []) {
    const design = state.player.rackDesigns.find((entry) => entry.id === deployed.designId)
    const sku = design ? designToSku(design) : null
    remaining += Math.max(0, deployed.count) * Math.max(1, sku?.rackUnits ?? 1)
  }
  if (remaining <= 0) return new Map()

  const placedByHall = new Map<string, number>()
  for (const install of state.player.rackFleet ?? []) {
    const key = `${install.x},${install.y}`
    placedByHall.set(
      key,
      (placedByHall.get(key) ?? 0) +
        Math.max(0, install.count) * Math.max(1, install.rackUnits || 1),
    )
  }
  const halls = facilityAnchorTiles(state, { ownerId: 'player' })
    .filter(
      (hall) =>
        isDcKind(hall.kind) &&
        isDcAnchor(hall) &&
        hall.buildingProgress >= hall.buildingTarget,
    )
    .toSorted((a, b) => {
      const usedA = placedByHall.get(`${a.x},${a.y}`) ?? 0
      const usedB = placedByHall.get(`${b.x},${b.y}`) ?? 0
      return usedA - usedB || a.y - b.y || a.x - b.x
    })
  const assigned = new Map<string, number>()
  for (const hall of halls) {
    if (remaining <= 0) break
    const key = `${hall.x},${hall.y}`
    const free = Math.max(0, hall.rackCapacity - (placedByHall.get(key) ?? 0))
    const add = Math.min(free, remaining)
    if (add > 0) assigned.set(key, add)
    remaining -= add
  }
  return assigned
}

/** Live + on-order bay units on a specific hall. */
export function dcBayUsage(state: SimState, x: number, y: number): {
  used: number
  ordered: number
  live: number
  capacity: number
  free: number
  mwLive: number
  flopsLive: number
  vramLive: number
} {
  const dc = getPlayerDc(state, x, y)
  const capacity = dc?.rackCapacity ?? 0
  const hallCompute = dc ? dataHallComputeMultiplier(dc) : 1
  let live = 0
  let owned = 0
  let ordered = 0
  let mwLive = 0
  let flopsLive = 0
  let vramLive = 0
  const designs = state.player.rackDesigns ?? []
  for (const r of state.player.rackFleet) {
    if (r.x !== x || r.y !== y) continue
    let sku: RackSku
    try {
      sku = resolveRackSku(r.skuId, designs)
    } catch {
      continue
    }
    const units = (r.rackUnits || sku.rackUnits) * r.count
    if (r.status === 'live') {
      owned += units
      const facilityId = r.facilityId ?? dc?.campusId
      const layout = facilityId ? state.dataHallLayouts?.[facilityId] : undefined
      const operational = layout ? new Set(layout.analysis.operationalRackUnitIds) : null
      const normalized = ensureRackUnitIds(r)
      const activeCount = operational ? (normalized.unitIds ?? []).filter((unitId) => operational.has(unitId)).length : r.count
      live += (r.rackUnits || sku.rackUnits) * activeCount
      mwLive += sku.mw * activeCount
      flopsLive += sku.flopsPf * activeCount * hallCompute * (layout?.analysis.throughputMultiplier ?? 1)
      vramLive += sku.vramGb * activeCount
    } else {
      ordered += units
    }
  }
  // Accelerator bids reserve their destination bays immediately. This keeps
  // bulk hall fills visible in the UI and prevents a second click from
  // overbooking space while the shared market clears the orders.
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
    ordered += remaining * Math.max(1, sku.rackUnits)
  }
  // Legacy hardware is live inventory and reserves bays before auto-balance
  // or a manual market bid can place more physical racks.
  const legacy = legacyBayUsageByHall(state).get(`${x},${y}`) ?? 0
  live += legacy
  owned += legacy
  const used = owned + ordered
  return {
    used,
    ordered,
    live,
    capacity,
    free: Math.max(0, capacity - used),
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

/** Order complete racks into a live player data hall. */
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

  const usage = dcBayUsage(state, x, y)
  const effects = aggregateEffects(state.player.researchUnlocked)
  const discount = effects.chipDiscount ?? 0
  const quote = quoteRackOrder(sku, count, {
    discount,
    freeBays: usage.free,
    cash: state.player.cash,
    pue: state.player.pue,
  })
  if (!quote.canFit) {
    return alert(
      state,
      'warn',
      `Need ${quote.bays} bay(s), only ${usage.free} free in this hall (cap ${usage.capacity}).`,
    )
  }
  if (!quote.canAfford) {
    return alert(
      state,
      'warn',
      `Need $${(quote.totalPrice / 1e6).toFixed(2)}M for ${quote.qty}× ${sku.name}.`,
    )
  }

  if (!sku.custom) {
    const supply = state.worldMarkets.accelerators[sku.id]
    const maxUnitPrice = Math.max(
      quote.unitPrice,
      (supply?.reserveUnitPrice ?? quote.unitPrice) * 1.08,
    )
    return queueAcceleratorBid(state, state.playerLabId, sku.id, quote.qty, maxUnitPrice, { x, y })
  }

  const lead = Math.max(
    sku.leadTimeDays <= 0 ? 0 : 1,
    Math.round(quote.leadDays * eventChipLeadMult(state)),
  )
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
    existing.daysLeft = Math.max(existing.daysLeft, lead)
    existing.rackUnits = sku.rackUnits
    existing.facilityId = existing.facilityId ?? dc.campusId ?? facilityIdForHall(x, y)
  } else if (lead <= 0) {
    // Instant delivery (e.g. some custom stock)
    const live = fleet.find(
      (r) => r.x === x && r.y === y && r.skuId === skuId && r.status === 'live',
    )
    if (live) {
      const prevPaid = live.paidEach * live.count
      appendRackUnitIds(live, quote.qty)
      live.count += quote.qty
      live.paidEach = Math.round((prevPaid + unit * quote.qty) / live.count)
      live.rackUnits = sku.rackUnits
    } else {
      const id = seededId('rk', state.seed, state.day, x, y, skuId, fleet.length)
      fleet.push({
        id,
        skuId,
        x,
        y,
        count: quote.qty,
        status: 'live',
        daysLeft: 0,
        paidEach: unit,
        rackUnits: sku.rackUnits,
        facilityId: dc.campusId ?? facilityIdForHall(x, y),
        unitIds: Array.from({ length: quote.qty }, (_, index) => `${id}:unit:${String(index + 1).padStart(4, '0')}`),
      })
    }
  } else {
    const id = seededId('rk', state.seed, state.day, x, y, skuId, fleet.length)
    fleet.push({
      id,
      skuId,
      x,
      y,
      count: quote.qty,
      status: 'ordered',
      daysLeft: lead,
      paidEach: unit,
      rackUnits: sku.rackUnits,
      facilityId: dc.campusId ?? facilityIdForHall(x, y),
      unitIds: Array.from({ length: quote.qty }, (_, index) => `${id}:unit:${String(index + 1).padStart(4, '0')}`),
    })
  }

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
        message:
          lead <= 0
            ? `Installed ${quote.qty}× ${sku.name} in ${dc.name || 'DC'} — $${(quote.totalPrice / 1e6).toFixed(2)}M · +${quote.mw.toFixed(3)} MW`
            : `Ordered ${quote.qty}× ${sku.name} → ${dc.name || 'DC'} — ${lead}d · $${(quote.totalPrice / 1e6).toFixed(2)}M · +${quote.mw.toFixed(3)} MW`,
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

export function tickRackDeliveries(state: SimState): SimState {
  let delivered = 0
  const fleet: RackInstall[] = []
  for (const r of state.player.rackFleet) {
    if (r.status === 'live') {
      fleet.push({ ...r })
      continue
    }
    const dailyProgress = transportAccessFactorAt(state, r.y * state.map.width + r.x)
    if (r.daysLeft <= dailyProgress) {
      // Merge into live group of same sku on hall
      const live = fleet.find(
        (x) => x.x === r.x && x.y === r.y && x.skuId === r.skuId && x.status === 'live',
      )
      if (live) {
        const prev = live.paidEach * live.count
        const incoming = ensureRackUnitIds(r)
        live.unitIds = [...(ensureRackUnitIds(live).unitIds ?? []), ...(incoming.unitIds ?? [])]
        live.count += r.count
        live.paidEach = Math.round((prev + r.paidEach * r.count) / live.count)
        live.rackUnits = r.rackUnits || live.rackUnits
      } else {
        fleet.push({ ...ensureRackUnitIds(r), status: 'live', daysLeft: 0 })
      }
      delivered += r.count
    } else {
      fleet.push({ ...r, daysLeft: r.daysLeft - dailyProgress })
    }
  }

  if (delivered <= 0) {
    return { ...state, player: { ...state.player, rackFleet: fleet } }
  }

  return {
    ...state,
    player: { ...state.player, rackFleet: fleet },
    alerts: [
      {
        id: `rack-deliv-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `${delivered} rack(s) delivered and powered on in your data halls.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
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
      const racksUsed = Math.min(stats.rackCapacity ?? 0, usage.used)
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
    return { ...t, racksUsed: Math.min(t.rackCapacity, usage.used) }
  })
  return { ...state, map: { ...state.map, tiles } }
}

export { quoteRackOrder, resolveRackSku, designToSku }
