import {
  getBuildDef,
  isBuildableKind,
  isDcAnchor,
  isDcKind,
  isScenicKind,
  ownerLabel,
  scenicLabel,
} from '../../../sim/systems/map'
import {
  cancelConstruction,
  constructionFastTrackQuote,
  estimateBuildingSaleValue,
  estimateCancelRefund,
  fastTrackConstruction,
  sellPlayerBuilding,
} from '../../../sim/systems/facilities'
import { useGameStore } from '../../../store/gameStore'
import { money, num } from '../format'
import { BuildingNameField } from '../ui/BuildingNameField'
import { useUiStore } from '../../../store/uiStore'
import {
  facilityFootprintTiles,
  mapTileAtAny,
} from '../../../sim/systems/worldAccess'
import { ECONOMY } from '../../../sim/balance/economy'
import { InfrastructureOverview } from './InfrastructureOverview'

function dcSizeLabel(kind: string, size?: string): string {
  if (size === 'small' || kind === 'dc') return 'Small · 1 tile · 96 bays'
  if (size === 'medium' || kind === 'dc_m') return 'Medium · 4 tiles · 288 bays'
  if (size === 'large' || kind === 'dc_l') return 'Large · 6 tiles · 960 bays'
  return kind
}

function tileTypeLabel(kind: string): string {
  if (isDcKind(kind)) {
    const def = getBuildDef(kind as 'dc' | 'dc_m' | 'dc_l')
    return def?.label ?? kind
  }
  if (isBuildableKind(kind as never)) {
    return getBuildDef(kind as never)?.label ?? kind
  }
  if (isScenicKind(kind as never)) return scenicLabel(kind as never)
  if (kind === 'empty') return 'Open land'
  return kind
}

