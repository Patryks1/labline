import { useMemo, useState } from 'react'
import { quoteRackOrder } from '../../../sim/balance/rackSkus'
import { mtokPerDayForSku } from '../../../sim/balance/tokenServe'
import type { RackSku } from '../../../sim/types'
import { useGameStore } from '../../../store/gameStore'
import { money, mw, num } from '../format'

type Usage = {
  free: number
  live: number
  ordered: number
  capacity: number
  mwLive: number
  flopsLive: number
  vramLive: number
}

type Props = {
  catalog: RackSku[]
  usage: Usage
  cash: number
  pue: number
  discount?: number
  onOrder: (skuId: string, qty: number) => void
  compact?: boolean
}

/**
 * Pick a rack SKU + qty with live total price, power, bays, and hall impact.
 */
export function RackOrderBlock({
  catalog,
  usage,
  cash,
  pue,
  discount = 0,
  onOrder,
  compact,
}: Props) {
  const [skuId, setSkuId] = useState(catalog[0]?.id ?? '')
  const [qty, setQty] = useState(4)
  const state = useGameStore((s) => s.state)
  const activeModel = state.player.models.find(
    (m) =>
      m.id === state.player.pricing.activeModelId &&
      (m.release === 'released' || m.shipped),
  )
  const inferShare = Math.max(
    0.05,
    state.player.allocation.inference /
      Math.max(
        0.01,
        state.player.allocation.training +
          state.player.allocation.inference +
          state.player.allocation.research,
      ),
  )

  // Keep selection valid when catalog changes
  const selectedId = catalog.some((s) => s.id === skuId) ? skuId : (catalog[0]?.id ?? '')
  const sku = catalog.find((s) => s.id === selectedId) ?? catalog[0]

  const quote = useMemo(() => {
    if (!sku) return null
    return quoteRackOrder(sku, qty, {
      discount,
      freeBays: usage.free,
      cash,
      pue,
    })
  }, [sku, qty, discount, usage.free, cash, pue])

  const mtokQuote =
    sku && activeModel
      ? mtokPerDayForSku(
          sku,
          activeModel,
          state.player.servingEfficiency,
          inferShare,
          state.player.utilCap,
        ) * qty
      : null
  const supply = state.worldMarkets.accelerators[sku?.id ?? '']
  const pendingBid = state.worldMarkets.orders.find(
    (order) =>
      order.labId === state.playerLabId &&
      order.kind === 'accelerator' &&
      order.resourceId === sku?.id,
  )
  const latestFill = state.worldMarkets.fills.find(
    (fill) => fill.kind === 'accelerator' && fill.resourceId === sku?.id,
  )

  if (!sku || !quote) {
    return (
      <p className="text-[0.8125rem] text-muted">
        No rack types available. Save a custom blueprint or unlock market SKUs.
      </p>
    )
  }

  const maxFit = Math.max(1, Math.floor(usage.free / Math.max(1, sku.rackUnits)))
  const hallMwAfter = usage.mwLive + quote.mw
  const hallFlopsAfter = usage.flopsLive + quote.flopsPf
  const hallVramAfter = usage.vramLive + quote.vramGb

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">Order racks</h4>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="rounded border border-line px-2 py-0.5 font-mono text-[0.8125rem] text-muted hover:border-mint/40"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
          >
            −
          </button>
          <input
            type="number"
            min={1}
            max={Math.max(64, maxFit)}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
            className="w-14 rounded border border-line bg-void px-1.5 py-0.5 text-center font-mono text-xs text-bone"
          />
          <button
            type="button"
            className="rounded border border-line px-2 py-0.5 font-mono text-[0.8125rem] text-muted hover:border-mint/40"
            onClick={() => setQty((q) => Math.min(Math.max(64, maxFit), q + 1))}
          >
            +
          </button>
          <button
            type="button"
            className="rounded-full px-2 py-0.5 text-[0.75rem] text-mint hover:bg-mint/10"
            onClick={() => setQty(maxFit)}
            title="Fill remaining free bays"
          >
            Max ({maxFit})
          </button>
        </div>
      </div>

      {supply && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-xl border border-line/70 bg-void/45 px-2.5 py-2 font-mono text-[0.6875rem] text-muted sm:grid-cols-4">
          <span>Available <strong className="text-bone">{num(supply.available, 0)}</strong></span>
          <span>Reserve <strong className="text-bone">{money(supply.reserveUnitPrice)}</strong></span>
          <span>Backlog <strong className={supply.backlog > 0 ? 'text-amber' : 'text-bone'}>{num(supply.backlog, 0)}</strong></span>
          <span>Last clear <strong className="text-bone">{latestFill ? money(latestFill.unitPrice) : '—'}</strong></span>
          {pendingBid && (
            <span className="col-span-full text-amber">
              Your bid: {num(pendingBid.quantity, 0)} units · {money(pendingBid.cashReserved)} reserved · clears next day
            </span>
          )}
        </div>
      )}

      <div className={`space-y-1.5 ${compact ? 'max-h-40 overflow-y-auto' : ''}`}>
        {catalog.map((s) => {
          const active = s.id === selectedId
          const unit = Math.floor(s.price * (1 - discount))
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSkuId(s.id)}
              className={`w-full rounded-xl border px-2.5 py-2 text-left transition ${
                active ? 'border-mint/50 bg-mint/10' : 'border-line bg-panel-2 hover:border-mint/30'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-bone">{s.name}</span>
                    {s.custom && (
                      <span className="rounded-full bg-amber/15 px-1.5 py-0.5 text-[0.6875rem] text-amber">
                        custom
                      </span>
                    )}
                  </div>
                  {!compact && (
                    <p className="mt-0.5 text-[0.75rem] leading-snug text-muted">{s.blurb}</p>
                  )}
                  <div className="mt-1 font-mono text-[0.75rem] text-muted">
                    {s.rackUnits} bay · {num(s.flopsPf, 2)} PF · {s.vramGb} GB · {mw(s.mw)} ·{' '}
                    {s.leadTimeDays}d · {money(unit)}/ea
                  </div>
                </div>
                {active && (
                  <span className="shrink-0 font-mono text-[0.75rem] text-mint">selected</span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Live quote — updates with qty */}
      <div className="rounded-xl border border-mint/30 bg-mint/5 p-2.5 font-mono text-[0.75rem]">
        <div className="mb-1.5 text-[0.8125rem] font-medium text-bone">
          Quote · {sku.name} × {quote.qty}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted">
          <span>Unit price</span>
          <span className="text-right text-bone">{money(quote.unitPrice)}</span>
          <span>Total cost</span>
          <span className={`text-right ${quote.canAfford ? 'text-mint' : 'text-danger'}`}>
            {money(quote.totalPrice)}
          </span>
          <span>Bays needed</span>
          <span className={`text-right ${quote.canFit ? 'text-bone' : 'text-danger'}`}>
            {quote.bays} (free after {quote.freeAfter})
          </span>
          <span>Power (racks)</span>
          <span className="text-right text-bone">{mw(quote.mw)}</span>
          <span>Power × PUE</span>
          <span className="text-right text-amber">{mw(quote.mwWithPue)}</span>
          <span>FLOPS / VRAM</span>
          <span className="text-right text-bone">
            {num(quote.flopsPf, 2)} PF · {num(quote.vramGb, 0)} GB
          </span>
          {mtokQuote != null && (
            <>
              <span>Serve @ active model</span>
              <span className="text-right text-mint">~{num(mtokQuote, 1)} MTok/d</span>
            </>
          )}
          <span>Lead time</span>
          <span className="text-right text-bone">
            {supply
              ? `${supply.leadTimeDays + Math.ceil(supply.backlog / Math.max(1, supply.dailyReplenishment * 3))}d est.`
              : quote.leadDays <= 0
                ? 'instant'
                : `${quote.leadDays}d`}
          </span>
        </div>
        <div className="mt-2 border-t border-line/60 pt-2 text-muted">
          <div className="flex justify-between">
            <span>Hall power after</span>
            <span className="text-bone">{mw(hallMwAfter)}</span>
          </div>
          <div className="mt-0.5 flex justify-between">
            <span>Hall FLOPS / VRAM after</span>
            <span className="text-bone">
              {num(hallFlopsAfter, 2)} PF · {num(hallVramAfter, 0)} GB
            </span>
          </div>
        </div>
        {!quote.canFit && (
          <p className="mt-1.5 text-danger">Not enough free bays in this hall.</p>
        )}
        {!quote.canAfford && (
          <p className="mt-1.5 text-danger">Insufficient cash (have {money(cash)}).</p>
        )}
        <button
          type="button"
          disabled={
            !quote.canFit ||
            cash < quote.qty * (supply?.reserveUnitPrice ?? quote.unitPrice) * 1.08
          }
          onClick={() => onOrder(sku.id, quote.qty)}
          className="btn-primary mt-2 w-full py-2 text-[0.8125rem] disabled:opacity-40"
        >
          Bid {quote.qty}× · reserve up to{' '}
          {money(quote.qty * (supply?.reserveUnitPrice ?? quote.unitPrice) * 1.08)}
        </button>
      </div>
    </div>
  )
}
