import { useMemo, useState } from 'react'
import { quoteRackOrder, RACK_SKU_CATALOG } from '../../../sim/balance/rackSkus'
import { mtokPerDayForSku } from '../../../sim/balance/tokenServe'
import type { RackSku } from '../../../sim/types'
import { useGameStore } from '../../../store/gameStore'
import { money, mw, num } from '../format'
import { ResearchUnlockLink } from '../ui/ResearchUnlockLink'
import { BlockerList, GameCard, MeterBar, StatRow } from '../ui/kit'
import { EmptyState, HudButton, StatusChip } from '../ui/HudPrimitives'

type Usage = {
  free: number
  live: number
  ordered: number
  capacity: number
  used: number
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
  const lockedSkus = RACK_SKU_CATALOG.filter(
    (candidate) =>
      candidate.requiresResearch &&
      !state.player.researchUnlocked.includes(candidate.requiresResearch),
  )

  if (!sku || !quote) {
    return (
      <EmptyState
        title="No rack types"
        description="Save a custom blueprint or unlock market SKUs."
      />
    )
  }

  const maxFit = Math.max(1, Math.floor(usage.free / Math.max(1, sku.rackUnits)))
  const hallMwAfter = usage.mwLive + quote.mw
  const hallFlopsAfter = usage.flopsLive + quote.flopsPf
  const hallVramAfter = usage.vramLive + quote.vramGb
  const reserveTotal = quote.qty * (supply?.reserveUnitPrice ?? quote.unitPrice) * 1.08
  const blockers = [
    !quote.canFit ? { text: 'Not enough free bays in this hall.', tone: 'danger' as const } : null,
    cash < reserveTotal
      ? { text: `Need ${money(reserveTotal - cash)} more cash to reserve.`, tone: 'danger' as const }
      : null,
  ].filter(Boolean) as { text: string; tone: 'danger' }[]

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-bone">Order racks</h4>
        <div className="flex items-center gap-1.5">
          <HudButton type="button" variant="ghost" onClick={() => setQty((q) => Math.max(1, q - 1))}>
            −
          </HudButton>
          <input
            type="number"
            min={1}
            max={Math.max(64, maxFit)}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
            className="w-14 rounded-md border border-line bg-void px-1.5 py-0.5 text-center font-mono text-[0.8125rem] tabular-nums text-bone"
          />
          <HudButton
            type="button"
            variant="ghost"
            onClick={() => setQty((q) => Math.min(Math.max(64, maxFit), q + 1))}
          >
            +
          </HudButton>
          <HudButton type="button" variant="ghost" onClick={() => setQty(maxFit)} title="Fill remaining free bays">
            Max ({maxFit})
          </HudButton>
        </div>
      </div>

      {supply ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-lg border border-line/70 bg-void/45 px-2.5 py-2 sm:grid-cols-4">
          <StatRow label="Available" value={num(supply.available, 0)} />
          <StatRow label="Reserve" value={money(supply.reserveUnitPrice)} />
          <StatRow
            label="Backlog"
            value={num(supply.backlog, 0)}
            tone={supply.backlog > 0 ? 'warning' : 'neutral'}
          />
          <StatRow label="Last clear" value={latestFill ? money(latestFill.unitPrice) : '—'} />
          {pendingBid ? (
            <div className="col-span-full text-[0.75rem] text-amber">
              Your bid: {num(pendingBid.quantity, 0)} units · {money(pendingBid.cashReserved)} reserved · clears next day
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={`anim-stagger space-y-1.5 ${compact ? 'max-h-40 overflow-y-auto' : ''}`}>
        {catalog.map((s) => {
          const active = s.id === selectedId
          const unit = Math.floor(s.price * (1 - discount))
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSkuId(s.id)}
              className={`hover-lift w-full rounded-lg border px-2.5 py-2 text-left transition ${
                active ? 'border-mint/50 bg-mint/10 ring-1 ring-mint/40' : 'border-line/70 bg-panel-2 hover:border-mint/30'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-bone">{s.name}</span>
                    {s.custom ? <StatusChip tone="warning">custom</StatusChip> : null}
                  </div>
                  {!compact ? (
                    <p className="mt-0.5 text-[0.75rem] leading-snug text-muted">{s.blurb}</p>
                  ) : null}
                  <div className="mt-1 font-mono text-[0.75rem] tabular-nums text-muted">
                    {s.rackUnits} bay · {num(s.flopsPf, 2)} PF · {s.vramGb} GB · {mw(s.mw)} · {s.leadTimeDays}d ·{' '}
                    {money(unit)}/ea
                  </div>
                </div>
                {active ? <StatusChip tone="positive">selected</StatusChip> : null}
              </div>
            </button>
          )
        })}
      </div>

      {lockedSkus.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 rounded-lg border border-line/60 bg-void/35 px-2.5 py-2">
          {lockedSkus.map((locked) => (
            <ResearchUnlockLink
              key={locked.id}
              compact
              nodeId={locked.requiresResearch!}
              label={`Unlock ${locked.name}`}
            />
          ))}
        </div>
      ) : null}

      <GameCard tone="mint" eyebrow="Live quote" title={`${sku.name} × ${quote.qty}`}>
        <StatRow label="Unit price" value={money(quote.unitPrice)} />
        <StatRow
          label="Total cost"
          value={money(quote.totalPrice)}
          tone={quote.canAfford ? 'positive' : 'danger'}
          strong
        />
        <StatRow
          label="Bays needed"
          value={`${quote.bays} (free after ${quote.freeAfter})`}
          tone={quote.canFit ? 'neutral' : 'danger'}
        />
        <StatRow label="Power (racks)" value={mw(quote.mw)} />
        <StatRow label="Power × PUE" value={mw(quote.mwWithPue)} tone="warning" />
        <StatRow label="FLOPS / VRAM" value={`${num(quote.flopsPf, 2)} PF · ${num(quote.vramGb, 0)} GB`} />
        {mtokQuote != null ? (
          <StatRow label="Serve @ active model" value={`~${num(mtokQuote, 1)} MTok/d`} tone="serve" />
        ) : null}
        <StatRow
          label="Lead time"
          value={
            supply
              ? `${supply.leadTimeDays + Math.ceil(supply.backlog / Math.max(1, supply.dailyReplenishment * 3))}d est.`
              : quote.leadDays <= 0
                ? 'instant'
                : `${quote.leadDays}d`
          }
        />
        <div className="mt-2 border-t border-line/60 pt-2">
          <StatRow label="Hall power after" value={mw(hallMwAfter)} />
          <StatRow
            label="Hall FLOPS / VRAM after"
            value={`${num(hallFlopsAfter, 2)} PF · ${num(hallVramAfter, 0)} GB`}
          />
        </div>
        <div className="mt-2">
          <MeterBar
            label="Hall bay fill after order"
            value={(usage.used + quote.bays) / Math.max(1, usage.capacity)}
            detail={`${usage.used + quote.bays}/${usage.capacity}`}
            tone={usage.used + quote.bays > usage.capacity ? 'danger' : 'positive'}
          />
        </div>
        <div className="mt-2">
          <BlockerList items={blockers} />
        </div>
        <HudButton
          type="button"
          variant="primary"
          disabled={blockers.length > 0}
          title={blockers[0]?.text}
          onClick={() => onOrder(sku.id, quote.qty)}
          className="mt-2 w-full"
        >
          Bid {quote.qty}× · reserve up to {money(reserveTotal)}
        </HudButton>
      </GameCard>
    </div>
  )
}
