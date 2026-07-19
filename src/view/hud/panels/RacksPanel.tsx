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
import {
  isDcAnchor,
  isDcKind,
} from '../../../sim/systems/map'
import { BuildingNameField } from '../ui/BuildingNameField'
import { mapTileAtAny } from '../../../sim/systems/worldAccess'

const KIND_ORDER: ModuleKind[] = ['gpu', 'ram', 'cpu', 'cooling', 'psu', 'nic']

/**
 * Fleet + hall order flow + custom rack designer.
 * Primary: select DC → pick SKU/qty with live quote → order / sell.
 */
export function RacksPanel() {
  const state = useGameStore((s) => s.state)
  const selected = useGameStore((s) => s.selectedTile)
  const orderRacks = useGameStore((s) => s.orderRacks)
  const sellRacks = useGameStore((s) => s.sellRacks)
  const cancelRackOrder = useGameStore((s) => s.cancelRackOrder)
  const setState = (s: typeof state) => useGameStore.setState({ state: s })
  const discount = aggregateEffects(state.player.researchUnlocked).chipDiscount ?? 0

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

  const [showDesigner, setShowDesigner] = useState(false)
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
    <div className="space-y-4">
      <div>
        <h2 className="hud-panel-title">Racks</h2>
        <p className="hud-panel-sub">
          The data center selected on the map. Inspect its contents, order capacity, or manage a
          custom rack blueprint.
        </p>
      </div>

      {isLiveDc && usage && (
        <div className="space-y-3 rounded-2xl border border-mint/30 bg-mint/5 p-3">
          <div>
            <BuildingNameField tile={tile} />
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[0.75rem] text-muted">
              <span>Bays</span>
              <span className="text-right text-bone">
                {usage.live} live + {usage.ordered} ordered / {usage.capacity}
              </span>
              <span>Free bays</span>
              <span className="text-right text-mint">{usage.free}</span>
              <span>Hall power (racks)</span>
              <span className="text-right text-bone">{mw(usage.mwLive)}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-void">
              <div
                className="h-full bg-mint"
                style={{
                  width: `${Math.min(100, (usage.used / Math.max(1, usage.capacity)) * 100)}%`,
                }}
              />
            </div>
          </div>

          <RackOrderBlock
            catalog={catalog}
            usage={usage}
            cash={state.player.cash}
            pue={state.player.pue}
            discount={discount}
            onOrder={(id, q) => orderRacks(tile.x, tile.y, id, q)}
          />

          <div>
            <h4 className="mb-1 text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
              Installed / on order
            </h4>
            {installs.length === 0 && (
              <p className="text-[0.8125rem] text-muted">Empty hall — order racks above.</p>
            )}
            <div className="space-y-1.5">
              {installs.map((r) => {
                const sku = resolveRackSku(r.skuId, state.player.rackDesigns)
                return (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-line bg-panel-2 px-2.5 py-2"
                  >
                    <div>
                      <div className="text-sm text-bone">
                        {sku.name}{' '}
                        <span className="font-mono text-[0.75rem] text-muted">×{r.count}</span>
                      </div>
                      <div className="font-mono text-[0.75rem] text-muted">
                        {r.status === 'ordered'
                          ? `Arriving in ${r.daysLeft}d · ${money(sku.price * r.count)} paid`
                          : `Live · ${mw(sku.mw * r.count)} · sell ${Math.round(sku.sellBackRate * 100)}%`}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {r.status === 'live' && (
                        <button
                          type="button"
                          className="rounded-full px-2 py-0.5 text-[0.75rem] text-danger hover:bg-danger/10"
                          onClick={() => sellRacks(tile.x, tile.y, r.skuId, 1)}
                        >
                          Sell 1
                        </button>
                      )}
                      {r.status === 'ordered' && (
                        <button
                          type="button"
                          className="rounded-full px-2 py-0.5 text-[0.75rem] text-muted hover:text-amber"
                          onClick={() => cancelRackOrder(tile.x, tile.y, r.skuId, 1)}
                        >
                          Cancel 1
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {!isLiveDc && (
        <p className="rounded-xl border border-line bg-panel-2 px-3 py-2 text-[0.8125rem] text-muted">
          Select a completed data hall above (or on the map) to order racks with a live price/power
          quote.
        </p>
      )}

      {/* Custom rack designer */}
      <div className="rounded-2xl border border-line bg-panel-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium text-bone">Custom rack blueprints</h3>
            <p className="mt-0.5 text-[0.75rem] text-muted">
              Pack GPUs, HBM, cooling, PSU — save a design, then order it into any hall like a market
              SKU.
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[0.8125rem] text-mint"
            onClick={() => setShowDesigner((v) => !v)}
          >
            {showDesigner ? 'Hide designer' : 'Open designer'}
          </button>
        </div>

        {state.player.rackDesigns.length > 0 && (
          <div className="mt-2 space-y-1">
            {state.player.rackDesigns.map((d) => {
              const sku = designToSku(d)
              return (
                <div
                  key={d.id}
                  className="flex justify-between rounded-lg border border-line bg-void/40 px-2 py-1.5 text-[0.8125rem]"
                >
                  <span className="text-bone">{d.name}</span>
                  <span className="font-mono text-muted">
                    {sku
                      ? `${num(sku.flopsPf, 2)}PF · ${mw(sku.mw)} · ${money(sku.price)}`
                      : 'invalid'}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {showDesigner && (
          <div className="mt-3 space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap gap-1">
              {CHASSIS_CATALOG.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setDesign(emptyDesign(c.id, design.name || c.name))
                    setMsg(`New ${c.name}`)
                  }}
                  className={`rounded-full px-2.5 py-1 text-[0.75rem] ${
                    design.chassisId === c.id ? 'bg-mint text-void' : 'bg-void text-muted'
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
            <div className="rounded-xl border border-line bg-void/60 p-2">
              <p className="mb-2 text-[0.75rem] text-muted">{chassis.blurb}</p>
              <div
                className="relative mx-auto grid gap-1"
                style={{
                  gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                  maxWidth: 320,
                }}
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
                          <span className="truncate px-0.5 text-muted">
                            {mod.name.split(' ').pop()}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted">{slot.size}u</span>
                      )}
                    </button>
                  )
                })}
              </div>
              {msg && <p className="mt-2 text-center text-[0.75rem] text-amber">{msg}</p>}
            </div>
            <div className="rounded-xl border border-line bg-void/40 p-2 font-mono text-[0.75rem]">
              <div className="grid grid-cols-2 gap-x-3 text-muted">
                <span>FLOPS</span>
                <span className="text-right text-bone">{stats.flopsPf.toFixed(2)} PF</span>
                <span>VRAM</span>
                <span className="text-right text-mint">{stats.vramGb} GB</span>
                <span>Draw / cool / PSU</span>
                <span className="text-right text-bone">
                  {(stats.mw * 1000).toFixed(1)} / {(stats.coolingMw * 1000).toFixed(1)} /{' '}
                  {(stats.psuMw * 1000).toFixed(1)} kW
                </span>
                <span>Build cost / rack</span>
                <span className="text-right text-bone">{money(stats.buildCost)}</span>
              </div>
              {stats.errors.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-danger">
                  {stats.errors.map((e) => (
                    <li key={e}>· {e}</li>
                  ))}
                </ul>
              )}
              {stats.valid && (
                <p className="mt-1.5 text-mint">Valid — save to order this into any hall.</p>
              )}
            </div>
            <div>
              <div className="mb-1 text-[0.75rem] uppercase text-muted">Parts (select, click a bay)</div>
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
                          className={`rounded-lg border px-2 py-1 text-left text-[0.75rem] ${
                            selectedModule === m.id
                              ? 'border-mint bg-mint/10'
                              : 'border-line bg-void'
                          }`}
                        >
                          <div className="font-medium text-bone">{m.name}</div>
                          <div className="font-mono text-muted">
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
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-primary flex-1"
                disabled={!stats.valid}
                onClick={() => {
                  setState(saveRackDesign(state, design))
                  setMsg('Blueprint saved — order it from the catalog above')
                }}
              >
                Save blueprint
              </button>
              <button
                type="button"
                className="btn-ghost flex-1"
                onClick={() => {
                  setDesign(emptyDesign(design.chassisId, design.name))
                  setMsg('Cleared board')
                }}
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
