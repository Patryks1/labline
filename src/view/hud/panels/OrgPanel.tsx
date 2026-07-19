import { useEffect, useMemo, useState } from 'react'
import { ECONOMY } from '../../../sim/balance/economy'
import {
  STAFF_BLURBS,
  STAFF_LABELS,
  emptyStaff,
  staffTotal,
} from '../../../sim/balance/staff'
import {
  bankCreditSnapshot,
  dailyLoanPayment,
  interestForDraw,
  isBailoutEligible,
  loanOffers,
} from '../../../sim/systems/loans'
import {
  cityForHq,
  hireStaff,
  hireStaffCost,
  playerHqStaffCap,
  playerStaff,
  playerStaffOpenSeats,
  poachRivalStaff,
  poachStaffCost,
  staffWagePerDay,
} from '../../../sim/systems/staff'
import { isHqAnchor, isHqKind } from '../../../sim/systems/map'
import type { FinanceDaySnapshot, SimState, StaffRole } from '../../../sim/types'
import {
  acceptEquityOffer,
  applyForDebt,
  bankingProducts,
  buyBackEquity,
  capitalSnapshot,
  equityBuybackQuote,
  repayDebt as repayTypedDebt,
  requestEquityOffers,
} from '../../../sim/systems/capital'
import type { BankingProduct } from '../../../sim/systems/capital'
import { valuationDrivers } from '../../../sim/systems/victory'
import {
  marketingBudgetCeiling,
  marketingChannels,
  marketingReach,
} from '../../../sim/systems/org'
import { sparkPath } from '../../../sim/systems/stats'
import { setAutomationPolicies } from '../../../sim/systems/automation'
import { useGameStore } from '../../../store/gameStore'
import { money, num, pct } from '../format'
import { SliderField } from '../ui/SliderField'
import {
  facilityAnchorTiles,
  mapTileAtAny,
} from '../../../sim/systems/worldAccess'

/**
 * Company → People: HQ staffing from city talent pools + poach rivals.
 * Loans / marketing live below. Global "Hire talent" removed.
 */
