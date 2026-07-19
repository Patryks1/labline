import { useMemo, useState } from 'react'
import { dcBayUsage } from '../../../sim/systems/dcRacks'
import { fleetHostSnapshot, quoteRackDeployment } from '../../../sim/systems/hosting'
import {
  getBuildDef,
  isBuildableKind,
  isDcAnchor,
  isDcKind,
  isHqKind,
  isScenicKind,
} from '../../../sim/systems/map'
import { fleetStats, resolveRackSku } from '../../../sim/systems/racks'
import { facilityAnchorTiles } from '../../../sim/systems/worldAccess'
import type { MapTile, PanelId, SimState } from '../../../sim/types'
import { useGameStore } from '../../../store/gameStore'
import { computeSnapshot } from '../../../sim/tick'
import { gb, mw, num, pf } from '../format'
import { BuildingNameField } from '../ui/BuildingNameField'

function isPlayerFacility(tile: MapTile) {
  return (
    tile.owner === 'player' &&
    tile.kind !== 'empty' &&
    !isScenicKind(tile.kind) &&
    tile.campusRole !== 'pad' &&
    isBuildableKind(tile.kind)
  )
}

function facilityPanel(tile: MapTile): PanelId {
  if (isDcKind(tile.kind)) return 'racks'
  if (['substation', 'solar', 'gas', 'nuclear', 'battery', 'cooling'].includes(tile.kind)) {
    return 'power'
  }
  if (tile.kind === 'fab') return 'chips'
  if (isHqKind(tile.kind)) return 'org'
  if (tile.kind === 'lab') return 'research'
  return 'map'
}

function facilityType(tile: MapTile) {
  try {
    return getBuildDef(tile.kind as never).label
  } catch {
    return tile.kind
  }
}

