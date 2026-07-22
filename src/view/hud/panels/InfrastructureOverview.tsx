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
import { computeMw, gb, mw, num, pfToMw } from '../format'
import { BuildingNameField } from '../ui/BuildingNameField'
import {
  EmptyState,
  HudButton,
  MetricTile,
  StatusChip,
} from '../ui/HudPrimitives'
import { BlockerList, GameCard, LiveDot, MeterBar, StatRow } from '../ui/kit'

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
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile label="Sites" value={String(live.length)} detail={`${construction.length} building`} />
        <MetricTile label="Fleet compute" value={computeMw(pfToMw(fleet.flopsPf))} tone="positive" />
        <MetricTile
          label="Power"
          value={mw(snap.mwDemand)}
          detail={`of ${mw(snap.mwAvailable)}`}
          tone={snap.throttled ? 'danger' : 'neutral'}
        />
        <MetricTile
          label="Open bays"
          value={num(freeBays, 0)}
          detail={host.shortOn === 'ok' ? 'balanced' : `short ${host.shortOn}`}
          tone={host.shortOn === 'ok' ? 'positive' : 'warning'}
        />
      </div>

      <GameCard
        eyebrow="Capacity"
        title="Fleet command"
        actions={
          <StatusChip tone={host.shortOn === 'ok' ? 'positive' : 'warning'}>
            {host.shortOn === 'ok' ? 'balanced' : `short ${host.shortOn}`}
          </StatusChip>
        }
      >
        <div className="grid grid-cols-2 gap-x-4">
          <StatRow label="VRAM" value={gb(fleet.vramGb)} />
          <StatRow label="Host need" value={computeMw(pfToMw(host.pfNeed))} tone={host.shortOn !== 'ok' ? 'warning' : 'neutral'} />
          <StatRow label="Fleet draw" value={mw(fleet.mw)} />
          <StatRow
            label="Grid pressure"
            value={`${mw(snap.mwDemand)} / ${mw(snap.mwAvailable)}`}
            tone={snap.throttled ? 'danger' : 'neutral'}
          />
        </div>
      </GameCard>

      {liveHalls.length > 0 ? (
        <RackDeploymentPlanner state={state} halls={liveHalls} skuId={host.recommendedSkuId} />
      ) : null}

      {construction.length > 0 ? (
        <GameCard
          eyebrow="Construction"
          title="Under construction"
          tone="train"
          live
          actions={<StatusChip tone="warning">{construction.length} active</StatusChip>}
        >
          <div className="anim-stagger space-y-2">
            {construction.map((tile) => {
              const progress = tile.buildingProgress / Math.max(1, tile.buildingTarget)
              const left = Math.max(0, tile.buildingTarget - tile.buildingProgress)
              return (
                <button
                  key={`${tile.x}-${tile.y}`}
                  type="button"
                  onClick={() => showOnMap(tile)}
                  className="hover-lift w-full rounded-lg border border-amber/25 bg-amber/5 px-3 py-2 text-left transition hover:border-amber/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/50"
                >
                  <span className="flex items-center justify-between gap-2 text-[0.8125rem]">
                    <strong className="inline-flex min-w-0 items-center gap-1.5 truncate text-bone">
                      <LiveDot className="text-amber" />
                      <span className="truncate">{tile.name || facilityType(tile)}</span>
                    </strong>
                    <StatusChip tone="warning">{left}d</StatusChip>
                  </span>
                  <div className="mt-2">
                    <MeterBar value={progress} tone="train" live detail={`${Math.round(progress * 100)}%`} />
                  </div>
                </button>
              )
            })}
          </div>
        </GameCard>
      ) : null}

      <section className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-bone">Facilities</h3>
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted">{live.length} live</span>
        </div>
        {live.length === 0 ? (
          <EmptyState title="No live facilities" description="Open Build to place your first campus." />
        ) : (
          <div className="anim-stagger space-y-1.5">
            {live.map((tile) => {
              const active = selected?.x === tile.x && selected.y === tile.y
              const usage = isDcKind(tile.kind) && isDcAnchor(tile) ? dcBayUsage(state, tile.x, tile.y) : null
              return (
                <article
                  key={`${tile.x}-${tile.y}`}
                  className={`rounded-lg border px-3 py-2 ${
                    active ? 'border-mint/50 bg-mint/10' : 'border-line/70 bg-panel-2/70'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <BuildingNameField tile={tile} compact />
                      <p className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
                        {facilityType(tile)}
                        {usage ? ` · ${usage.used}/${usage.capacity} bays · ${mw(usage.mwLive)}` : ''}
                        {tile.mwGeneration > 0 ? ` · ${mw(tile.mwGeneration)} gen` : ''}
                        {tile.mwCapacity > 0 ? ` · ${mw(tile.mwCapacity)} grid` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <HudButton type="button" variant="ghost" onClick={() => showOnMap(tile)}>
                        Map
                      </HudButton>
                      <HudButton type="button" variant="primary" onClick={() => openFacility(tile)}>
                        Open
                      </HudButton>
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

function RackDeploymentPlanner({
  state,
  halls,
  skuId,
}: {
  state: SimState
  halls: MapTile[]
  skuId: string
}) {
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
  const quantity =
    quote.maxRacks > 0 ? Math.max(1, Math.min(requested ?? quote.maxRacks, quote.maxRacks)) : 0
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

  const blockers = []
  if (quote.maxRacks <= 0) {
    blockers.push({ text: 'No deployable quantity — check bays, supply, and cash.' })
  }

  return (
    <GameCard
      eyebrow="Deployment"
      title="Deploy capacity"
      tone="mint"
      actions={<StatusChip tone="positive">{quote.marketAvailable} avail</StatusChip>}
    >
      <p className="mb-2 text-[0.8125rem] text-muted">
        {sku.name} across selected halls. Supply and cash cap the order.
      </p>
      <div className="rounded-lg border border-line/70 bg-void/35 p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="hud-eyebrow">Target halls</span>
            <strong className="mt-0.5 block truncate text-[0.8125rem] text-bone">
              {deployableHalls.length === 0
                ? 'No halls with open bays'
                : `${quote.selectedHalls} of ${deployableHalls.length} · ${quote.freeBays} bays`}
            </strong>
          </div>
          {deployableHalls.length > 1 ? (
            <HudButton
              type="button"
              variant="ghost"
              aria-expanded={chooserOpen}
              onClick={() => setChooserOpen((open) => !open)}
            >
              {chooserOpen ? 'Done' : 'Choose'}
            </HudButton>
          ) : null}
        </div>

        {deployableHalls.length === 1 ? (
          <div className="mt-1.5 flex items-center justify-between rounded-md bg-panel-2/70 px-2 py-1.5 text-[0.6875rem]">
            <span className="truncate text-bone">{deployableHalls[0]!.hall.name || 'Data center'}</span>
            <span className="shrink-0 font-mono tabular-nums text-mint">{deployableHalls[0]!.free} bays</span>
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
                className="rounded-md px-1.5 py-0.5 text-[0.625rem] text-mint hover:bg-mint/10"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => {
                  setExcluded(new Set(deployableHalls.map(({ hall }) => `${hall.x},${hall.y}`)))
                  setRequested(null)
                }}
                className="rounded-md px-1.5 py-0.5 text-[0.625rem] text-muted hover:bg-panel-2 hover:text-bone"
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
                  className={`flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-[0.6875rem] transition ${
                    selected
                      ? 'border-mint/40 bg-mint/10 text-bone'
                      : 'border-line/70 bg-panel-2/50 text-muted'
                  }`}
                >
                  <span className="truncate">{hall.name || 'Data center'}</span>
                  <span className="shrink-0 font-mono tabular-nums">{free} bays</span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <MetricTile label="Selected space" value={`${quote.freeBays} bays`} />
        <MetricTile label="Cash limit" value={`${quote.affordableRacks} racks`} />
        <MetricTile label="Order ceiling" value={`${quote.maxRacks} racks`} tone="positive" />
      </div>

      {quote.maxRacks > 0 ? (
        <>
          <label className="mt-2 block text-[0.8125rem] text-muted">
            Quantity <strong className="font-mono tabular-nums text-bone">{quantity}</strong> racks ·{' '}
            {quantity * quote.rackUnits} bays
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
          <HudButton
            type="button"
            variant="primary"
            className="mt-2 w-full"
            onClick={() => {
              deployRackBatch(skuId, targets, quantity)
              setRequested(null)
            }}
          >
            {fullOrder
              ? `Fill all selected halls · ${quantity} racks`
              : `Order ${quantity} racks across ${quote.selectedHalls} halls`}
          </HudButton>
        </>
      ) : (
        <div className="mt-2">
          <BlockerList items={blockers} />
        </div>
      )}
    </GameCard>
  )
}
