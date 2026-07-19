import type { SimState } from '../../../sim/types'
import { money, num, people } from '../format'

export function CapacitySalesCeilingCard({ state }: { state: SimState }) {
  if (!state.lastMarket.capacitySalesCapped) return null

  return (
    <section className="rounded-xl border border-danger/40 bg-danger/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[0.8125rem] font-semibold uppercase tracking-wider text-danger">
            Compute sales ceiling active
          </h3>
          <p className="mt-1 text-[0.75rem] leading-relaxed text-muted">
            Above 50% share, unserved API tokens are rejected and plan seats stop growing.
            Revenue is capped until you add or buy serving capacity.
          </p>
        </div>
        <span className="shrink-0 font-mono text-[0.8125rem] text-danger">
          {money(state.lastMarket.capacityProductRevenueCeiling ?? 0)}/d
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5 font-mono text-[0.6875rem]">
        <div className="rounded-lg bg-void/40 px-2 py-1.5 text-muted">
          API blocked{' '}
          <span className="text-bone">{num(state.lastMarket.blockedApiMTok ?? 0, 1)} MTok</span>
        </div>
        <div className="rounded-lg bg-void/40 px-2 py-1.5 text-muted">
          Seats blocked{' '}
          <span className="text-bone">{people(state.lastMarket.blockedSubscriptionSeats ?? 0)}</span>
        </div>
      </div>
    </section>
  )
}
