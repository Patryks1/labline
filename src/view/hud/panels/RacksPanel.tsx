import { useMemo, useState } from 'react'
import {
  CHASSIS_CATALOG,
  MODULE_CATALOG,
  getModule,
  scoreDesign,
} from '../../../sim/balance/racks'
import { dcBayUsage, fullOrderCatalog, racksOnDc } from '../../../sim/systems/dcRacks'
import {
  clearSlot,
  designToSku,
  emptyDesign,
  placeModule,
  resolveRackSku,
  saveRackDesign,
} from '../../../sim/systems/racks'
import { useGameStore } from '../../../store/gameStore'
import type { ModuleKind, RackDesign } from '../../../sim/types'
import { money, num, mw } from '../format'
import { RackOrderBlock } from './RackOrderBlock'
import { aggregateEffects } from '../../../sim/systems/research'
import { isDcAnchor, isDcKind } from '../../../sim/systems/map'
import { BuildingNameField } from '../ui/BuildingNameField'
import { mapTileAtAny } from '../../../sim/systems/worldAccess'
import {
  EmptyState,
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from '../ui/HudPrimitives'
import {
  BlockerList,
  GameCard,
  LiveDot,
  MeterBar,
  SegmentedTabs,
  StatRow,
} from '../ui/kit'
import { fleetStats } from '../../../sim/systems/racks'

const KIND_ORDER: ModuleKind[] = ['gpu', 'ram', 'cpu', 'cooling', 'psu', 'nic']

export function RacksPanel() {
  const state = useGameStore((s) => s.state)
  const selected = useGameStore((s) => s.selectedTile)
  const orderRacks = useGameStore((s) => s.orderRacks)
  const sellRacks = useGameStore((s) => s.sellRacks)
  const cancelRackOrder = useGameStore((s) => s.cancelRackOrder)
  const setState = (s: typeof state) => useGameStore.setState({ state: s })
  const discount = aggregateEffects(state.player.researchUnlocked).chipDiscount ?? 0
  const fleet = fleetStats(state)

  const catalog = useMemo(() => fullOrderCatalog(state), [state])
  const tile = selected ? mapTileAtAny(state, selected.x, selected.y) : undefined
  const isLiveDc =
    tile &&
    isDcKind(tile.kind) &&
    isDcAnchor(tile) &&
    tile.owner === 'player' &&
    tile.buildingProgress >= tile.buildingTarget
  const usage = isLiveDc ? dcBayUsage(state, tile.x, tile.y) : null
  const installs = isLiveDc ? racksOnDc(state, tile.x, tile.y) : []
  const orderedCount = installs.filter((r) => r.status === 'ordered').reduce((s, r) => s + r.count, 0)
  const liveCount = installs.filter((r) => r.status === 'live').reduce((s, r) => s + r.count, 0)

  const [tab, setTab] = useState<'order' | 'designer'>('order')
  const [design, setDesign] = useState<RackDesign>(() => emptyDesign('case_8u', 'My Node'))
  const [selectedModule, setSelectedModule] = useState('gpu_h100')
  const [msg, setMsg] = useState('')
  const stats = useMemo(() => scoreDesign(design), [design])
  const chassis = CHASSIS_CATALOG.find((c) => c.id === design.chassisId)!

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
      description="Order capacity into the selected hall, or save a custom blueprint."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile label="Fleet PF" value={num(fleet.flopsPf, 1)} tone="positive" />
          <MetricTile label="Live racks" value={num(liveCount || Math.round(fleet.rackUnitsUsed), 0)} />
          <MetricTile label="On order" value={num(orderedCount, 0)} tone={orderedCount > 0 ? 'warning' : 'neutral'} />
          <MetricTile label="Fleet draw" value={mw(fleet.mw)} detail={`${num(fleet.vramGb, 0)} GB VRAM`} />
        </div>

        <SegmentedTabs
          ariaLabel="Racks sections"
          active={tab}
          onChange={(id) => setTab(id as 'order' | 'designer')}
          items={[
            { id: 'order', label: 'Order' },
            { id: 'designer', label: `Blueprints (${state.player.rackDesigns.length})` },
          ]}
        />

        <div key={tab} className="panel-swap">
          {tab === 'order' ? (
            isLiveDc && usage && tile ? (
              <div className="space-y-3">
                <GameCard
                  tone="mint"
                  live={orderedCount > 0}
                  eyebrow="Selected hall"
                  title={<BuildingNameField tile={tile} />}
                  actions={
                    orderedCount > 0 ? (
                      <span className="inline-flex items-center gap-1.5">
                        <LiveDot className="text-amber" />
                        <StatusChip tone="warning">{orderedCount} inbound</StatusChip>
                      </span>
                    ) : (
                      <StatusChip tone="positive">{usage.free} free</StatusChip>
                    )
                  }
                >
                  <StatRow label="Bays" value={`${usage.live} live + ${usage.ordered} ordered / ${usage.capacity}`} />
                  <StatRow label="Free bays" value={String(usage.free)} tone="positive" strong />
                  <StatRow label="Hall power" value={mw(usage.mwLive)} />
                  <div className="mt-2">
                    <MeterBar
                      label="Bay fill"
                      value={usage.used / Math.max(1, usage.capacity)}
                      detail={`${usage.used}/${usage.capacity}`}
                      tone="positive"
                      live={orderedCount > 0}
                    />
                  </div>
                </GameCard>

                <RackOrderBlock
                  catalog={catalog}
                  usage={usage}
                  cash={state.player.cash}
                  pue={state.player.pue}
                  discount={discount}
                  onOrder={(id, q) => orderRacks(tile.x, tile.y, id, q)}
                />

                <GameCard eyebrow="Inventory" title="Installed / on order">
                  {installs.length === 0 ? (
                    <EmptyState title="Empty hall" description="Order racks above to fill free bays." />
                  ) : (
                    <div className="anim-stagger space-y-1.5">
                      {installs.map((r) => {
                        const sku = resolveRackSku(r.skuId, state.player.rackDesigns)
                        return (
                          <div
                            key={r.id}
                            className="flex items-center justify-between gap-2 rounded-lg border border-line/70 bg-void/40 px-2.5 py-2"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 text-sm text-bone">
                                {r.status === 'ordered' ? <LiveDot className="text-amber" /> : null}
                                <span className="truncate">{sku.name}</span>
                                <span className="font-mono text-[0.75rem] tabular-nums text-muted">×{r.count}</span>
                              </div>
                              <div className="font-mono text-[0.75rem] tabular-nums text-muted">
                                {r.status === 'ordered'
                                  ? `Arriving in ${r.daysLeft}d · ${money(sku.price * r.count)} paid`
                                  : `Live · ${mw(sku.mw * r.count)} · sell ${Math.round(sku.sellBackRate * 100)}%`}
                              </div>
                            </div>
                            <div className="flex shrink-0 gap-1">
                              {r.status === 'live' ? (
                                <HudButton
                                  type="button"
                                  variant="ghost"
                                  className="!px-2 !py-0.5 text-[0.75rem] text-danger"
                                  onClick={() => sellRacks(tile.x, tile.y, r.skuId, 1)}
                                >
                                  Sell 1
                                </HudButton>
                              ) : null}
                              {r.status === 'ordered' ? (
                                <HudButton
                                  type="button"
                                  variant="ghost"
                                  className="!px-2 !py-0.5 text-[0.75rem]"
                                  onClick={() => cancelRackOrder(tile.x, tile.y, r.skuId, 1)}
                                >
                                  Cancel 1
                                </HudButton>
                              ) : null}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </GameCard>
              </div>
            ) : (
              <EmptyState
                title="Select a live data hall"
                description="Click a completed hall on the map (or open it from Fleet) to place an order with a live quote."
              />
            )
          ) : (
            <div className="space-y-3">
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
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setDesign(emptyDesign(c.id, design.name || c.name))
                        setMsg(`New ${c.name}`)
                      }}
                      className={`rounded-md px-2.5 py-1 text-[0.75rem] transition ${
                        design.chassisId === c.id ? 'bg-mint text-void' : 'bg-void text-muted hover:text-bone'
                      }`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
                <label className="block text-[0.8125rem] text-muted">
                  Blueprint name
                  <input
                    value={design.name}
                    onChange={(e) => setDesign({ ...design, name: e.target.value })}
                    className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1 text-sm text-bone outline-none"
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
                        <button
                          key={slot.id}
                          type="button"
                          onClick={() => onSlotClick(slot.id)}
                          className="relative flex flex-col items-center justify-center rounded-md border text-[0.6875rem]"
                          style={{
                            gridColumn: `${slot.col + 1} / span ${slot.w}`,
                            gridRow: `${slot.row + 1} / span ${slot.h}`,
                            minHeight: slot.h * 26,
                            background: mod ? `${mod.color}22` : '#12141a',
                            borderColor: mod ? mod.color : '#2a2f3a',
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
                        </button>
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
                  <p className="mt-2 text-[0.75rem] text-mint">Valid — save to order this into any hall.</p>
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
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => setSelectedModule(m.id)}
                              className={`rounded-lg border px-2 py-1 text-left text-[0.75rem] transition ${
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
                            </button>
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
                      setMsg('Blueprint saved — order it from the Order tab')
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