export function OrgPanel() {
  const state = useGameStore((s) => s.state)
  const setState = (next: typeof state) => useGameStore.setState({ state: next })
  const setMarketing = useGameStore((s) => s.setMarketing)
  const setMarketingChannel = useGameStore((s) => s.setMarketingChannel)
  const takeLoan = useGameStore((s) => s.takeLoan)
  const takeCustomLoan = useGameStore((s) => s.takeCustomLoan)
  const acceptLoanOffer = useGameStore((s) => s.acceptLoanOffer)
  const repayLoan = useGameStore((s) => s.repayLoan)
  const openSites = useGameStore((s) => s.openSites)
  const selected = useGameStore((s) => s.selectedTile)

  const p = state.player
  const staff = playerStaff(state)
  const seats = playerHqStaffCap(state)
  const openSeats = playerStaffOpenSeats(state)
  const wageDay = staffWagePerDay(state)
  const loans = p.loans ?? []
  const dayDebt = dailyLoanPayment(loans)
  const credit = useMemo(() => bankCreditSnapshot(state), [state])
  const offers = useMemo(() => loanOffers(state), [state])
  const firmOffers = state.worldMarkets.loanOffers.filter(
    (offer) => offer.labId === state.playerLabId && offer.expiresDay >= state.day,
  )
  const pendingApplications = state.worldMarkets.loanApplications.filter(
    (application) =>
      application.labId === state.playerLabId && application.status === 'pending',
  )
  const minDraw = ECONOMY.loans.minDraw ?? 5_000_000
  const maxDraw = Math.max(0, Math.floor(credit.available))
  const drawCeil = Math.max(minDraw, maxDraw)
  const [customAmt, setCustomAmt] = useState(() =>
    Math.min(maxDraw, Math.max(minDraw, Math.floor(maxDraw * 0.35))),
  )
  const [customTerm, setCustomTerm] = useState(45)
  const [hireCount, setHireCount] = useState(1)
  const [selectedHireRole, setSelectedHireRole] = useState<StaffRole>('researcher')
  const [companyTab, setCompanyTab] = useState<
    'staff' | 'funding' | 'marketing' | 'governance'
  >('staff')
  const [capitalView, setCapitalView] = useState<'ownership' | 'credit'>('ownership')
  const [buybackPct, setBuybackPct] = useState(1)
  const capital = useMemo(() => capitalSnapshot(state), [state])
  const equityOffers = useMemo(() => requestEquityOffers(state), [state])
  const bankProducts = useMemo(() => bankingProducts(state), [state])
  const valueDrivers = useMemo(() => valuationDrivers(state), [state])
  const channelSpend = useMemo(() => marketingChannels(state), [state])
  const reach = useMemo(() => marketingReach(state), [state])
  const marketingMax = useMemo(() => marketingBudgetCeiling(state), [state])
  const rivalMarketing = useMemo(
    () => [...state.rivals]
      .sort((a, b) => (b.marketingSpendPerDay ?? 0) - (a.marketingSpendPerDay ?? 0))
      .slice(0, 4),
    [state.rivals],
  )
  const companyHealth = Math.max(0, Math.min(100, Math.round(
    p.brandTrust * 0.28 +
    capital.founderOwnership * 100 * 0.25 +
    Math.min(100, (staffTotal(staff) / Math.max(1, seats)) * 100) * 0.17 +
    Math.min(100, Math.max(0, 50 + p.finance.dayNet / Math.max(1, p.finance.dayRevenue) * 50)) * 0.3,
  )))

  // Keep draw inside the bank’s current line as valuation / debt moves
  useEffect(() => {
    setCustomAmt((prev) => {
      if (maxDraw < minDraw) return minDraw
      return Math.min(maxDraw, Math.max(minDraw, prev))
    })
  }, [maxDraw, minDraw])

  const clampedDraw = maxDraw < minDraw ? 0 : Math.min(maxDraw, Math.max(minDraw, customAmt))
  const quoteInterest = useMemo(
    () => (clampedDraw > 0 ? interestForDraw(state, clampedDraw, customTerm) : 0),
    [state, clampedDraw, customTerm],
  )
  const quoteTotalDue = clampedDraw * (1 + quoteInterest)
  const quoteDaily = customTerm > 0 ? quoteTotalDue / customTerm : 0
  const postLtv =
    credit.valuation > 1
      ? (credit.outstanding + quoteTotalDue) / credit.valuation
      : quoteTotalDue > 0
        ? 1
        : 0
  const canDraw =
    clampedDraw >= minDraw &&
    loans.length < (ECONOMY.loans.maxActive ?? 4) &&
    maxDraw >= minDraw

  const hqs = facilityAnchorTiles(state, { ownerId: 'player' }).filter(
    (t) =>
      t.owner === 'player' &&
      isHqKind(t.kind) &&
      isHqAnchor(t) &&
      t.buildingProgress >= t.buildingTarget,
  )

  const selectedHq =
    selected &&
    (() => {
      const tile = mapTileAtAny(state, selected.x, selected.y)
      return tile?.owner === 'player' && isHqKind(tile.kind) ? tile : undefined
    })()
  const hireCity =
    (selectedHq && cityForHq(state, selectedHq.x, selectedHq.y)) ||
    (hqs[0] && cityForHq(state, hqs[0].x, hqs[0].y)) ||
    state.map.cities?.[0] ||
    null

  const cityPool = hireCity?.talentAvailable ?? emptyStaff()
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="hud-panel-title">Company command</h2>
          <p className="hud-panel-sub">People, capital, growth, and operating control.</p>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg text-mint">{companyHealth}</div>
          <div className="text-[0.625rem] uppercase tracking-wider text-muted">health</div>
        </div>
      </div>

      <CompanyPulse
        cash={p.cash}
        net={p.finance.dayNet}
        brand={p.brandTrust}
        control={capital.founderOwnership}
        team={staffTotal(staff)}
        seats={seats}
        history={state.financeHistory}
      />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line" role="tablist" aria-label="Company areas">
        {([
          ['company', 'Company'],
          ['growth', 'Growth'],
        ] as const).map(([id, label]) => {
          const selected = id === 'company'
            ? companyTab === 'staff' || companyTab === 'funding'
            : companyTab === 'marketing' || companyTab === 'governance'
          return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => setCompanyTab(id === 'company' ? 'staff' : 'marketing')}
            className={`min-h-9 bg-void px-2 text-[0.6875rem] font-medium uppercase tracking-wide ${selected ? 'text-mint shadow-[inset_0_-2px_0_var(--color-mint)]' : 'text-muted hover:bg-panel-2 hover:text-bone'}`}
          >
            {label}
          </button>
          )
        })}
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-lg bg-void/50 p-1" role="tablist" aria-label={companyTab === 'staff' || companyTab === 'funding' ? 'Company sections' : 'Growth sections'}>
        {(companyTab === 'staff' || companyTab === 'funding'
          ? ([['staff', 'Team'], ['funding', 'Capital']] as const)
          : ([['marketing', 'Marketing'], ['governance', 'Policy']] as const)
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={companyTab === id}
            onClick={() => setCompanyTab(id)}
            className={`min-h-8 rounded-md px-2 text-[0.6875rem] font-medium uppercase tracking-wide ${companyTab === id ? 'bg-panel-2 text-bone ring-1 ring-line' : 'text-muted hover:text-bone'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {companyTab === 'staff' ? <>
        <TeamBoard
          staff={staff}
          seats={seats}
          wages={wageDay}
          selectedRole={selectedHireRole}
          onSelectRole={setSelectedHireRole}
        />

        {seats <= 0 ? (
          <button type="button" className="w-full rounded-xl border border-amber/30 bg-amber/5 p-3 text-left text-[0.75rem] text-amber" onClick={() => openSites()}>
            Build an HQ to unlock hiring →
          </button>
        ) : hireCity ? (() => {
          const free = cityPool[selectedHireRole] ?? 0
          const cost = hireStaffCost(state, selectedHireRole, hireCount, hireCity.id)
          const blocked = state.player.cash < cost || free < hireCount || openSeats < hireCount
          return (
            <section className="overflow-hidden rounded-xl border border-line bg-panel-2">
              <div className="flex items-center justify-between border-b border-line/70 px-3 py-2">
                <div>
                  <h3 className="text-[0.75rem] font-medium text-bone">Hire {STAFF_LABELS[selectedHireRole].toLowerCase()}</h3>
                  <p className="text-[0.625rem] text-muted">{hireCity.name} · {free} ready · {openSeats} seats open</p>
                </div>
                <span className="font-mono text-[0.625rem] text-muted">wage ×{(hireCity.talentWageMult ?? 1).toFixed(2)}</span>
              </div>
              <div className="grid grid-cols-[1fr_auto] items-end gap-3 p-3">
                <div>
                  <p className="mb-2 text-[0.6875rem] leading-snug text-muted">{STAFF_BLURBS[selectedHireRole]}</p>
                  <label className="flex items-center gap-2 text-[0.625rem] text-muted">
                    Quantity
                    <input
                      type="number"
                      min={1}
                      max={Math.max(1, openSeats)}
                      value={hireCount}
                      onChange={(event) => setHireCount(Math.max(1, Math.min(20, Number(event.target.value) || 1)))}
                      className="w-14 rounded border border-line bg-void px-1.5 py-1 font-mono text-[0.75rem] text-bone"
                    />
                  </label>
                </div>
                <button
                  type="button"
                  disabled={blocked}
                  className={`min-w-28 rounded-lg px-3 py-2 text-[0.75rem] font-medium transition active:translate-y-px ${blocked ? 'bg-line/40 text-muted' : 'bg-mint/20 text-mint hover:bg-mint/30'}`}
                  onClick={() => setState(hireStaff(state, hireCity.id, selectedHireRole, hireCount))}
                >
                  Hire · {money(cost)}
                </button>
              </div>
            </section>
          )
        })() : null}

        <details className="group rounded-xl border border-line bg-void/30">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[0.75rem] text-bone">
            <span>Poach rival talent</span>
            <span className="font-mono text-[0.625rem] text-muted group-open:text-mint">premium market +</span>
          </summary>
          <div className="space-y-1 border-t border-line/70 p-2">
            {state.rivals.slice(0, 5).map((rival) => {
              const rivalStaff = rival.staff ?? emptyStaff()
              return (
                <div key={rival.id} className="flex items-center justify-between gap-2 rounded-lg bg-panel-2 px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-[0.6875rem] text-bone">{rival.name}</div>
                    <div className="font-mono text-[0.5625rem] text-muted">R{rivalStaff.researcher} · D{rivalStaff.data_processor} · E{rivalStaff.engineer}</div>
                  </div>
                  <div className="flex gap-1">
                    {(['researcher', 'data_processor', 'engineer'] as StaffRole[]).map((role) => {
                      const cost = poachStaffCost(state, rival.id, role, 1)
                      const canPoach = (rivalStaff[role] ?? 0) >= 1 && openSeats >= 1 && state.player.cash >= cost
                      return (
                        <button key={role} type="button" title={`${STAFF_LABELS[role]} · ${money(cost)}`} disabled={!canPoach} className={`rounded px-1.5 py-1 font-mono text-[0.625rem] ${canPoach ? 'bg-amber/15 text-amber hover:bg-amber/25' : 'bg-line/30 text-muted'}`} onClick={() => setState(poachRivalStaff(state, rival.id, role, 1))}>
                          {role === 'researcher' ? 'R' : role === 'data_processor' ? 'D' : 'E'} · {money(cost)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </details>

      </> : null}

      {companyTab === 'funding' ? (
      <div className="rounded-2xl border border-line bg-panel-2 p-3 space-y-3">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-void/50 p-1" role="tablist" aria-label="Capital actions">
          {([
            ['ownership', 'Ownership'],
            ['credit', 'Credit'],
          ] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={capitalView === id} onClick={() => setCapitalView(id)} className={`rounded-md px-2 py-1.5 text-[0.6875rem] transition ${capitalView === id ? 'bg-panel-2 text-mint' : 'text-muted hover:text-bone'}`}>
              {label}
            </button>
          ))}
        </div>
        {capitalView === 'ownership' ? (
        <section className="space-y-2 border-b border-line/70 pb-3">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Capital stack</h3>
            <span className="font-mono text-[0.75rem] text-mint">
              founders {(capital.founderOwnership * 100).toFixed(1)}%
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="Cash" value={money(state.player.cash)} />
            <Stat label="Runway" value={Number.isFinite(state.player.finance.runwayDays) ? `${Math.max(0, Math.floor(state.player.finance.runwayDays))}d` : '∞'} />
            <Stat label="Typed debt" value={money(capital.debtOutstanding)} />
            <Stat label="Board pressure" value={pct(capital.boardPressure)} accent={capital.boardPressure > 0.65 ? 'text-amber' : 'text-bone'} />
          </div>
          <CapitalRail
            founder={capital.founderOwnership}
            debt={capital.debtOutstanding}
            valuation={Math.max(1, p.finance.valuation)}
            board={capital.boardPressure}
          />
          {state.player.capital?.restructuring.active && (
            <div className="rounded-lg border border-danger/35 bg-danger/10 px-2 py-1.5 text-[0.6875rem] text-danger">
              Recovery ladder: {state.player.capital.restructuring.stage.replace('_', ' ')} ·{' '}
              {state.player.capital.restructuring.daysLeft}d to stabilize cash, refinance, raise equity, or sell assets.
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted">Cap table & buybacks</h4>
              <span className={`font-mono text-[0.6875rem] ${capital.founderOwnership < 0.1 ? 'text-danger' : 'text-muted'}`}>
                loss below 5%
              </span>
            </div>
            <SliderField
              label="Stake to repurchase"
              value={buybackPct}
              min={0.1}
              max={5}
              step={0.1}
              format={(value) => `${value.toFixed(1)}%`}
              colorClass="bg-amber"
              accentClass="text-amber"
              onChange={setBuybackPct}
            />
            {(state.player.capital?.capTable ?? []).map((stake, index) => {
              const ownership = Math.min(stake.ownership, buybackPct / 100)
              const quote = equityBuybackQuote(state, stake.holderId, ownership)
              return (
                <div key={`${stake.holderId}-${index}`} className="flex items-center justify-between gap-2 rounded border border-line/60 bg-void/35 px-2 py-1.5 font-mono text-[0.6875rem]">
                  <span className="min-w-0 text-muted">
                    <span className="block truncate">{stake.holderName}</span>
                    <span className="text-bone">{(stake.ownership * 100).toFixed(2)}%</span>
                  </span>
                  {quote ? (
                    <button
                      type="button"
                      disabled={state.player.cash < quote.cost}
                      onClick={() => setState(buyBackEquity(state, stake.holderId, ownership))}
                      className="shrink-0 rounded border border-amber/30 px-2 py-1 text-amber hover:bg-amber/10 disabled:opacity-35"
                    >
                      Buy {money(quote.cost)}
                    </button>
                  ) : (
                    <span className="text-muted/70">locked</span>
                  )}
                </div>
              )
            })}
            {capital.founderOwnership < 0.1 && (
              <div className="rounded border border-danger/35 bg-danger/10 px-2 py-1.5 text-[0.6875rem] text-danger">
                Control warning: {(capital.founderOwnership * 100).toFixed(1)}% founder ownership remains. Below 5% ends the run.
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <h4 className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted">Equity term sheets</h4>
            {equityOffers.slice(0, 3).map((offer) => (
              <div key={offer.id} className="rounded-lg border border-line/70 bg-void/35 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[0.75rem] text-bone">{offer.investorName}</div>
                    <div className="font-mono text-[0.625rem] text-muted">
                      {money(offer.preMoneyValuation)} pre · {money(offer.postMoneyValuation)} post · {(offer.investorOwnership * 100).toFixed(1)}% dilution
                      {offer.optionPoolTopUp > 0 ? ` · +${(offer.optionPoolTopUp * 100).toFixed(1)}% pool` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={(state.player.capital?.investorConfidence ?? 0) < offer.confidenceRequired}
                    onClick={() => setState(acceptEquityOffer(state, offer))}
                    className="shrink-0 rounded bg-mint/20 px-2 py-1 font-mono text-[0.6875rem] text-mint disabled:opacity-35"
                  >
                    Raise {money(offer.cashRaised)}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2 rounded-lg border border-amber/20 bg-amber/5 p-2">
            <div className="flex items-end justify-between gap-2">
              <div>
                <h4 className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted">Financing offers</h4>
                <p className="mt-0.5 max-w-[34rem] text-[0.625rem] leading-snug text-muted">
                  Lenders price each offer from current revenue, assets, and company value. Terms refresh as the business changes.
                </p>
              </div>
              <span className="shrink-0 font-mono text-[0.5625rem] uppercase tracking-wider text-amber">live desk</span>
            </div>
            <div className="space-y-1.5">
              {bankProducts.map((product, index) => (
                <BankingOfferCard
                  key={product.kind}
                  product={product}
                  sequence={index + 1}
                  onAccept={(amount) => setState(applyForDebt(state, product.kind, amount))}
                />
              ))}
            </div>
            {(state.player.capital?.debt ?? []).map((debt) => (
              <div key={debt.id} className="flex items-center justify-between gap-2 border-t border-line/60 pt-1.5">
                <div className="min-w-0 font-mono text-[0.625rem] text-muted">
                  <span className="block truncate text-bone">{debt.label}</span>
                  {money(debt.remaining)} · {(debt.apr * 100).toFixed(1)}% APR · {debt.daysLeft}d · {debt.covenant}
                </div>
                <button
                  type="button"
                  className="shrink-0 text-[0.6875rem] text-mint hover:underline"
                  onClick={() => setState(repayTypedDebt(state, debt.id))}
                >
                  Repay
                </button>
              </div>
            ))}
          </div>
        </section>
        ) : (
        <>

        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Bank credit</h3>
          <span className="font-mono text-[0.75rem] text-muted">
            {loans.length}/{ECONOMY.loans.maxActive} open · {money(dayDebt)}/d service
          </span>
        </div>
        <p className="text-[0.6875rem] text-muted">Borrow against company value. Higher leverage raises rates.</p>

        {pendingApplications.length > 0 && (
          <div className="rounded-xl border border-amber/30 bg-amber/10 px-2.5 py-2 text-[0.75rem] text-amber">
            {pendingApplications.length} credit review{pendingApplications.length === 1 ? '' : 's'} pending · decision next day
          </div>
        )}

        {firmOffers.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">
              Firm offers
            </h4>
            {firmOffers.map((offer) => (
              <button
                key={offer.id}
                type="button"
                onClick={() => acceptLoanOffer(offer.id)}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-mint/35 bg-mint/5 px-2.5 py-2 text-left hover:border-mint/60"
              >
                <span>
                  <span className="block text-[0.8125rem] text-bone">Valuation facility</span>
                  <span className="font-mono text-[0.6875rem] text-muted">
                    {offer.termDays}d · {(offer.interestTotal * 100).toFixed(1)}% total interest · expires D{offer.expiresDay}
                  </span>
                </span>
                <span className="font-mono text-[0.8125rem] text-mint">Accept {money(offer.principal)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-1.5">
          <Stat label="Valuation" value={money(credit.valuation)} />
          <Stat label="Credit limit" value={money(credit.creditLimit)} />
          <Stat label="Outstanding" value={money(credit.outstanding)} />
          <Stat
            label="Available to draw"
            value={money(credit.available)}
            accent={credit.available >= minDraw ? 'text-mint' : 'text-amber'}
          />
        </div>

        <div className="rounded-xl border border-line/80 bg-void/30 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted">Live valuation bridge</h4>
            <span className={`font-mono text-[0.6875rem] ${valueDrivers.sota >= 0.95 ? 'text-mint' : 'text-amber'}`}>
              {valueDrivers.sota >= 0.95 ? 'SOTA premium' : `${Math.max(0, valueDrivers.frontier - valueDrivers.bestCap).toFixed(0)} cap behind`}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[0.625rem]">
            <BridgeRow label="Earnings value" value={valueDrivers.earningsValue} />
            <BridgeRow label="Model IP / SOTA" value={valueDrivers.modelIp} />
            <BridgeRow label="Plant + fleet" value={valueDrivers.plantAndFleet} />
            <BridgeRow label="Talent + research" value={valueDrivers.talentAndResearch} />
            <BridgeRow label="Cash credit" value={valueDrivers.cashCredit} />
            <BridgeRow label="Debt deduction" value={-valueDrivers.debt * 0.85} />
          </div>
          <p className="mt-2 text-[0.625rem] leading-snug text-muted">
            Profit changes the earnings multiple; gaining or losing the frontier reprices model IP;
            completed assets support secured lending. Daily downside is smoothed, not frozen.
          </p>
        </div>

        <div className="rounded-xl border border-line/80 bg-void/30 px-2.5 py-2">
          <div className="mb-1 flex justify-between font-mono text-[0.75rem] text-muted">
            <span>LTV used</span>
            <span>
              {pct(credit.ltv)} / {(credit.maxLtv * 100).toFixed(0)}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-void">
            <div
              className={`h-full ${credit.ltv / credit.maxLtv > 0.85 ? 'bg-amber' : 'bg-mint/80'}`}
              style={{
                width: `${Math.min(100, (credit.ltv / Math.max(0.01, credit.maxLtv)) * 100)}%`,
              }}
            />
          </div>
        </div>

        {loans.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">
              Open facilities
            </h4>
            {loans.map((l) => (
              <div
                key={l.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-line bg-void/40 px-2.5 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-bone">{l.label}</div>
                  <div className="font-mono text-[0.75rem] text-muted">
                    {money(l.remaining)} left · {money(l.dailyPayment)}/d · {l.daysLeft}d ·{' '}
                    {((l.interestTotal ?? 0) * 100).toFixed(1)}% int
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => repayLoan(l.id)}
                  className="shrink-0 rounded-lg border border-line px-2 py-1 text-[0.75rem] text-mint hover:bg-panel"
                >
                  Pay off
                </button>
              </div>
            ))}
          </div>
        )}

        {isBailoutEligible(state) && (
          <div className="rounded-xl border border-danger/40 bg-danger/10 p-2.5 space-y-1.5">
            <div className="text-[0.8125rem] font-medium text-danger">Cash stress — bailout available</div>
            <p className="text-[0.6875rem] leading-snug text-muted">
              Expensive short-term facility. Use only to avoid a crash; repay as soon as you can.
            </p>
            <button
              type="button"
              className="w-full rounded-lg bg-danger/25 py-1.5 text-[0.8125rem] font-medium text-danger hover:bg-danger/35"
              onClick={() => takeLoan('bailout')}
            >
              Take emergency bailout
            </button>
          </div>
        )}

        {offers.length > 0 && (
          <div className="space-y-1">
            <h4 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">
              Packaged facilities
            </h4>
            {offers.slice(0, 4).map((o) => {
              const daily = o.termDays > 0 ? (o.principal * (1 + o.interestTotal)) / o.termDays : 0
              const bail = o.id === 'bailout'
              return (
                <button
                  key={o.id}
                  type="button"
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left ${
                    bail
                      ? 'border-danger/40 bg-danger/10 hover:border-danger/60'
                      : 'border-line hover:border-mint/40'
                  }`}
                  onClick={() => takeLoan(o.id)}
                >
                  <div className="min-w-0">
                    <div className={`text-[0.8125rem] ${bail ? 'text-danger' : 'text-bone'}`}>
                      Apply · {o.label}
                    </div>
                    <div className="font-mono text-[0.6875rem] text-muted">
                      {o.termDays}d · {(o.interestTotal * 100).toFixed(1)}% · {money(daily)}/d
                    </div>
                  </div>
                  <span
                    className={`shrink-0 font-mono text-[0.8125rem] ${bail ? 'text-danger' : 'text-mint'}`}
                  >
                    {money(o.principal)}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <div className="space-y-2 rounded-xl border border-mint/20 bg-mint/5 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-[0.8125rem] font-medium text-bone">Custom draw</h4>
            <span className="font-mono text-[0.75rem] text-muted">
              min {money(minDraw)} · max {money(maxDraw)}
            </span>
          </div>

          {maxDraw < minDraw ? (
            <p className="text-[0.75rem] text-amber">
              Credit line too thin to draw (need ≥ {money(minDraw)} available). Raise valuation or
              repay debt.
            </p>
          ) : (
            <>
              <SliderField
                label="Principal"
                value={clampedDraw}
                min={minDraw}
                max={drawCeil}
                step={Math.max(100_000, Math.floor((drawCeil - minDraw) / 200) || 100_000)}
                format={(v) => money(v)}
                colorClass="bg-mint"
                accentClass="text-mint"
                onChange={setCustomAmt}
              />
              <SliderField
                label="Term"
                value={customTerm}
                min={14}
                max={180}
                step={1}
                format={(v) => `${Math.round(v)} days`}
                colorClass="bg-infer"
                accentClass="text-infer"
                onChange={(v) => setCustomTerm(Math.round(v))}
              />

              <div className="grid grid-cols-2 gap-1.5 font-mono text-[0.75rem]">
                <QuoteStat label="Interest rate" value={`${(quoteInterest * 100).toFixed(1)}%`} />
                <QuoteStat label="Total interest" value={money(clampedDraw * quoteInterest)} />
                <QuoteStat label="Total repay" value={money(quoteTotalDue)} />
                <QuoteStat label="Daily payment" value={`${money(quoteDaily)}/d`} />
                <QuoteStat
                  label="Post-draw LTV"
                  value={pct(postLtv)}
                  warn={postLtv > credit.maxLtv * 0.9}
                />
                <QuoteStat
                  label="Cash after draw"
                  value={money(state.player.cash + clampedDraw)}
                />
              </div>

              <button
                type="button"
                disabled={!canDraw}
                className={`w-full rounded-xl py-2 text-[0.8125rem] font-medium ${
                  canDraw
                    ? 'bg-mint/25 text-mint hover:bg-mint/35'
                    : 'bg-line/40 text-muted cursor-not-allowed'
                }`}
                onClick={() =>
                  takeCustomLoan({ principal: clampedDraw, termDays: customTerm })
                }
              >
                Draw {money(clampedDraw)} · {(quoteInterest * 100).toFixed(1)}% ·{' '}
                {money(quoteDaily)}/d
              </button>
            </>
          )}
        </div>
        </>
        )}
      </div>
      ) : null}

      {companyTab === 'marketing' ? (
      <div className="space-y-3 rounded-2xl border border-mint/20 bg-panel-2 p-3">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 className="text-[0.9375rem] font-semibold text-bone">Growth console</h3>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted">Buy reach, tune the mix, and defend share. Spend is billed daily.</p>
          </div>
          <div className="text-right">
            <span className="block font-mono text-[1.25rem] text-mint">{num(p.brandTrust, 0)}</span>
            <span className="text-[0.5625rem] uppercase text-muted">brand</span>
          </div>
        </div>
        <div className="grid grid-cols-5 gap-1">
          {[
            ['Pause', 0],
            ['$1M', 1_000_000],
            ['$5M', 5_000_000],
            ['$25M', 25_000_000],
            ['Max', marketingMax],
          ].map(([label, raw]) => {
            const value = Math.min(marketingMax, Number(raw))
            const active = Math.abs(p.marketingSpendPerDay - value) < 1
            return (
              <button
                key={String(label)}
                type="button"
                onClick={() => setMarketing(value)}
                className={`rounded border px-1 py-1.5 font-mono text-[0.625rem] ${active ? 'border-mint/60 bg-mint/15 text-mint' : 'border-line bg-void/35 text-muted hover:text-bone'}`}
              >
                {label}
              </button>
            )
          })}
        </div>
        <SliderField
          label="Total daily budget"
          value={p.marketingSpendPerDay}
          min={0}
          max={marketingMax}
          step={Math.max(25_000, Math.round(marketingMax / 500))}
          format={(value) => `${money(value)}/d`}
          colorClass="bg-mint"
          accentClass="text-mint"
          onChange={setMarketing}
        />

        <ChannelMixBar channels={channelSpend} total={p.marketingSpendPerDay} />

        <div className="grid grid-cols-2 gap-1.5">
          <ReachCard label="Web traffic" value={`${num(reach.webVisits, 0)} visits/d`} note="Fast subscription consideration" />
          <ReachCard label="Billboards" value={`${num(reach.billboardImpressions, 0)} views/d`} note="Broad awareness and brand" />
          <ReachCard label="Restaurant trials" value={`${num(reach.restaurantTrials, 0)} users/d`} note="Low-cost product sampling" />
          <ReachCard label="Enterprise events" value={`${num(reach.enterpriseLeads, 0)} leads/d`} note="Slower, high-value pipeline" />
        </div>

        <div className="space-y-2 rounded-xl border border-line/70 bg-void/35 p-2.5">
          {([
            ['web', 'Web acquisition', channelSpend.web, 'Traffic, search, affiliates, and conversion retargeting.'],
            ['billboards', 'Billboards & transit', channelSpend.billboards, 'Mass reach; strongest pure brand lift.'],
            ['restaurants', 'Restaurant partnerships', channelSpend.restaurants, 'Sponsored free trials and table-side product usage.'],
            ['enterprise', 'Enterprise field events', channelSpend.enterprise, 'Decision-maker leads, workshops, and account trust.'],
          ] as const).map(([channel, label, spend, description]) => (
            <div key={channel} className="rounded-lg border border-line/60 bg-panel-2/60 p-2">
              <SliderField
                label={label}
                value={spend}
                min={0}
                max={marketingMax}
                step={Math.max(10_000, Math.round(marketingMax / 1000))}
                format={(value) => `${money(value)}/d`}
                colorClass="bg-mint"
                accentClass="text-mint"
                onChange={(value) => setMarketingChannel(channel, value)}
              />
              <p className="mt-1 text-[0.625rem] leading-snug text-muted">{description}</p>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-line/70 bg-void/35 p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted">Competitive spend</h4>
            <span className="font-mono text-[0.625rem] text-muted">updates daily</span>
          </div>
          <SpendRace
            playerSpend={p.marketingSpendPerDay}
            rivals={rivalMarketing.map((rival) => ({
              id: rival.id,
              name: rival.name,
              spend: rival.marketingSpendPerDay ?? 0,
            }))}
          />
        </div>

        <div className="rounded-lg border border-line/70 bg-void/35 p-3 text-[0.75rem] leading-relaxed text-muted">
          <div className="flex justify-between gap-3">
            <span>Effective demand spend</span>
            <strong className="font-mono text-mint">{money(reach.demandEquivalentSpend)}/d</strong>
          </div>
          <p className="mt-1 text-[0.625rem]">Ceiling {money(marketingMax)}/d scales with cash and valuation. Returns diminish, and reach still churns when price or serving capacity disappoints.</p>
        </div>
      </div>
      ) : null}

      {companyTab === 'governance' ? (
        <GovernanceSummary state={state} />
      ) : null}
    </div>
  )
}

const BANKING_OFFER_PROFILE: Record<
  BankingProduct['kind'],
  { name: string; share: number }
> = {
  revolver: { name: 'Operating liquidity line', share: 0.35 },
  equipment: { name: 'Fleet expansion facility', share: 0.6 },
  project_finance: { name: 'Campus construction note', share: 0.5 },
  venture_debt: { name: 'Frontier runway facility', share: 0.3 },
  bond: { name: 'Institutional growth bond', share: 0.25 },
}

function bankingOfferAmount(product: BankingProduct): number {
  if (product.available < 100_000) return 0
  const proposed = Math.floor((product.available * BANKING_OFFER_PROFILE[product.kind].share) / 100_000) * 100_000
  return Math.min(product.available, Math.max(100_000, proposed))
}

function BankingOfferCard({
  product,
  sequence,
  onAccept,
}: {
  product: BankingProduct
  sequence: number
  onAccept: (amount: number) => void
}) {
  const profile = BANKING_OFFER_PROFILE[product.kind]
  const principal = bankingOfferAmount(product)
  const financingCost = principal * product.apr * (product.termDays / 365)
  const dailyService = product.termDays > 0
    ? (principal + financingCost) / product.termDays
    : 0
  const available = principal >= 100_000

  return (
    <article className={`overflow-hidden rounded-lg border bg-void/40 transition ${available ? 'border-line/80 hover:border-amber/40' : 'border-line/50 opacity-55'}`}>
      <div className="flex items-start justify-between gap-2 px-2.5 py-2">
        <div className="min-w-0">
          <div className="font-mono text-[0.5625rem] uppercase tracking-wider text-amber">
            Offer {String(sequence).padStart(2, '0')} · {product.label}
          </div>
          <h5 className="mt-0.5 text-[0.75rem] font-medium text-bone">{profile.name}</h5>
          <p className="mt-0.5 text-[0.625rem] leading-snug text-muted">{product.purpose}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[0.8125rem] text-bone">{available ? money(principal) : 'Unavailable'}</div>
          <div className="text-[0.5625rem] uppercase tracking-wide text-muted">offered principal</div>
        </div>
      </div>

      <dl className="grid grid-cols-4 border-y border-line/60 bg-panel-2/45">
        <OfferTerm label="Rate" value={`${(product.apr * 100).toFixed(1)}% APR`} />
        <OfferTerm label="Term" value={`${(product.termDays / 365).toFixed(1)} years`} />
        <OfferTerm label="Total cost" value={available ? money(financingCost) : '—'} />
        <OfferTerm label="Daily service" value={available ? `${money(dailyService)}/d` : '—'} />
      </dl>

      <div className="grid grid-cols-[1fr_auto] items-center gap-2 px-2.5 py-2">
        <div className="min-w-0 text-[0.5625rem] leading-snug text-muted">
          <span className="block font-mono text-bone">Available line {money(product.available)}</span>
          <span className="block truncate" title={product.covenant}>Covenant · {product.covenant}</span>
        </div>
        <button
          type="button"
          disabled={!available}
          onClick={() => onAccept(principal)}
          className="shrink-0 rounded border border-amber/35 bg-amber/10 px-2.5 py-1.5 font-mono text-[0.6875rem] text-amber transition hover:border-amber/60 hover:bg-amber/15 active:translate-y-px disabled:cursor-not-allowed disabled:border-line disabled:bg-line/20 disabled:text-muted"
        >
          {available ? `Accept ${money(principal)}` : 'Not eligible'}
        </button>
      </div>
    </article>
  )
}

function OfferTerm({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-r border-line/50 px-2 py-1.5 last:border-r-0">
      <dt className="truncate text-[0.5rem] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="truncate font-mono text-[0.625rem] text-bone" title={value}>{value}</dd>
    </div>
  )
}

function TeamBoard({
  staff,
  seats,
  wages,
  selectedRole,
  onSelectRole,
}: {
  staff: ReturnType<typeof playerStaff>
  seats: number
  wages: number
  selectedRole: StaffRole
  onSelectRole: (role: StaffRole) => void
}) {
  const total = staffTotal(staff)
  const openSeats = Math.max(0, seats - total)
  const roles = [
    ['researcher', 'Research', 'bg-mint', 'text-mint'],
    ['data_processor', 'Data', 'bg-sky-400', 'text-sky-400'],
    ['engineer', 'Engineering', 'bg-amber', 'text-amber'],
    ['ops', 'Operations', 'bg-violet-400', 'text-violet-400'],
  ] as const
  return (
    <section className="rounded-xl border border-line bg-void/35 p-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-xl text-bone">{total}<span className="text-sm text-muted">/{seats}</span></div>
          <div className="text-[0.625rem] text-muted">team seats · {Math.max(0, seats - total)} open</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[0.75rem] text-danger">{money(wages)}/d</div>
          <div className="text-[0.5625rem] uppercase tracking-wider text-muted">payroll</div>
        </div>
      </div>
      <div className="my-2 flex h-3 overflow-hidden rounded-sm bg-line/50">
        {roles.map(([role, label, color]) => (
          <button
            key={role}
            type="button"
            title={`${label}: ${staff[role]}`}
            aria-label={`Select ${label}, ${staff[role]} staff`}
            aria-pressed={selectedRole === role}
            onClick={() => onSelectRole(role)}
            className={`${color} min-w-1 transition hover:brightness-125 ${selectedRole === role ? 'ring-1 ring-inset ring-bone' : 'opacity-70'}`}
            style={{ width: `${seats > 0 ? staff[role] / seats * 100 : 0}%` }}
          />
        ))}
        {openSeats > 0 && (
          <div
            title={`Empty seats: ${openSeats}`}
            aria-label={`${openSeats} empty team seats`}
            className="min-w-1 border-l border-bone/20 bg-line/30"
            style={{ width: `${seats > 0 ? openSeats / seats * 100 : 100}%` }}
          />
        )}
      </div>
      <div className="grid grid-cols-5 gap-1">
        {roles.map(([role, label, , dot]) => (
          <button key={role} type="button" onClick={() => onSelectRole(role)} className={`rounded px-1 py-1.5 text-left transition ${selectedRole === role ? 'bg-panel-2 text-bone' : 'text-muted hover:bg-panel-2/60'}`}>
            <span className={`mr-1 ${dot}`}>●</span>
            <span className="text-[0.5625rem]">{label}</span>
            <span className="block font-mono text-[0.75rem]">{staff[role]}</span>
          </button>
        ))}
        <div className="rounded border border-dashed border-line px-1 py-1.5 text-left text-muted" aria-label={`${openSeats} empty seats`}>
          <span className="mr-1 text-line">○</span>
          <span className="text-[0.5625rem]">Empty</span>
          <span className="block font-mono text-[0.75rem] text-bone">{openSeats}</span>
        </div>
      </div>
    </section>
  )
}

function CompanyPulse({
  cash,
  net,
  brand,
  control,
  team,
  seats,
  history,
}: {
  cash: number
  net: number
  brand: number
  control: number
  team: number
  seats: number
  history: FinanceDaySnapshot[]
}) {
  type PulseMetric = 'cash' | 'valuation' | 'net' | 'share' | 'brand'
  const [metric, setMetric] = useState<PulseMetric>('cash')
  const [hoveredMetric, setHoveredMetric] = useState<PulseMetric | null>(null)
  const recent = history.slice(-30)
  const metrics = {
    cash: { label: 'Cash', description: 'Liquid cash available for payroll, facilities, data, and research.', values: recent.map((point) => point.cash), value: money(cash), color: 'text-mint' },
    valuation: { label: 'Value', description: 'Estimated company value from earnings, assets, talent, and model leadership.', values: recent.map((point) => point.valuation), value: recent.length ? money(recent.at(-1)?.valuation ?? 0) : '—', color: 'text-violet-400' },
    net: { label: 'P&L', description: 'Revenue minus every operating cost for the current day.', values: recent.map((point) => point.net), value: money(net), color: net < 0 ? 'text-danger' : 'text-mint' },
    share: { label: 'Share', description: 'Your share of AI demand after capacity and service quality are applied.', values: recent.map((point) => point.share), value: recent.length ? pct(recent.at(-1)?.share ?? 0, 1) : '—', color: 'text-sky-400' },
    brand: { label: 'Brand', description: 'Trust and awareness built through products, reliability, and marketing.', values: recent.map((point) => point.brand ?? brand), value: brand.toFixed(0), color: 'text-amber' },
  } as const
  const activeMetric = hoveredMetric ?? metric
  const selectedMetric = metrics[activeMetric]
  const path = sparkPath(selectedMetric.values, 180, 38, 2)
  const firstValue = selectedMetric.values[0]
  const lastValue = selectedMetric.values.at(-1)
  const change = firstValue == null || lastValue == null ? null : lastValue - firstValue
  const changeLabel = change == null
    ? 'Building history'
    : activeMetric === 'share'
      ? `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)} pts / 30d`
      : activeMetric === 'brand'
        ? `${change >= 0 ? '+' : ''}${change.toFixed(0)} / 30d`
        : `${change >= 0 ? '+' : ''}${money(change)} / 30d`
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-void/35">
      <div className="grid grid-cols-4 divide-x divide-line/70">
        <PulseStat label="Cash" value={money(cash)} />
        <PulseStat label="Day net" value={money(net)} tone={net < 0 ? 'danger' : 'mint'} />
        <PulseStat label="Control" value={pct(control)} tone={control < 0.1 ? 'danger' : undefined} />
        <PulseStat label="Team" value={`${team}/${seats}`} />
      </div>
      <div className="border-t border-line/70 px-2.5 py-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex gap-0.5">
            {(Object.keys(metrics) as (keyof typeof metrics)[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-describedby="company-pulse-detail"
                title={metrics[key].description}
                onClick={() => setMetric(key)}
                onMouseEnter={() => setHoveredMetric(key)}
                onMouseLeave={() => setHoveredMetric(null)}
                onFocus={() => setHoveredMetric(key)}
                onBlur={() => setHoveredMetric(null)}
                className={`rounded px-1.5 py-1 text-[0.5625rem] transition ${activeMetric === key ? 'bg-panel-2 text-bone' : 'text-muted hover:text-bone'}`}
              >
                {metrics[key].label}
              </button>
            ))}
          </div>
          <span className={`font-mono text-[0.6875rem] ${selectedMetric.color}`}>{selectedMetric.value}</span>
        </div>
        <svg viewBox="0 0 180 38" className={`h-10 w-full ${selectedMetric.color}`} preserveAspectRatio="none" aria-label={`30 day ${selectedMetric.label} trend`}>
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        <div id="company-pulse-detail" role="status" className="mt-1 flex items-start justify-between gap-2 border-t border-line/60 pt-1.5 text-[0.5625rem] leading-snug text-muted">
          <span>{selectedMetric.description}</span>
          <span className={`shrink-0 font-mono ${selectedMetric.color}`}>{changeLabel}</span>
        </div>
      </div>
    </section>
  )
}

