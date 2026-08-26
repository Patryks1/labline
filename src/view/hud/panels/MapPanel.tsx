import {
  getBuildDef,
  isBuildableKind,
  isDcAnchor,
  isDcKind,
  isHqAnchor,
  isHqKind,
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
import { quoteFacilityDemolition } from '../../../sim/systems/facilityMarket'
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
import { OverviewGovernance } from './OverviewGovernance'
import { EmptyState, HudButton, PanelScaffold, StatusChip } from '../ui/HudPrimitives'
import { BlockerList, GameCard, LiveDot, MeterBar, StatRow } from '../ui/kit'

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
  const isLiveHq =
    tile &&
    isOurs &&
    isHqKind(tile.kind) &&
    isHqAnchor(tile) &&
    !constructing &&
    tile.buildingProgress >= tile.buildingTarget
  const isDcPad = tile && isDcKind(tile.kind) && tile.campusRole === 'pad'
  const campusTiles = tile?.campusId ? facilityFootprintTiles(state, tile.campusId) : []
  const upgradeDef = tile && isBuildableKind(tile.kind) ? getBuildDef(tile.kind) : null
  const upgradeCost = upgradeDef ? (upgradeDef.upgradeCash ?? upgradeDef.cash * 0.45) : 0
  const canUpgrade =
    Boolean(
      isOurs &&
        !constructing &&
        tile &&
        isBuildableKind(tile.kind) &&
        (!isDcKind(tile.kind) || isDcAnchor(tile)) &&
        tile.level < 5,
    )
  const upgradeBlockers = [
    ...(state.player.cash < upgradeCost
      ? [{ text: `Need ${money(upgradeCost - state.player.cash)} more cash`, tone: 'danger' as const }]
      : []),
  ]

  return (
    <PanelScaffold
      eyebrow="Infrastructure"
      title="Overview"
      description="Fleet capacity, construction, and the selected parcel. Sites live in intel."
    >
      <div className="space-y-3">
        {tile && tile.kind !== 'empty' ? (
          <GameCard
            tone={isOurs ? 'mint' : isRival ? 'train' : undefined}
            live={Boolean(constructing)}
            eyebrow={region?.name ?? 'void'}
            title={
              isOurs && isBuildableKind(tile.kind) ? (
                <BuildingNameField tile={tile} />
              ) : (
                tile.name || tileTypeLabel(tile.kind)
              )
            }
            actions={
              <StatusChip tone={isOurs ? 'positive' : isRival ? 'warning' : 'neutral'}>
                {ownerLabel(tile.owner, state)}
              </StatusChip>
            }
          >
            <div className="space-y-1" aria-label="Selected building essentials">
              <StatRow label="Type" value={tileTypeLabel(tile.kind)} />
              {!isScenicKind(tile.kind) ? <StatRow label="Level" value={`L${tile.level}`} /> : null}
              {isDcKind(tile.kind) && isDcAnchor(tile) ? (
                <>
                  <StatRow label="Bay slots" value={`${tile.racksUsed}/${tile.rackCapacity}`} />
                  <StatRow
                    label="Powered"
                    value={tile.powered === false ? 'Down' : 'On'}
                    tone={tile.powered === false ? 'danger' : 'positive'}
                  />
                </>
              ) : null}
              {isDcPad ? <StatRow label="Bays" value="On campus anchor" /> : null}
              {(tile.mwCapacity > 0 || tile.mwGeneration > 0) && (
                <StatRow
                  label="Power"
                  value={[
                    tile.mwCapacity > 0 ? `${num(tile.mwCapacity, 1)} MW grid` : '',
                    tile.mwGeneration > 0 ? `${num(tile.mwGeneration, 1)} MW gen` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              )}
              {tile.opexPerDay > 0 && isOurs ? (
                <StatRow
                  label="Opex"
                  value={`${money(tile.opexPerDay * (ECONOMY.facilityOpexMultiplier ?? 1))}/d`}
                />
              ) : null}
            </div>

            {isDcKind(tile.kind) || tile.capex > 0 || region || tile.note ? (
              <details className="mt-3 rounded-md border border-line/60 bg-void/30">
                <summary className="flex min-h-11 cursor-pointer touch-manipulation items-center px-3 text-[0.75rem] font-semibold text-muted">
                  Site details
                </summary>
                <div className="space-y-1 border-t border-line/50 px-3 py-2">
                  {isDcKind(tile.kind) ? (
                    <>
                      <StatRow label="Size" value={dcSizeLabel(tile.kind, tile.dcSize)} />
                      <StatRow
                        label="Campus role"
                        value={tile.campusRole === 'pad' ? 'Footprint pad' : 'Anchor (racks)'}
                      />
                      {campusTiles.length > 1 ? (
                        <StatRow label="Campus tiles" value={String(campusTiles.length)} />
                      ) : null}
                    </>
                  ) : null}
                  {tile.capex > 0 ? <StatRow label="Capex sunk" value={money(tile.capex)} /> : null}
                  {region ? (
                    <>
                      <StatRow label="Energy cost" value={`×${region.energyPriceMult.toFixed(2)}`} />
                      <StatRow
                        label="Latency"
                        value={`${(region.latencyToMarket * 100).toFixed(0)} · lower is better`}
                      />
                    </>
                  ) : null}
                  {tile.note ? (
                    <p className="pt-1 text-[0.75rem] leading-snug text-muted">{tile.note}</p>
                  ) : null}
                </div>
              </details>
            ) : null}

            {constructing ? (
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-2 text-[0.8125rem] text-amber">
                  <LiveDot className="text-amber" />
                  <span>Under construction</span>
                </div>
                <MeterBar
                  label="Build progress"
                  value={tile.buildingProgress / Math.max(1, tile.buildingTarget)}
                  detail={`${tile.buildingProgress}/${tile.buildingTarget}d`}
                  tone="warning"
                  live
                />
                <HudButton
                  type="button"
                  variant="ghost"
                  className="w-full !min-h-11"
                  onClick={() => useGameStore.getState().openFleet()}
                >
                  Track in fleet
                </HudButton>
              </div>
            ) : null}

            {isScenicKind(tile.kind) ? (
              <p className="mt-3 rounded-md border border-line/70 bg-void/40 px-2.5 py-2 text-[0.8125rem] leading-snug text-muted">
                Scenic {scenicLabel(tile.kind).toLowerCase()} — pick open land to build.
              </p>
            ) : null}

            {canUpgrade ? (
              <div className="mt-3 space-y-2">
                <BlockerList items={upgradeBlockers} />
                <HudButton
                  type="button"
                  variant="secondary"
                  className="w-full !min-h-11"
                  disabled={state.player.cash < upgradeCost}
                  title={
                    state.player.cash < upgradeCost
                      ? `Need ${money(upgradeCost - state.player.cash)} more cash`
                      : undefined
                  }
                  onClick={() => upgradeBuilding()}
                >
                  Upgrade to L{tile.level + 1} · {money(upgradeCost)}
                </HudButton>
              </div>
            ) : null}

            {isLiveDc ? (
              <HudButton
                type="button"
                variant="ghost"
                className="mt-3 w-full !min-h-11 text-mint"
                onClick={() =>
                  useGameStore
                    .getState()
                    .openHallEditor(tile.campusId ?? `facility:${tile.x},${tile.y}`)
                }
              >
                Open hall editor →
              </HudButton>
            ) : null}

            {isLiveHq ? (
              <HudButton
                type="button"
                variant="ghost"
                className="mt-3 w-full !min-h-11 text-mint"
                onClick={() =>
                  useGameStore
                    .getState()
                    .openHqOfficeEditor(tile.campusId ?? `facility:${tile.x},${tile.y}`)
                }
              >
                Open HQ office editor →
              </HudButton>
            ) : null}

            {isOurs && isBuildableKind(tile.kind) ? (
              <div className="mt-3">
                <BuildingDisposeButtons x={tile.x} y={tile.y} constructing={!!constructing} />
              </div>
            ) : null}

            {isRival ? (
              <p className="mt-3 text-[0.75rem] text-amber">
                Rival campus — compete on models and price instead.
              </p>
            ) : null}
          </GameCard>
        ) : (
          <EmptyState
            title="No parcel selected"
            description="Tap the map for parcel details, or manage facilities below."
          />
        )}

        <InfrastructureOverview />
        <OverviewGovernance state={state} />
      </div>
    </PanelScaffold>
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
  const demolishFacility = useGameStore((s) => s.demolishFacility)
  const tile = mapTileAtAny(state, x, y)
  const isCompletedDc = Boolean(
    tile && isDcKind(tile.kind) && !constructing && tile.buildingProgress >= tile.buildingTarget,
  )
  const facilityId = tile?.campusId ?? `facility:${x},${y}`
  const demolitionCost = isCompletedDc ? quoteFacilityDemolition(state, facilityId) : 0
  const refund = constructing
    ? estimateCancelRefund(state, x, y)
    : estimateBuildingSaleValue(state, x, y)
  const fastTrack = constructing ? constructionFastTrackQuote(state, x, y) : null

  if (constructing) {
    const fastTrackBlocked =
      !fastTrack?.eligible || (fastTrack != null && state.player.cash < fastTrack.cost)
    const fastTrackReason =
      fastTrack && !fastTrack.eligible
        ? fastTrack.reason ?? 'Fast-track unavailable'
        : fastTrack && state.player.cash < fastTrack.cost
          ? `Need ${money(fastTrack.cost)} to fast-track`
          : undefined

    return (
      <div className={compact ? 'flex flex-wrap gap-1.5' : 'space-y-1.5'}>
        {fastTrack ? (
          <div className={compact ? '' : 'space-y-1.5'}>
            {!compact && fastTrackBlocked && fastTrackReason ? (
              <BlockerList items={[{ text: fastTrackReason, tone: 'warning' }]} />
            ) : null}
            <HudButton
              type="button"
              variant="primary"
              disabled={fastTrackBlocked}
              title={fastTrackReason ?? 'Pay 50% extra capex to halve the remaining schedule.'}
              className={compact ? 'px-2 py-1 text-[0.75rem]' : 'w-full !min-h-11'}
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
            </HudButton>
          </div>
        ) : null}
        <HudButton
          type="button"
          variant="danger"
          className={compact ? 'px-2 py-1 text-[0.75rem]' : 'w-full !min-h-11'}
          onClick={(e) => {
            e.stopPropagation()
            requestConfirm({
              title: 'Cancel this construction?',
              body: `The lab will recover approximately ${money(refund)}. Work already completed is only partly refunded.`,
              actionLabel: 'Cancel construction',
              tone: 'danger',
              onConfirm: () => setState(cancelConstruction(state, x, y)),
            })
          }}
        >
          Cancel build · ~{money(refund)}
        </HudButton>
      </div>
    )
  }

  return (
    <div className={isCompletedDc ? 'grid grid-cols-2 gap-1.5' : ''}>
      <HudButton
        type="button"
        variant="danger"
        className={compact ? 'px-2 py-1 text-[0.75rem]' : 'w-full !min-h-11'}
        onClick={(e) => {
          e.stopPropagation()
          requestConfirm({
            title: 'Sell this building?',
            body: `Estimated recovery is ${money(refund)}. Multi-tile campuses clear fully and installed racks sell with data halls.`,
            actionLabel: 'Sell building',
            tone: 'danger',
            onConfirm: () => setState(sellPlayerBuilding(useGameStore.getState().state, x, y)),
          })
        }}
      >
        Sell · ~{money(refund)}
      </HudButton>
      {isCompletedDc ? (
        <HudButton
          type="button"
          variant="danger"
          disabled={state.player.cash < demolitionCost}
          title={state.player.cash < demolitionCost ? `Need ${money(demolitionCost)} to demolish` : undefined}
          className={`${compact ? 'px-2 py-1 text-[0.75rem]' : 'w-full !min-h-11'} border border-danger/35`}
          onClick={(e) => {
            e.stopPropagation()
            requestConfirm({
              title: 'Demolish this data centre?',
              body: `Demolition costs ${money(demolitionCost)}, removes the full campus and all installed racks, and returns no sale proceeds.`,
              actionLabel: 'Demolish facility',
              tone: 'danger',
              onConfirm: () => demolishFacility(facilityId),
            })
          }}
        >
          Demolish · {money(demolitionCost)}
        </HudButton>
      ) : null}
    </div>
  )
}
