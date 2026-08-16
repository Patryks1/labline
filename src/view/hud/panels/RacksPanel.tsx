import { useMemo, useState } from 'react'
import {
  CHASSIS_CATALOG,
  MODULE_CATALOG,
  getModule,
  scoreDesign,
} from '../../../sim/balance/racks'
import {
  RACK_COMMISSION_PER_DAY,
  dcBayUsage,
} from '../../../sim/systems/dcRacks'
import {
  clearSlot,
  designToSku,
  emptyDesign,
  placeModule,
  saveRackDesign,
} from '../../../sim/systems/racks'
import { useGameStore } from '../../../store/gameStore'
import type { ModuleKind, RackDesign } from '../../../sim/types'
import { money, num, mw } from '../format'
import { isDcAnchor, isDcKind } from '../../../sim/systems/map'
import { BuildingNameField } from '../ui/BuildingNameField'
import { mapTileAtAny } from '../../../sim/systems/worldAccess'
import { facilityAnchorTiles } from '../../../sim/systems/worldAccess'
import {
  EmptyState,
  HudButton,
  HudInput,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from '../ui/HudPrimitives'
import {
  BlockerList,
  GameCard,
  MeterBar,
  StatRow,
} from '../ui/kit'
import { fleetStats } from '../../../sim/systems/racks'
import {
  recommendRackDesigns,
  type RackDesignGoal,
} from '../../../sim/systems/rackLayouts'
import { facilityAcquisitionPresentation } from './hardware/facilityMarketPresentation'

const KIND_ORDER: ModuleKind[] = ['gpu', 'ram', 'cpu', 'cooling', 'psu', 'nic']

/** Gamified hall tier from live compute. */
function hallTier(flopsLive: number): { label: string; tone: 'positive' | 'warning' | 'neutral' } {
  if (flopsLive >= 300) return { label: 'Hyperscale', tone: 'positive' }
  if (flopsLive >= 50) return { label: 'Production', tone: 'warning' }
  if (flopsLive > 0) return { label: 'Starter', tone: 'neutral' }
  return { label: 'Empty shell', tone: 'neutral' }
}

export function RacksPanel() {
  const state = useGameStore((s) => s.state)
  const selected = useGameStore((s) => s.selectedTile)
  const tab = useGameStore((s) => s.rackWorkspaceTab)
  const setTab = useGameStore((s) => s.setRackWorkspaceTab)
  const submitFacilityOffer = useGameStore((s) => s.submitFacilityOffer)
  const withdrawFacilityOffer = useGameStore((s) => s.withdrawFacilityOffer)
  const acceptFacilityOffer = useGameStore((s) => s.acceptFacilityOffer)
  const buyRivalDataCenter = useGameStore((s) => s.buyRivalDataCenter)
  const setState = (s: typeof state) => useGameStore.setState({ state: s })
  const focusMapTile = useGameStore((s) => s.focusMapTile)
  const openHallEditor = useGameStore((s) => s.openHallEditor)
  const fleet = fleetStats(state)

  const tile = selected ? mapTileAtAny(state, selected.x, selected.y) : undefined
  const isRivalDc =
    tile != null &&
    isDcKind(tile.kind) &&
    isDcAnchor(tile) &&
    tile.owner !== 'player' &&
    tile.owner !== 'neutral'

  const hallCards = useMemo(
    () =>
      facilityAnchorTiles(state, { ownerId: 'player' })
        .filter((hall) => isDcKind(hall.kind) && isDcAnchor(hall))
        .map((hall) => {
          const built = hall.buildingProgress >= hall.buildingTarget
          const usage = built ? dcBayUsage(state, hall.x, hall.y) : null
          const facilityId = hall.campusId ?? `facility:${hall.x},${hall.y}`
          const offline =
            state.dataHallLayouts?.[facilityId]?.analysis.offlineRackUnitIds
              .length ?? 0
          return { hall, built, usage, facilityId, offline }
        })
        .toSorted(
          (a, b) =>
            (b.usage?.flopsLive ?? 0) - (a.usage?.flopsLive ?? 0) ||
            a.hall.name.localeCompare(b.hall.name),
        ),
    [state],
  )
  const totals = useMemo(() => {
    let online = 0
    let commissioning = 0
    let offline = 0
    for (const card of hallCards) {
      online += card.usage?.live ?? 0
      commissioning += card.usage?.ordered ?? 0
      offline += card.offline
    }
    return {
      online,
      commissioning,
      offline,
      commissioningDays:
        commissioning > 0
          ? Math.ceil(commissioning / RACK_COMMISSION_PER_DAY)
          : 0,
    }
  }, [hallCards])

  const [autoDesignGoal, setAutoDesignGoal] = useState<RackDesignGoal>('balanced')
  const [design, setDesign] = useState<RackDesign>(() => emptyDesign('case_8u', 'My Node'))
  const [selectedModule, setSelectedModule] = useState('gpu_h100')
  const [msg, setMsg] = useState('')
  const [facilityBidMillions, setFacilityBidMillions] = useState('')
  const stats = useMemo(() => scoreDesign(design), [design])
  const chassis = CHASSIS_CATALOG.find((c) => c.id === design.chassisId)!
  const autoDesigns = useMemo(
    () => recommendRackDesigns({ goal: autoDesignGoal, limit: 3 }),
    [autoDesignGoal],
  )
  const selectedOwner = isRivalDc ? state.rivals.find((r) => r.id === tile?.owner) : null
  const intelConfidence = selectedOwner?.publicEstimate?.confidence ?? 0
  const intelLevel = intelConfidence < 0.28 ? 'unknown' : intelConfidence < 0.72 ? 'estimate' : 'exact'
  const selectedFacilityId = tile?.campusId ?? (tile ? `facility:${tile.x},${tile.y}` : '')
  const activeFacilityOffer = state.facilityMarket?.offers.find(
    (offer) =>
      offer.facilityId === selectedFacilityId &&
      offer.buyerLabId === state.playerLabId &&
      (offer.status === 'pending' || offer.status === 'countered'),
  )
  const facilityAcquisition = tile
    ? facilityAcquisitionPresentation(tile, activeFacilityOffer)
    : { mode: 'bid' as const }

  const onSlotClick = (slotId: string) => {
    const occupied = design.placements.find((p) => p.slotId === slotId)
    if (occupied) {
      setDesign(clearSlot(design, slotId))
      setMsg('Cleared bay')
      return
    }
    const res = placeModule(design, slotId, selectedModule)
    if (res.error) {
      setMsg(res.error)
      return
    }
    setDesign(res.design)
    setMsg(`Placed ${getModule(selectedModule).name}`)
  }

  return (
    <PanelScaffold
      eyebrow="Hardware"
      title="Racks"
      description="Your data halls at a glance — open a hall editor to place racks, or design a custom blueprint."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile label="Fleet PF" value={num(fleet.flopsPf, 1)} tone="positive" />
          <MetricTile label="Racks online" value={num(totals.online, 0)} />
          <MetricTile
            label="Commissioning"
            value={num(totals.commissioning, 0)}
            detail={
              totals.commissioning > 0
                ? `${RACK_COMMISSION_PER_DAY}/day · ~${totals.commissioningDays}d left`
                : 'idle'
            }
            tone={totals.commissioning > 0 ? 'warning' : 'neutral'}
          />
          <MetricTile label="Fleet draw" value={mw(fleet.mw)} detail={`${num(fleet.vramGb, 0)} GB VRAM`} />
        </div>

        <div className="grid grid-cols-2 gap-1" role="group" aria-label="Racks workspace">
          <HudButton
            type="button"
            variant={tab === 'fleet' ? 'primary' : 'ghost'}
            aria-pressed={tab === 'fleet'}
            className="min-h-11"
            onClick={() => setTab('fleet')}
          >
            Halls ({hallCards.length})
          </HudButton>
          <HudButton
            type="button"
            variant={tab === 'blueprints' ? 'primary' : 'ghost'}
            aria-pressed={tab === 'blueprints'}
            className="min-h-11"
            onClick={() => setTab('blueprints')}
          >
            Blueprints ({state.player.rackDesigns.length})
          </HudButton>
        </div>

        <div key={tab === 'blueprints' ? 'blueprints' : 'fleet'} className="panel-swap">
          {tab !== 'blueprints' ? (
            <div className="space-y-3">
              {isRivalDc && tile ? (
                <GameCard eyebrow={`${intelLevel} intelligence`} title={tile.name || `${selectedOwner?.name ?? 'Rival'} hall`} actions={<StatusChip tone={intelLevel === 'exact' ? 'positive' : 'warning'}>{Math.round(intelConfidence * 100)}% confidence</StatusChip>}>
                  <StatRow label="Rack inventory" value={intelLevel === 'unknown' ? 'Unknown' : intelLevel === 'estimate' ? `~${Math.round(tile.racksUsed / 8) * 8}` : tile.racksUsed} />
                  <StatRow label="Rack capacity" value={intelLevel === 'exact' ? tile.rackCapacity : intelLevel === 'estimate' ? `~${tile.rackCapacity || (tile.dcSize === 'large' ? 960 : tile.dcSize === 'medium' ? 288 : 96)}` : 'Unknown'} />
                  <p className="mt-2 text-[0.75rem] text-muted">Competitive intelligence is non-operational. Higher confidence resolves chassis patterns and exact counts.</p>
                  {activeFacilityOffer ? (
                    <div className="mt-3 space-y-2 rounded-lg border border-amber/30 bg-amber/5 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <StatusChip tone="warning">
                          {activeFacilityOffer.status === 'countered' ? 'Countered' : 'Offer pending'}
                        </StatusChip>
                        <span className="font-mono text-[0.75rem] text-bone">
                          {money(activeFacilityOffer.counterAmount ?? activeFacilityOffer.amount)}
                        </span>
                      </div>
                      <p className="text-[0.75rem] text-muted">
                        {money(activeFacilityOffer.escrow)} held in escrow
                        {activeFacilityOffer.status === 'pending'
                          ? ` · response due by day ${activeFacilityOffer.respondDay}`
                          : ' · seller counter awaiting your decision'}
                      </p>
                      <div className="flex gap-2">
                        <HudButton
                          type="button"
                          variant="ghost"
                          className="flex-1"
                          onClick={() => withdrawFacilityOffer(activeFacilityOffer.id)}
                        >
                          Withdraw
                        </HudButton>
                        {activeFacilityOffer.status === 'countered' ? (
                          <HudButton
                            type="button"
                            variant="primary"
                            className="flex-1"
                            disabled={state.player.cash < Math.max(0, (activeFacilityOffer.counterAmount ?? activeFacilityOffer.amount) - activeFacilityOffer.escrow)}
                            onClick={() => acceptFacilityOffer(activeFacilityOffer.id)}
                          >
                            Accept counter
                          </HudButton>
                        ) : null}
                      </div>
                    </div>
                  ) : facilityAcquisition.mode === 'listed' && tile.listPrice ? (
                    <HudButton
                      type="button"
                      variant="primary"
                      className="mt-3 w-full"
                      disabled={state.player.cash < tile.listPrice}
                      onClick={() => buyRivalDataCenter(tile.x, tile.y)}
                    >
                      Buy now · {money(tile.listPrice)}
                    </HudButton>
                  ) : (
                    <div className="mt-3 space-y-2">
                      <label className="block font-mono text-[0.6875rem] uppercase tracking-wider text-muted" htmlFor="facility-bid">
                        Offer amount ($M)
                      </label>
                      <HudInput
                        id="facility-bid"
                        type="number"
                        min="0.01"
                        step="0.1"
                        value={facilityBidMillions}
                        onChange={(event) => setFacilityBidMillions(event.target.value)}
                        placeholder="Enter a positive bid"
                        className="min-h-11 w-full font-mono text-sm"
                      />
                      <HudButton
                        type="button"
                        variant="primary"
                        className="w-full"
                        disabled={!(Number(facilityBidMillions) > 0) || state.player.cash < Number(facilityBidMillions) * 1_000_000}
                        onClick={() => {
                          const amount = Math.floor(Number(facilityBidMillions) * 1_000_000)
                          if (amount > 0) submitFacilityOffer(selectedFacilityId, amount)
                        }}
                      >
                        Submit cash-backed offer
                      </HudButton>
                    </div>
                  )}
                </GameCard>
              ) : null}

              {hallCards.length > 0 ? (
                <div className="anim-stagger space-y-2">
                  {hallCards.map(({ hall, built, usage, facilityId, offline }) => {
                    const tier = hallTier(usage?.flopsLive ?? 0)
                    const commissioning = usage?.ordered ?? 0
                    const commissioningDays = Math.ceil(commissioning / RACK_COMMISSION_PER_DAY)
                    const isSelected = tile?.x === hall.x && tile?.y === hall.y
                    return (
                      <GameCard
                        key={`${hall.x},${hall.y}`}
                        eyebrow={hall.dcSize ?? 'small'}
                        title={<BuildingNameField tile={hall} />}
                        tone={isSelected ? 'mint' : 'train'}
                        live={commissioning > 0}
                        actions={<StatusChip tone={tier.tone}>{tier.label}</StatusChip>}
                      >
                        {!built ? (
                          <>
                            <MeterBar
                              label="Under construction"
                              value={hall.buildingProgress / Math.max(1, hall.buildingTarget)}
                              detail={`${hall.buildingProgress}/${hall.buildingTarget}d`}
                              tone="warning"
                              live
                            />
                            <p className="mt-2 text-[0.75rem] text-muted">
                              {hall.buildingTarget - hall.buildingProgress} days until this hall is ready for racks.
                            </p>
                          </>
                        ) : usage ? (
                          <>
                            <div className="grid grid-cols-3 gap-2 font-mono text-[0.75rem] text-muted">
                              <span><b className="block text-bone">{usage.live}</b> online</span>
                              <span><b className="block text-bone">{usage.staged || '—'}</b> staged</span>
                              <span><b className="block text-bone">{usage.reserved || '—'}</b> planned footprint</span>
                            </div>
                            <div className="mt-2">
                              <MeterBar
                                label="Operational fit"
                                value={usage.live / Math.max(1, usage.placed)}
                                detail={`${usage.live}/${usage.placed} placed rack-width`}
                                tone="positive"
                                live={usage.staged > 0}
                              />
                            </div>
                            {commissioning > 0 ? (
                              <p className="mt-1.5 text-[0.75rem] text-amber">
                                Spinning up {commissioning} rack{commissioning === 1 ? '' : 's'} · {RACK_COMMISSION_PER_DAY}/day · ~{commissioningDays}d until fully on
                              </p>
                            ) : null}
                            {offline > 0 ? (
                              <p className="mt-1.5 text-[0.75rem] text-danger">
                                {offline} rack{offline === 1 ? '' : 's'} offline — needs power/network in the hall editor
                              </p>
                            ) : null}
                            <div className="mt-2 flex items-center justify-between font-mono text-[0.75rem] text-muted">
                              <span>{num(usage.flopsLive, 1)} PF</span>
                              <span>{mw(usage.mwLive)}</span>
                            </div>
                            <HudButton
                              type="button"
                              variant="primary"
                              className="mt-3 w-full"
                              onClick={() => {
                                focusMapTile(hall.x, hall.y)
                                openHallEditor(facilityId)
                              }}
                            >
                              Open hall editor
                            </HudButton>
                          </>
                        ) : null}
                      </GameCard>
                    )
                  })}
                </div>
              ) : (
                <EmptyState
                  title="No data halls yet"
                  description="Build a data center from Sites, then open its hall editor to place racks."
                />
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <GameCard eyebrow="Automation" title="Auto-design rack" tone="mint">
                <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="Auto-design goal">
                  {(['balanced', 'training', 'inference', 'memory'] as RackDesignGoal[]).map((goal) => (
                    <HudButton
                      key={goal}
                      type="button"
                      variant={autoDesignGoal === goal ? 'primary' : 'ghost'}
                      aria-pressed={autoDesignGoal === goal}
                      onClick={() => setAutoDesignGoal(goal)}
                      className={`min-h-11 rounded-md px-2.5 py-1 text-[0.75rem] capitalize transition ${autoDesignGoal === goal ? 'bg-mint text-void' : 'bg-void text-muted hover:text-bone'}`}
                    >{goal}
                    </HudButton>
                  ))}
                </div>
                <p className="mb-2 text-[0.75rem] text-muted">Recommendations are deterministic previews. Choosing one loads it into the editor; nothing is saved or ordered automatically.</p>
                <div className="space-y-1.5">
                  {autoDesigns.map((recommendation) => (
                    <HudButton
                      key={recommendation.blueprint.id}
                      type="button"
                      variant="ghost"
                      className="w-full rounded-lg border border-line/70 bg-void/45 px-2.5 py-2 text-left transition hover:border-mint/45"
                      onClick={() => {
                        setDesign({ ...recommendation.blueprint, id: emptyDesign(recommendation.blueprint.chassisId).id })
                        setMsg(`Loaded ${autoDesignGoal} recommendation — review before saving`)
                      }}
                    >
                      <span className="flex items-center justify-between gap-2 text-[0.8125rem] text-bone">
                        <strong>{recommendation.blueprint.name}</strong>
                        <span className="font-mono text-mint">{recommendation.stats.flopsPf.toFixed(2)} PF</span>
                      </span>
                      <span className="mt-0.5 block text-[0.6875rem] text-muted">{recommendation.reason} · {money(recommendation.stats.buildCost)}</span>
                    </HudButton>
                  ))}
                </div>
              </GameCard>

              {state.player.rackDesigns.length > 0 ? (
                <div className="anim-stagger space-y-1.5">
                  {state.player.rackDesigns.map((d) => {
                    const sku = designToSku(d)
                    return (
                      <GameCard key={d.id} title={d.name} tone="mint">
                        <StatRow
                          label="Spec"
                          value={
                            sku
                              ? `${num(sku.flopsPf, 2)} PF · ${mw(sku.mw)} · ${money(sku.price)}`
                              : 'invalid'
                          }
                          tone={sku ? 'positive' : 'danger'}
                        />
                      </GameCard>
                    )
                  })}
                </div>
              ) : (
                <EmptyState title="No blueprints yet" description="Build a valid rack below, then save it as an orderable SKU." />
              )}

              <GameCard eyebrow="Designer" title="Custom rack" tone="mint">
                <div className="mb-2 flex flex-wrap gap-1">
                  {CHASSIS_CATALOG.map((c) => (
                    <HudButton
                      key={c.id}
                      type="button"
                      variant={design.chassisId === c.id ? 'primary' : 'ghost'}
                      onClick={() => {
                        setDesign(emptyDesign(c.id, design.name || c.name))
                        setMsg(`New ${c.name}`)
                      }}
                      className={`min-h-11 rounded-md px-2.5 py-1 text-[0.75rem] transition ${
                        design.chassisId === c.id ? 'bg-mint text-void' : 'bg-void text-muted hover:text-bone'
                      }`}
                    >
                      {c.name}
                    </HudButton>
                  ))}
                </div>
                <label className="block text-[0.8125rem] text-muted">
                  Blueprint name
                  <HudInput
                    value={design.name}
                    onChange={(e) => setDesign({ ...design, name: e.target.value })}
                    className="mt-0.5 w-full text-sm"
                  />
                </label>
                <div className="mt-2 rounded-lg border border-line/70 bg-void/60 p-2">
                  <p className="mb-2 text-[0.75rem] text-muted">{chassis.blurb}</p>
                  <div
                    className="relative mx-auto grid gap-1"
                    style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', maxWidth: 320 }}
                  >
                    {chassis.slots.map((slot) => {
                      const placed = design.placements.find((p) => p.slotId === slot.id)
                      const mod = placed ? getModule(placed.moduleId) : null
                      return (
                        <HudButton
                          key={slot.id}
                          type="button"
                          variant="ghost"
                          onClick={() => onSlotClick(slot.id)}
                          className="relative min-h-11 flex flex-col items-center justify-center rounded-md border text-[0.6875rem]"
                          style={{
                            gridColumn: `${slot.col + 1} / span ${slot.w}`,
                            gridRow: `${slot.row + 1} / span ${slot.h}`,
                            minHeight: slot.h * 26,
                            background: mod ? `${mod.color}22` : 'var(--color-void)',
                            borderColor: mod ? mod.color : 'var(--color-line)',
                          }}
                        >
                          {mod ? (
                            <>
                              <span className="font-medium text-bone">{mod.kind.toUpperCase()}</span>
                              <span className="truncate px-0.5 text-muted">{mod.name.split(' ').pop()}</span>
                            </>
                          ) : (
                            <span className="text-muted">{slot.size}u</span>
                          )}
                        </HudButton>
                      )
                    })}
                  </div>
                  {msg ? <p className="mt-2 text-center text-[0.75rem] text-amber">{msg}</p> : null}
                </div>

                <div className="mt-2 space-y-0.5">
                  <StatRow label="FLOPS" value={`${stats.flopsPf.toFixed(2)} PF`} />
                  <StatRow label="VRAM" value={`${stats.vramGb} GB`} tone="positive" />
                  <StatRow
                    label="Draw / cool / PSU"
                    value={`${(stats.mw * 1000).toFixed(1)} / ${(stats.coolingMw * 1000).toFixed(1)} / ${(stats.psuMw * 1000).toFixed(1)} kW`}
                  />
                  <StatRow label="Build cost" value={money(stats.buildCost)} strong />
                </div>
                {stats.errors.length > 0 ? (
                  <div className="mt-2">
                    <BlockerList items={stats.errors.map((e) => ({ text: e }))} />
                  </div>
                ) : (
                  <p className="mt-2 text-[0.75rem] text-mint">Valid — save to place this in any hall.</p>
                )}

                <div className="mt-3">
                  <div className="mb-1 text-[0.6875rem] uppercase tracking-[0.12em] text-muted">Parts</div>
                  {KIND_ORDER.map((kind) => {
                    const mods = MODULE_CATALOG.filter((m) => m.kind === kind)
                    return (
                      <div key={kind} className="mb-1.5">
                        <div className="mb-0.5 text-[0.6875rem] uppercase text-muted">{kind}</div>
                        <div className="flex flex-wrap gap-1">
                          {mods.map((m) => (
                            <HudButton
                              key={m.id}
                              type="button"
                              variant={selectedModule === m.id ? 'primary' : 'ghost'}
                              onClick={() => setSelectedModule(m.id)}
                              className={`min-h-11 rounded-lg border px-2 py-1 text-left text-[0.75rem] transition ${
                                selectedModule === m.id
                                  ? 'border-mint bg-mint/10'
                                  : 'border-line bg-void hover:border-mint/30'
                              }`}
                            >
                              <div className="font-medium text-bone">{m.name}</div>
                              <div className="font-mono text-muted tabular-nums">
                                {money(m.cost)}
                                {m.vramGb ? ` · ${m.vramGb}GB` : ''}
                                {m.flopsPf ? ` · ${m.flopsPf}PF` : ''}
                                {m.mw ? ` · ${mw(m.mw)}` : ''}
                              </div>
                            </HudButton>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>

                <div className="mt-3 flex gap-2">
                  <HudButton
                    type="button"
                    variant="primary"
                    className="flex-1"
                    disabled={!stats.valid}
                    title={!stats.valid ? 'Fix design errors first' : undefined}
                    onClick={() => {
                      setState(saveRackDesign(state, design))
                      setMsg('Blueprint saved — place it from any hall editor')
                    }}
                  >
                    Save blueprint
                  </HudButton>
                  <HudButton
                    type="button"
                    variant="ghost"
                    className="flex-1"
                    onClick={() => {
                      setDesign(emptyDesign(design.chassisId, design.name))
                      setMsg('Cleared board')
                    }}
                  >
                    Clear
                  </HudButton>
                </div>
              </GameCard>
            </div>
          )}
        </div>
      </div>
    </PanelScaffold>
  )
}
