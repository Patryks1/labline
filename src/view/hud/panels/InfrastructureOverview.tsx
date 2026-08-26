import { useMemo, useState } from 'react'
import { dcBayUsage } from '../../../sim/systems/dcRacks'
import { fleetHostSnapshot, quoteRackDeployment } from '../../../sim/systems/hosting'
import { isDcAnchor, isDcKind } from '../../../sim/systems/map'
import { fleetStats, resolveRackSku } from '../../../sim/systems/racks'
import { facilityAnchorTiles } from '../../../sim/systems/worldAccess'
import type { MapTile, SimState } from '../../../sim/types'
import { useGameStore } from '../../../store/gameStore'
import { facilityTypeLabel, isPlayerFacility } from './command/facilityIntel'
import { computeSnapshot } from '../../../sim/tick'
import { gb, mw, num, pf } from '../format'
import {
  HudButton,
  HudRange,
  MetricTile,
  StatusChip,
} from '../ui/HudPrimitives'
import { BlockerList, GameCard, LiveDot, MeterBar, StatRow } from '../ui/kit'

export function InfrastructureOverview() {
  const state = useGameStore((store) => store.state)
  const focusMapTile = useGameStore((store) => store.focusMapTile)
  const setCommandView = useGameStore((store) => store.setCommandView)
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
  const stagedRackWidths = liveHalls.reduce(
    (sum, hall) => sum + dcBayUsage(state, hall.x, hall.y).staged,
    0,
  )

  const showOnMap = (tile: MapTile) => {
    focusMapTile(tile.x, tile.y)
    setCommandView('sites')
  }

  return (
    <div className="min-w-0 touch-pan-y space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile
          label="Sites"
          value={String(live.length)}
          detail={`${construction.length} building`}
          mobileSummary={`${construction.length} active build`}
        />
        <MetricTile label="Fleet compute" value={pf(fleet.flopsPf)} detail="actual PF" tone="positive" />
        <MetricTile
          label="Power"
          value={mw(snap.mwDemand)}
          detail={`of ${mw(snap.mwAvailable)}`}
          tone={snap.throttled ? 'danger' : 'neutral'}
        />
        <MetricTile
          label="Staged hardware"
          value={num(stagedRackWidths, 0)}
          detail="rack-width units off-floor"
          mobileSummary="off-floor"
          mobilePriority={stagedRackWidths > 0 ? 'primary' : 'secondary'}
          tone={stagedRackWidths > 0 ? 'warning' : 'positive'}
        />
      </div>

      <GameCard
        eyebrow="Capacity"
        title="Fleet command"
        mobileSummary={`${pf(fleet.flopsPf)} live · ${mw(snap.mwDemand)} draw`}
        actions={
          <StatusChip tone={host.shortOn === 'ok' ? 'positive' : 'warning'}>
            {host.shortOn === 'ok' ? 'balanced' : `short ${host.shortOn}`}
          </StatusChip>
        }
      >
        <div className="grid grid-cols-1 gap-x-4 min-[500px]:grid-cols-2">
          <StatRow label="VRAM" value={gb(fleet.vramGb)} />
          <StatRow label="Host need" value={pf(host.pfNeed)} tone={host.shortOn !== 'ok' ? 'warning' : 'neutral'} />
          <StatRow label="Fleet draw (electrical)" value={mw(fleet.mw)} />
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
          <div
            className="anim-stagger panel-scroll -mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain px-1 pb-1 touch-pan-x touch-pan-y min-[1181px]:mx-0 min-[1181px]:block min-[1181px]:space-y-2 min-[1181px]:overflow-visible min-[1181px]:px-0 min-[1181px]:pb-0"
            role="region"
            aria-label="Construction projects; swipe horizontally to browse on touch screens"
          >
            {construction.map((tile) => {
              const progress = tile.buildingProgress / Math.max(1, tile.buildingTarget)
              const left = Math.max(0, tile.buildingTarget - tile.buildingProgress)
              return (
                <HudButton
                  key={`${tile.x}-${tile.y}`}
                  type="button"
                  variant="ghost"
                  onClick={() => showOnMap(tile)}
                  className="min-h-11 hover-lift w-[88%] shrink-0 snap-start rounded-lg border border-amber/25 bg-amber/5 px-3 py-2 text-left transition hover:border-amber/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/50 min-[1181px]:w-full"
                >
                  <span className="flex items-center justify-between gap-2 text-[0.8125rem]">
                    <strong className="inline-flex min-w-0 items-center gap-1.5 truncate text-bone">
                      <LiveDot className="text-amber" />
                      <span className="truncate">{tile.name || facilityTypeLabel(tile)}</span>
                    </strong>
                    <StatusChip tone="warning">{left}d</StatusChip>
                  </span>
                  <div className="mt-2">
                    <MeterBar value={progress} tone="train" live detail={`${Math.round(progress * 100)}%`} />
                  </div>
                </HudButton>
              )
            })}
          </div>
        </GameCard>
      ) : null}

      <HudButton type="button" variant="secondary" className="w-full" onClick={() => setCommandView('sites')}>
        Open sites intel
      </HudButton>
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
    .map((hall) => ({
      hall,
      spaces: quoteRackDeployment(state, skuId, [
        { x: hall.x, y: hall.y },
      ]).plannedCabinets,
    }))
    .filter(({ spaces }) => spaces > 0)
  const targets = deployableHalls
    .filter(({ hall }) => !excluded.has(`${hall.x},${hall.y}`))
    .map(({ hall }) => ({ x: hall.x, y: hall.y }))
  const quote = quoteRackDeployment(state, skuId, targets)
  const sku = resolveRackSku(skuId, state.player.rackDesigns)
  const quantity =
    quote.maxRacks > 0 ? Math.max(1, Math.min(requested ?? quote.maxRacks, quote.maxRacks)) : 0
  const fullOrder =
    quote.canFillPlanned && quantity === quote.plannedCabinets

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
    blockers.push({
      text: 'No deployable quantity — add compatible physical cabinet footprints, then check supply and cash.',
    })
  }

  return (
    <GameCard
      eyebrow="Deployment"
      title="Deploy capacity"
      mobileSummary={`${quote.maxRacks} racks can ship now`}
      tone="mint"
      actions={<StatusChip tone="positive">{quote.marketAvailable} avail</StatusChip>}
    >
      <p className="mb-2 text-[0.8125rem] text-muted">
        {sku.name} across selected halls. Supply and cash cap the order.
      </p>
      <div className="rounded-lg border border-line/70 bg-void/35 p-2">
        <div className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
          <div className="min-w-0">
            <span className="hud-eyebrow">Target halls</span>
            <strong className="mt-0.5 block truncate text-[0.8125rem] text-bone">
              {deployableHalls.length === 0
                ? 'No halls with planned cabinet space'
                : `${quote.selectedHalls} of ${deployableHalls.length} · ${quote.plannedCabinets} planned cabinets`}
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
            <span className="shrink-0 font-mono tabular-nums text-mint">{deployableHalls[0]!.spaces} planned</span>
          </div>
        ) : chooserOpen ? (
          <div className="mt-2 space-y-1 border-t border-line/60 pt-2">
            <div className="mb-1 flex justify-end gap-1">
              <HudButton
                type="button"
                variant="ghost"
                onClick={() => {
                  setExcluded(new Set())
                  setRequested(null)
                }}
                className="min-h-11 rounded-md px-2 py-1 text-[0.6875rem] text-mint hover:bg-mint/10 sm:min-h-0"
              >
                Select all
              </HudButton>
              <HudButton
                type="button"
                variant="ghost"
                onClick={() => {
                  setExcluded(new Set(deployableHalls.map(({ hall }) => `${hall.x},${hall.y}`)))
                  setRequested(null)
                }}
                className="min-h-11 rounded-md px-2 py-1 text-[0.6875rem] text-muted hover:bg-panel-2 hover:text-bone sm:min-h-0"
              >
                Clear
              </HudButton>
            </div>
            {deployableHalls.map(({ hall, spaces }) => {
              const key = `${hall.x},${hall.y}`
              const selected = !excluded.has(key)
              return (
                <HudButton
                  key={key}
                  type="button"
                  variant="ghost"
                  aria-pressed={selected}
                  onClick={() => toggleHall(hall)}
                  className={`flex min-h-11 w-full items-center justify-between rounded-md border px-2 py-1.5 text-[0.6875rem] transition ${
                    selected
                      ? 'border-mint/40 bg-mint/10 text-bone'
                      : 'border-line/70 bg-panel-2/50 text-muted'
                  }`}
                >
                  <span className="truncate">{hall.name || 'Data center'}</span>
                  <span className="shrink-0 font-mono tabular-nums">{spaces} planned</span>
                </HudButton>
              )
            })}
          </div>
        ) : null}
      </div>

      <DeploymentLimitSummary
        plannedCabinets={quote.plannedCabinets}
        affordableRacks={quote.affordableRacks}
        maxRacks={quote.maxRacks}
      />

      {quote.maxRacks > 0 ? (
        <>
          <label className="mt-2 block text-[0.8125rem] text-muted">
            Quantity <strong className="font-mono tabular-nums text-bone">{quantity}</strong> racks ·{' '}
            {quantity * quote.rackUnits} rack-width units
            <HudRange
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
              ? `Fill all planned cabinets · ${quantity} racks`
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

export function DeploymentLimitSummary({
  plannedCabinets,
  affordableRacks,
  maxRacks,
}: {
  plannedCabinets: number
  affordableRacks: number
  maxRacks: number
}) {
  return (
    <div className="mt-2 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-3">
      <MetricTile
        label="Physical destinations"
        value={`${plannedCabinets} cabinets`}
      />
      <MetricTile label="Cash limit" value={`${affordableRacks} racks`} />
      <div className="min-[420px]:col-span-2 sm:col-span-1">
        <MetricTile label="Order ceiling" value={`${maxRacks} racks`} tone="positive" />
      </div>
    </div>
  )
}