function PulseStat({ label, value, tone }: { label: string; value: string; tone?: 'mint' | 'danger' }) {
  return (
    <div className="min-w-0 px-2 py-2">
      <div className="truncate text-[0.5625rem] uppercase tracking-wider text-muted">{label}</div>
      <div className={`truncate font-mono text-[0.75rem] ${tone === 'danger' ? 'text-danger' : tone === 'mint' ? 'text-mint' : 'text-bone'}`}>{value}</div>
    </div>
  )
}

function CapitalRail({ founder, debt, valuation, board }: { founder: number; debt: number; valuation: number; board: number }) {
  const debtShare = Math.min(1, debt / valuation)
  return (
    <div className="rounded-lg border border-line/70 bg-void/35 p-2">
      <div className="mb-1.5 flex justify-between font-mono text-[0.625rem] text-muted">
        <span>capital pressure</span>
        <span>{pct(Math.max(debtShare, board))}</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-line/60">
        <div className="bg-mint" style={{ width: `${Math.max(0, founder * 100)}%` }} title={`Founder control ${pct(founder)}`} />
        <div className="bg-amber" style={{ width: `${Math.max(0, Math.min(1 - founder, debtShare) * 100)}%` }} title={`Debt / value ${pct(debtShare)}`} />
        <div className="bg-danger" style={{ width: `${Math.max(0, Math.min(1 - founder - debtShare, board) * 100)}%` }} title={`Board pressure ${pct(board)}`} />
      </div>
      <div className="mt-1 flex justify-between text-[0.5625rem] text-muted">
        <span>Founder {pct(founder)}</span><span>Debt {pct(debtShare)}</span><span>Board {pct(board)}</span>
      </div>
    </div>
  )
}