export function MapPanel() {
  const selected = useGameStore((s) => s.selectedTile)
  const state = useGameStore((s) => s.state)
  const upgradeBuilding = useGameStore((s) => s.upgradeBuilding)

  const tile = selected ? mapTileAtAny(state, selected.x, selected.y) : undefined
  const region = tile && state.map.regions.find((r) => r.id === tile.regionId)
  const isOurs = tile && tile.owner === 'player'
  const isRival = tile && tile.owner !== 'player' && tile.owner !== 'neutral'
  const constructing =
    tile && tile.buildingTarget > 0 && tile.buildingProgress < tile.buildingTarget
  const isLiveDc =
    tile &&
    isOurs &&
    isDcKind(tile.kind) &&
    isDcAnchor(tile) &&
    !constructing &&
    tile.buildingProgress >= tile.buildingTarget
  const isDcPad =
    tile && isDcKind(tile.kind) && tile.campusRole === 'pad'
  const campusTiles =
    tile?.campusId
      ? facilityFootprintTiles(state, tile.campusId)
      : []

  return (
    <div className="space-y-4">
      <div>
        <h2 className="hud-panel-title">Overview</h2>
        <p className="hud-panel-sub">
          Fleet, construction, and every facility in one command view. Select the map for parcel
          details or open a facility’s dedicated controls.
        </p>
      </div>

      <InfrastructureOverview />

      {tile && tile.kind !== 'empty' && (
        <div
          className={`rounded-2xl border p-3 text-xs ${
            isOurs
              ? 'border-mint/35 bg-mint/5'
              : isRival
                ? 'border-amber/30 bg-amber/5'
                : 'border-line bg-panel-2'
          }`}
        >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[0.75rem] text-muted">
                  {region?.name ?? 'void'}
                  {isBuildableKind(tile.kind) ? ` · ${tileTypeLabel(tile.kind)}` : ''}
                </div>
                <div className="mt-0.5">
                  {isOurs && isBuildableKind(tile.kind) ? (
                    <BuildingNameField tile={tile} />
                  ) : (
                    <div className="text-sm font-medium text-bone">
                      {tile.name || tileTypeLabel(tile.kind)}
                    </div>
                  )}
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[0.75rem] ${
                  isOurs
                    ? 'bg-mint/20 text-mint'
                    : isRival
                      ? 'bg-amber/20 text-amber'
                      : 'bg-line text-muted'
                }`}
              >
                {ownerLabel(tile.owner, state)}
              </span>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[0.75rem] text-muted">
              <span>Type</span>
              <span className="text-right text-bone">{tileTypeLabel(tile.kind)}</span>
              {isDcKind(tile.kind) && (
                <>
                  <span>Size class</span>
                  <span className="text-right text-bone">
                    {dcSizeLabel(tile.kind, tile.dcSize)}
                  </span>
                  <span>Campus role</span>
                  <span className="text-right text-bone">
                    {tile.campusRole === 'pad' ? 'Footprint pad' : 'Anchor (racks)'}
                  </span>
                  {campusTiles.length > 1 && (
                    <>
                      <span>Campus tiles</span>
                      <span className="text-right text-bone">{campusTiles.length}</span>
                    </>
                  )}
                </>
              )}
              {!isScenicKind(tile.kind) && (
                <>
                  <span>Level</span>
                  <span className="text-right text-bone">L{tile.level}</span>
                </>
              )}
              {isDcKind(tile.kind) && isDcAnchor(tile) && (
                <>
                  <span>Bay slots</span>
                  <span className="text-right text-bone">
                    {tile.racksUsed}/{tile.rackCapacity}
                  </span>
                  <span>Powered</span>
                  <span className={`text-right ${tile.powered === false ? 'text-danger' : 'text-mint'}`}>
                    {tile.powered === false ? 'Down' : 'On'}
                  </span>
                </>
              )}
              {isDcPad && (
                <>
                  <span>Bays</span>
                  <span className="text-right text-muted">On campus anchor</span>
                </>
              )}
              {(tile.mwCapacity > 0 || tile.mwGeneration > 0) && (
                <>
                  <span>Power</span>
                  <span className="text-right text-bone">
                    {tile.mwCapacity > 0 ? `${num(tile.mwCapacity, 1)} MW grid` : ''}
                    {tile.mwCapacity > 0 && tile.mwGeneration > 0 ? ' · ' : ''}
                    {tile.mwGeneration > 0 ? `${num(tile.mwGeneration, 1)} MW gen` : ''}
                  </span>
                </>
              )}
              {tile.capex > 0 && (
                <>
                  <span>Capex sunk</span>
                  <span className="text-right text-bone">{money(tile.capex)}</span>
                </>
              )}
              {tile.opexPerDay > 0 && isOurs && (
                <>
                  <span>Opex</span>
                  <span className="text-right text-bone">
                    {money(tile.opexPerDay * (ECONOMY.facilityOpexMultiplier ?? 1))}/d
                  </span>
                </>
              )}
              {region && (
                <>
                  <span>Energy mult</span>
                  <span className="text-right text-bone">×{region.energyPriceMult.toFixed(2)}</span>
                  <span>Latency</span>
                  <span className="text-right text-bone">
                    {(region.latencyToMarket * 100).toFixed(0)} (lower better)
                  </span>
                </>
              )}
            </div>

            {tile.note && (
              <p className="mt-2 text-[0.8125rem] leading-snug text-muted">{tile.note}</p>
            )}

            {constructing && (
              <p className="mt-2 text-[0.8125rem] text-amber">
                Under construction — track progress in{' '}
                <button
                  type="button"
                  className="text-mint"
                  onClick={() => useGameStore.getState().openFleet()}
                >
                  Infrastructure → Racks
                </button>
                .
              </p>
            )}

            {isScenicKind(tile.kind) && (
              <p className="mt-2 rounded-lg border border-line bg-void/40 px-2.5 py-2 text-[0.8125rem] leading-snug text-muted">
                Scenic {scenicLabel(tile.kind).toLowerCase()} — not a buildable parcel. Choose open
                land (empty plot) for data halls and power.
              </p>
            )}

            {isOurs &&
              !constructing &&
              isBuildableKind(tile.kind) &&
              (!isDcKind(tile.kind) || isDcAnchor(tile)) &&
              tile.level < 5 && (
                <button
                  type="button"
                  className="btn-ghost mt-3 w-full py-2"
                  onClick={() => upgradeBuilding()}
                >
                  Upgrade to L{tile.level + 1}
                  {(() => {
                    const d = getBuildDef(tile.kind)
                    const c = d.upgradeCash ?? d.cash * 0.45
                    return ` · ${money(c)}`
                  })()}
                </button>
              )}

            {isLiveDc && (
              <button
                type="button"
                className="btn-ghost mt-3 w-full py-2 text-mint"
                onClick={() => useGameStore.getState().openFleet()}
              >
                Order racks in Infrastructure →
              </button>
            )}

            {isOurs && isBuildableKind(tile.kind) && (
              <BuildingDisposeButtons x={tile.x} y={tile.y} constructing={!!constructing} />
            )}

            {isRival && (
              <p className="mt-2 text-[0.75rem] text-amber">
                Rival campus — you cannot build here. Compete on models and price instead.
              </p>
            )}
        </div>
      )}

    </div>
  )
}

export function BuildingDisposeButtons({
  x,
  y,
  constructing,
  compact,
}: {
  x: number
  y: number
  constructing: boolean
  compact?: boolean
}) {
  const state = useGameStore((s) => s.state)
  const setState = (next: typeof state) => useGameStore.setState({ state: next })
  const requestConfirm = useUiStore((s) => s.requestConfirm)
  const refund = constructing
    ? estimateCancelRefund(state, x, y)
    : estimateBuildingSaleValue(state, x, y)
  const fastTrack = constructing ? constructionFastTrackQuote(state, x, y) : null
  const cls = compact
    ? 'rounded-lg px-2 py-1 text-[0.75rem]'
    : 'btn-ghost mt-2 w-full py-2 text-[0.8125rem]'

  if (constructing) {
    return (
      <div className={compact ? 'flex flex-wrap gap-1.5' : 'space-y-1.5'}>
        {fastTrack ? (
          <button
            type="button"
            disabled={!fastTrack.eligible || state.player.cash < fastTrack.cost}
            title={
              fastTrack.eligible && state.player.cash < fastTrack.cost
                ? `Need ${money(fastTrack.cost)} to fast-track.`
                : fastTrack.reason ?? 'Pay 50% extra capex to halve the remaining schedule.'
            }
            className={`${compact ? 'rounded-lg px-2 py-1 text-[0.75rem]' : 'btn-primary w-full py-2 text-[0.8125rem]'} border border-mint/35 text-mint hover:bg-mint/10 disabled:cursor-not-allowed disabled:opacity-45`}
            onClick={(e) => {
              e.stopPropagation()
              setState(fastTrackConstruction(state, x, y))
            }}
          >
            {fastTrack.eligible
              ? `Fast-track +50% · ${money(fastTrack.cost)} · ${fastTrack.remainingDays}d → ${fastTrack.acceleratedDays}d`
              : fastTrack.reason?.includes('already fast-tracked')
                ? 'Fast-track active'
                : 'Fast-track unavailable'}
          </button>
        ) : null}
        <button
          type="button"
          className={`${cls} border border-amber/30 text-amber hover:bg-amber/10`}
          onClick={(e) => {
            e.stopPropagation()
            requestConfirm({
              title: 'Cancel this construction?',
              body: `The lab will recover approximately ${money(refund)}. Work already completed is only partly refunded.`,
              actionLabel: 'Cancel construction',
              tone: 'warning',
              onConfirm: () => setState(cancelConstruction(state, x, y)),
            })
          }}
        >
          Cancel build · ~{money(refund)}
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      className={`${cls} border border-danger/30 text-danger hover:bg-danger/10`}
      onClick={(e) => {
        e.stopPropagation()
        requestConfirm({
          title: 'Sell this building?',
          body: `Estimated recovery is ${money(refund)}. Multi-tile campuses clear fully and installed racks sell with data halls.`,
          actionLabel: 'Sell building',
          tone: 'danger',
          onConfirm: () => setState(sellPlayerBuilding(state, x, y)),
        })
      }}
    >
      Sell · ~{money(refund)}
    </button>
  )
}