export function InfrastructureOverview() {
  const state = useGameStore((store) => store.state)
  const selected = useGameStore((store) => store.selectedTile)
  const focusMapTile = useGameStore((store) => store.focusMapTile)
  const setPanel = useGameStore((store) => store.setPanel)
  const fleet = fleetStats(state)
  const host = fleetHostSnapshot(state)
  const snap = computeSnapshot(state)

  const facilities = useMemo(
    () => facilityAnchorTiles(state, { ownerId: 'player' }).filter(isPlayerFacility),
    [state],
  )
  const construction = facilities.filter(
    (tile) => tile.buildingTarget > 0 && tile.buildingProgress < tile.buildingTarget,
  )
  const live = facilities.filter(
    (tile) => tile.buildingTarget <= 0 || tile.buildingProgress >= tile.buildingTarget,
  )
  const liveHalls = live.filter((tile) => isDcKind(tile.kind) && isDcAnchor(tile))
  const freeBays = liveHalls.reduce(
    (sum, hall) => sum + dcBayUsage(state, hall.x, hall.y).free,
    0,
  )

  const showOnMap = (tile: MapTile) => {
    setPanel('map')
    focusMapTile(tile.x, tile.y)
  }
  const openFacility = (tile: MapTile) => {
    focusMapTile(tile.x, tile.y)
    setPanel(facilityPanel(tile))
  }

  return (
    <div className="space-y-3">
      <section aria-label="Fleet status" className="overflow-hidden rounded-2xl border border-line bg-panel-2">
        <div className="flex items-center justify-between border-b border-line/60 px-3 py-2">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-bone">Fleet command</h3>
            <p className="text-[0.6875rem] text-muted">Capacity, pressure, and deployable space</p>
          </div>
          <span className={`font-mono text-[0.6875rem] uppercase ${host.shortOn === 'ok' ? 'text-mint' : 'text-amber'}`}>
            {host.shortOn === 'ok' ? 'balanced' : `short ${host.shortOn}`}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-px bg-line/50 sm:grid-cols-4">
          <FleetMetric label="Compute" value={pf(fleet.flopsPf)} />
          <FleetMetric label="VRAM" value={gb(fleet.vramGb)} />
          <FleetMetric label="Host need" value={pf(host.pfNeed)} warning={host.shortOn !== 'ok'} />
          <FleetMetric label="Open bays" value={num(freeBays, 0)} accent />
        </div>
        <div className="grid grid-cols-2 gap-x-3 px-3 py-2 font-mono text-[0.6875rem] text-muted">
          <span>Fleet draw</span><span className="text-right text-bone">{mw(fleet.mw)}</span>
          <span>Grid pressure</span><span className={`text-right ${snap.throttled ? 'text-danger' : 'text-bone'}`}>{mw(snap.mwDemand)} / {mw(snap.mwAvailable)}</span>
        </div>
      </section>

      {liveHalls.length > 0 ? (
        <RackDeploymentPlanner state={state} halls={liveHalls} skuId={host.recommendedSkuId} />
      ) : null}

      {construction.length > 0 ? (
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-[0.75rem] font-medium text-muted">Under construction</h3>
            <span className="font-mono text-[0.6875rem] text-amber">{construction.length} active</span>
          </div>
          <div className="space-y-1.5">
            {construction.map((tile) => {
              const progress = tile.buildingProgress / Math.max(1, tile.buildingTarget)
              const left = Math.max(0, tile.buildingTarget - tile.buildingProgress)
              return (
                <button
                  key={`${tile.x}-${tile.y}`}
                  type="button"
                  onClick={() => showOnMap(tile)}
                  className="w-full rounded-xl border border-amber/25 bg-amber/5 px-3 py-2 text-left transition hover:border-amber/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/50"
                >
                  <span className="flex items-center justify-between gap-2 text-[0.75rem]">
                    <strong className="truncate text-bone">{tile.name || facilityType(tile)}</strong>
                    <span className="font-mono text-amber">{left}d</span>
                  </span>
                  <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-void">
                    <span className="block h-full bg-amber" style={{ width: `${Math.min(100, progress * 100)}%` }} />
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-[0.75rem] font-medium text-muted">Facilities</h3>
          <span className="font-mono text-[0.6875rem] text-muted">{live.length} live</span>
        </div>
        {live.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-3 py-3 text-[0.75rem] text-muted">
            No live facilities. Open Build to place your first campus.
          </p>
        ) : (
          <div className="space-y-1.5">
            {live.map((tile) => {
              const active = selected?.x === tile.x && selected.y === tile.y
              const usage = isDcKind(tile.kind) && isDcAnchor(tile) ? dcBayUsage(state, tile.x, tile.y) : null
              return (
                <article key={`${tile.x}-${tile.y}`} className={`rounded-xl border px-3 py-2 ${active ? 'border-mint/50 bg-mint/10' : 'border-line bg-panel-2'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <BuildingNameField tile={tile} compact />
                      <p className="mt-0.5 font-mono text-[0.6875rem] text-muted">
                        {facilityType(tile)}
                        {usage ? ` · ${usage.used}/${usage.capacity} bays · ${mw(usage.mwLive)}` : ''}
                        {tile.mwGeneration > 0 ? ` · ${mw(tile.mwGeneration)} gen` : ''}
                        {tile.mwCapacity > 0 ? ` · ${mw(tile.mwCapacity)} grid` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button type="button" onClick={() => showOnMap(tile)} className="rounded-md px-2 py-1 text-[0.6875rem] text-muted hover:bg-void hover:text-bone">Map</button>
                      <button type="button" onClick={() => openFacility(tile)} className="rounded-md bg-mint/15 px-2 py-1 text-[0.6875rem] font-medium text-mint hover:bg-mint/25">Open</button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function RackDeploymentPlanner({ state, halls, skuId }: { state: SimState; halls: MapTile[]; skuId: string }) {
  const deployRackBatch = useGameStore((store) => store.deployRackBatch)
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  const [requested, setRequested] = useState<number | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  const deployableHalls = halls
    .map((hall) => ({ hall, free: dcBayUsage(state, hall.x, hall.y).free }))
    .filter(({ free }) => free > 0)
  const targets = deployableHalls
    .filter(({ hall }) => !excluded.has(`${hall.x},${hall.y}`))
    .map(({ hall }) => ({ x: hall.x, y: hall.y }))
  const quote = quoteRackDeployment(state, skuId, targets)
  const sku = resolveRackSku(skuId, state.player.rackDesigns)
  const quantity = quote.maxRacks > 0
    ? Math.max(1, Math.min(requested ?? quote.maxRacks, quote.maxRacks))
    : 0
  const fullOrder = quote.canFillAll && quantity === quote.fillAllRacks

  const toggleHall = (hall: MapTile) => {
    const key = `${hall.x},${hall.y}`
    setExcluded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setRequested(null)
  }

  return (
    <section aria-label="Fleet deployment" className="rounded-2xl border border-mint/25 bg-mint/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[0.8125rem] font-semibold text-bone">Deploy capacity</h3>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
            {sku.name} across selected data centers. Supply and cash cap the order before bidding.
          </p>
        </div>
        <span className="shrink-0 font-mono text-[0.6875rem] text-mint">{quote.marketAvailable} available</span>
      </div>
      <div className="mt-2 rounded-xl border border-line/70 bg-void/35 p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="block text-[0.625rem] uppercase tracking-wide text-muted">Target halls</span>
            <strong className="block truncate text-[0.75rem] font-medium text-bone">
              {deployableHalls.length === 0
                ? 'No halls with open bays'
                : `${quote.selectedHalls} of ${deployableHalls.length} · ${quote.freeBays} bays`}
            </strong>
          </div>
          {deployableHalls.length > 1 ? (
            <button
              type="button"
              aria-expanded={chooserOpen}
              onClick={() => setChooserOpen((open) => !open)}
              className="shrink-0 rounded-md border border-line px-2 py-1 text-[0.6875rem] text-muted hover:border-mint/40 hover:text-bone"
            >
              {chooserOpen ? 'Done' : 'Choose'}
            </button>
          ) : null}
        </div>

        {deployableHalls.length === 1 ? (
          <div className="mt-1.5 flex items-center justify-between rounded-lg bg-panel-2/70 px-2 py-1.5 text-[0.6875rem]">
            <span className="truncate text-bone">{deployableHalls[0]!.hall.name || 'Data center'}</span>
            <span className="shrink-0 font-mono text-mint">{deployableHalls[0]!.free} bays</span>
          </div>
        ) : chooserOpen ? (
          <div className="mt-2 space-y-1 border-t border-line/60 pt-2">
            <div className="mb-1 flex justify-end gap-1">
              <button
                type="button"
                onClick={() => {
                  setExcluded(new Set())
                  setRequested(null)
                }}
                className="rounded px-1.5 py-0.5 text-[0.625rem] text-mint hover:bg-mint/10"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => {
                  setExcluded(new Set(deployableHalls.map(({ hall }) => `${hall.x},${hall.y}`)))
                  setRequested(null)
                }}
                className="rounded px-1.5 py-0.5 text-[0.625rem] text-muted hover:bg-panel-2 hover:text-bone"
              >
                Clear
              </button>
            </div>
            {deployableHalls.map(({ hall, free }) => {
              const key = `${hall.x},${hall.y}`
              const selected = !excluded.has(key)
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleHall(hall)}
                  className={`flex w-full items-center justify-between rounded-lg border px-2 py-1.5 text-[0.6875rem] transition ${selected ? 'border-mint/40 bg-mint/10 text-bone' : 'border-line bg-panel-2/50 text-muted'}`}
                >
                  <span className="truncate">{hall.name || 'Data center'}</span>
                  <span className="shrink-0 font-mono">{free} bays</span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1 font-mono text-[0.6875rem]">
        <DeploymentMetric label="Selected space" value={`${quote.freeBays} bays`} />
        <DeploymentMetric label="Cash limit" value={`${quote.affordableRacks} racks`} />
        <DeploymentMetric label="Order ceiling" value={`${quote.maxRacks} racks`} accent />
      </div>
      {quote.maxRacks > 0 ? (
        <>
          <label className="mt-2 block text-[0.6875rem] text-muted">
            Quantity <strong className="text-bone">{quantity}</strong> racks · {quantity * quote.rackUnits} bays
            <input
              type="range"
              min={1}
              max={quote.maxRacks}
              step={1}
              value={quantity}
              onChange={(event) => setRequested(Number(event.target.value))}
              className="mt-1 w-full"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              deployRackBatch(skuId, targets, quantity)
              setRequested(null)
            }}
            className="btn-primary mt-2 w-full"
          >
            {fullOrder ? `Fill all selected halls · ${quantity} racks` : `Order ${quantity} racks across ${quote.selectedHalls} halls`}
          </button>
        </>
      ) : (
        <p className="mt-2 rounded-lg border border-amber/30 bg-amber/10 px-2 py-1.5 text-[0.6875rem] text-amber">
          No deployable quantity. Check selected bays, accelerator supply, and reserved cash.
        </p>
      )}
    </section>
  )
}

function DeploymentMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className="rounded-lg bg-void/45 px-2 py-1.5 text-muted">
      <span className="block text-[0.5625rem]">{label}</span>
      <strong className={accent ? 'text-mint' : 'text-bone'}>{value}</strong>
    </span>
  )
}

function FleetMetric({ label, value, warning = false, accent = false }: { label: string; value: string; warning?: boolean; accent?: boolean }) {
  return (
    <div className="bg-panel-2 px-3 py-2">
      <div className="text-[0.625rem] text-muted">{label}</div>
      <div className={`mt-0.5 font-mono text-[0.8125rem] font-semibold ${warning ? 'text-amber' : accent ? 'text-mint' : 'text-bone'}`}>{value}</div>
    </div>
  )
}