function ChannelMixBar({ channels, total }: { channels: ReturnType<typeof marketingChannels>; total: number }) {
  const rows = [
    ['Web', channels.web, 'bg-mint', 'text-mint'],
    ['Outdoor', channels.billboards, 'bg-sky-400', 'text-sky-400'],
    ['Trials', channels.restaurants, 'bg-amber', 'text-amber'],
    ['Enterprise', channels.enterprise, 'bg-violet-400', 'text-violet-400'],
  ] as const
  return (
    <div className="rounded-lg border border-line/70 bg-void/35 p-2">
      <div className="mb-1.5 flex h-3 overflow-hidden rounded-sm bg-line/50">
        {rows.map(([label, spend, color]) => (
          <div key={label} className={color} style={{ width: `${total > 0 ? spend / total * 100 : 0}%` }} title={`${label}: ${money(spend)}/d`} />
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1 text-[0.5625rem] text-muted">
        {rows.map(([label, spend, , dot]) => (
          <div key={label} className="min-w-0 truncate"><span className={dot}>●</span> {label} {total > 0 ? Math.round(spend / total * 100) : 0}%</div>
        ))}
      </div>
    </div>
  )
}

function SpendRace({ playerSpend, rivals }: { playerSpend: number; rivals: { id: string; name: string; spend: number }[] }) {
  const rows = [{ id: 'player', name: 'You', spend: playerSpend }, ...rivals]
  const max = Math.max(1, ...rows.map((row) => row.spend))
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.id} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-[0.625rem]">
          <span className={row.id === 'player' ? 'truncate text-mint' : 'truncate text-muted'}>{row.name}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-line/60"><div className={row.id === 'player' ? 'h-full bg-mint' : 'h-full bg-bone/45'} style={{ width: `${row.spend / max * 100}%` }} /></div>
          <span className="w-16 text-right font-mono text-muted">{money(row.spend)}/d</span>
        </div>
      ))}
    </div>
  )
}

function GovernanceSummary({ state }: { state: SimState }) {
  const applyState = (next: SimState) => useGameStore.setState({ state: next })
  const advanced = state.config.campaignRules.externalityMode === 'advanced'
  const account = state.externalities?.accounts[state.playerLabId]
  const incidents = (state.externalities?.incidents ?? []).filter(
    (incident) => incident.labId === state.playerLabId,
  )

  return (
    <div className="space-y-3 rounded-2xl border border-line bg-panel-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[0.9375rem] font-semibold text-bone">Governance & externalities</h3>
          <p className="mt-1 text-[0.75rem] leading-relaxed text-muted">
            {advanced
              ? 'Advanced rules meter every lab with identical carbon, cooling-water, provenance, and deployment-audit formulas.'
              : 'Standard mode keeps trust, safety, and reliability in products while disabling carbon, water, rights-enforcement, and audit costs.'}
          </p>
        </div>
        <span className={`rounded px-2 py-1 font-mono text-[0.625rem] uppercase ${advanced ? 'bg-amber/15 text-amber' : 'bg-mint/10 text-mint'}`}>
          {advanced ? 'Advanced' : 'Standard'}
        </span>
      </div>

      {advanced && account ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Energy this month" value={`${num(account.energyMWh, 0)} MWh`} />
            <Stat label="Compliance spend" value={money(account.complianceCost)} />
            <Stat
              label="Carbon allocation"
              value={`${num(account.carbonTons, 0)} / ${num(account.carbonBudgetTons, 0)} t`}
              accent={account.carbonTons > account.carbonBudgetTons ? 'text-danger' : 'text-bone'}
            />
            <Stat
              label="Water allocation"
              value={`${num(account.waterM3, 0)} / ${num(account.waterBudgetM3, 0)} m³`}
              accent={account.waterM3 > account.waterBudgetM3 ? 'text-danger' : 'text-bone'}
            />
            <Stat label="Data-rights risk" value={pct(account.rightsRisk)} />
            <Stat label="Deployment-audit risk" value={pct(account.auditRisk)} />
          </div>
          <div className="rounded-lg border border-line/70 bg-void/35 p-2.5">
            <div className="flex justify-between text-[0.75rem] text-muted">
              <span>Enforcement record</span>
              <span className="font-mono">{account.violations} finding{account.violations === 1 ? '' : 's'}</span>
            </div>
            {incidents.length === 0 ? (
              <p className="mt-1 text-[0.75rem] text-muted">No published enforcement actions.</p>
            ) : (
              incidents.slice(0, 4).map((incident) => (
                <div key={incident.id} className="mt-1.5 border-t border-line/60 pt-1.5 text-[0.75rem] text-bone">
                  {incident.description}
                  <span className="ml-1 font-mono text-danger">−{money(incident.fine)}</span>
                </div>
              ))
            )}
          </div>
        </>
      ) : null}

      <div className="border-t border-line/70 pt-3">
        <div className="mb-2">
          <h4 className="text-[0.8125rem] font-medium text-bone">Operating policies</h4>
          <p className="mt-0.5 text-[0.75rem] text-muted">
            Persistent guardrails prepare the next day through normal quotes, budgets, and order queues.
          </p>
        </div>
        <div className="space-y-1.5">
          {([
            ['overflowCloud', 'Overflow cloud', 'Lease capped emergency PF when serving load exceeds the target.'],
            ['allocation', 'Compute allocation', 'Rebalance train, serve, and research pools with serving headroom.'],
            ['dataProcessing', 'Data processing', 'Keep raw domain stock flowing into the finite processing queue.'],
            ['fleetDeployment', 'Fleet deployment', 'Review capacity weekly and order suitable racks within budget.'],
            ['productCapacity', 'Product capacity', 'Balance API and subscription priority from observed pressure.'],
          ] as const).map(([key, label, description]) => {
            const enabled = state.automation[key].enabled
            return (
              <button
                key={key}
                type="button"
                aria-pressed={enabled}
                onClick={() =>
                  applyState(
                    setAutomationPolicies(state, {
                      [key]: { ...state.automation[key], enabled: !enabled },
                    }),
                  )
                }
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-line/70 bg-void/35 px-2.5 py-2 text-left hover:border-mint/40"
              >
                <span>
                  <span className="block text-[0.8125rem] text-bone">{label}</span>
                  <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-muted">{description}</span>
                </span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase ${enabled ? 'bg-mint/15 text-mint' : 'bg-line/50 text-muted'}`}>
                  {enabled ? 'On' : 'Off'}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  accent = 'text-bone',
}: {
  label: string
  value: string
  accent?: string
}) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-2.5 py-2">
      <div className="text-[0.75rem] text-muted">{label}</div>
      <div className={`font-mono text-sm ${accent}`}>{value}</div>
    </div>
  )
}

function ReachCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border border-line bg-void/35 px-2.5 py-2">
      <div className="text-[0.6875rem] text-muted">{label}</div>
      <div className="font-mono text-[0.8125rem] text-bone">{value}</div>
      <div className="mt-0.5 text-[0.5625rem] leading-snug text-muted">{note}</div>
    </div>
  )
}

function BridgeRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-2 border-b border-line/40 py-0.5">
      <span className="text-muted">{label}</span>
      <span className={value < 0 ? 'text-danger' : 'text-bone'}>{money(value)}</span>
    </div>
  )
}

function QuoteStat({
  label,
  value,
  warn,
}: {
  label: string
  value: string
  warn?: boolean
}) {
  return (
    <div className="rounded-lg border border-line/70 bg-void/40 px-2 py-1.5">
      <div className="text-[0.6875rem] text-muted">{label}</div>
      <div className={`text-[0.8125rem] ${warn ? 'text-amber' : 'text-bone'}`}>{value}</div>
    </div>
  )
}
