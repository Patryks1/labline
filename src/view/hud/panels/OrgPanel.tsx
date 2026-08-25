import { useEffect, useMemo, useRef, useState } from "react";
import { ECONOMY } from "../../../sim/balance/economy";
import { staffTotal } from "../../../sim/balance/staff";
import {
  bankCreditSnapshot,
  dailyLoanPayment,
  interestForDraw,
  isBailoutEligible,
  loanOffers,
} from "../../../sim/systems/loans";
import {
  playerHqStaffCap,
  playerStaff,
  playerStaffOpenSeats,
} from "../../../sim/systems/staff";
import { isHqAnchor, isHqKind } from "../../../sim/systems/map";
import type {
  BuildableKind,
  FinanceDaySnapshot,
  SimState,
} from "../../../sim/types";
import {
  acceptInvestorPitch,
  acceptEquityOffer,
  applyForDebt,
  bankingProducts,
  buyBackEquity,
  capitalSnapshot,
  equityBuybackQuote,
  investorPitchModels,
  investorPitchPreview,
  repayDebt as repayTypedDebt,
  requestEquityOffers,
} from "../../../sim/systems/capital";
import type { BankingProduct } from "../../../sim/systems/capital";
import {
  marketingChannels,
  marketingReach,
  marketingRevenueBasis,
  marketingRevenueMultiple,
  MARKETING_MAX_REVENUE_MULTIPLE,
} from "../../../sim/systems/org";
import { computeMarketingOutcome } from "../../../sim/systems/marketing";
import { cashDistressStage } from "../../../sim/systems/victory";
import { useGameStore } from "../../../store/gameStore";
import { money, num, pct } from "../format";
import { SliderField } from "../ui/SliderField";
import { CardGrid, GameCard } from "../ui/kit";
import {
  HudButton,
  HudRange,
  HudSelect,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from "../ui/HudPrimitives";
import { facilityAnchorTiles } from "../../../sim/systems/worldAccess";
import { buildFinanceDashboardModel } from "../data/financeDashboardModel";
import { Sparkline } from "../ui/dataViz/Sparkline";
import { hqOfficeEffects } from "../../../sim/systems/hqOffice";

type CapitalView = "ownership" | "credit";

export function CapitalActionSelector({
  active,
  onChange,
}: {
  active: CapitalView;
  onChange: (view: CapitalView) => void;
}) {
  return (
    <div
      className="grid grid-cols-2 gap-1 rounded-lg bg-void/50 p-1"
      role="group"
      aria-label="Capital actions"
    >
      {(
        [
          ["ownership", "Ownership"],
          ["credit", "Credit"],
        ] as const
      ).map(([id, label]) => (
        <HudButton
          key={id}
          type="button"
          variant="ghost"
          aria-pressed={active === id}
          onClick={() => onChange(id)}
          className={`min-h-11 rounded-md px-2 py-1.5 text-[0.6875rem] transition sm:min-h-0 ${active === id ? "bg-panel-2 text-mint" : "text-muted hover:text-bone"}`}
        >
          {label}
        </HudButton>
      ))}
    </div>
  );
}

/**
 * Company operations plus the standalone Marketing workspace.
 */
export function OrgPanel({
  workspace = "company",
  embedded = false,
}: {
  workspace?: "company" | "marketing" | "capital";
  /** Skip a second Finances chrome when Capital is hosted as a tab. */
  embedded?: boolean;
}) {
  const state = useGameStore((s) => s.state);
  const setState = (next: typeof state) =>
    useGameStore.setState({ state: next });
  const setMarketing = useGameStore((s) => s.setMarketing);
  const setMarketingChannel = useGameStore((s) => s.setMarketingChannel);
  const takeLoan = useGameStore((s) => s.takeLoan);
  const takeCustomLoan = useGameStore((s) => s.takeCustomLoan);
  const acceptLoanOffer = useGameStore((s) => s.acceptLoanOffer);
  const declineLoanOffer = useGameStore((s) => s.declineLoanOffer);
  const repayLoan = useGameStore((s) => s.repayLoan);
  const openSites = useGameStore((s) => s.openSites);

  const p = state.player;
  const financeModel = useMemo(() => buildFinanceDashboardModel(state), [state]);
  const staff = playerStaff(state);
  const seats = playerHqStaffCap(state);
  const openSeats = playerStaffOpenSeats(state);
  const loans = p.loans ?? [];
  const dayDebt = dailyLoanPayment(loans);
  const credit = useMemo(() => bankCreditSnapshot(state), [state]);
  const offers = useMemo(() => loanOffers(state), [state]);
  const packagedOffers = useMemo(
    () => offers.filter((o) => o.id !== "bailout"),
    [offers],
  );
  const firmOffers = state.worldMarkets.loanOffers.filter(
    (offer) =>
      offer.labId === state.playerLabId && offer.expiresDay >= state.day,
  );
  const pendingApplications = state.worldMarkets.loanApplications.filter(
    (application) =>
      application.labId === state.playerLabId &&
      application.status === "pending",
  );
  const pendingApplication = pendingApplications[0];
  const firmOffer = firmOffers[0];
  const creditRequestOpen = pendingApplication != null || firmOffer != null;
  const canAcceptFirmOffer = loans.length < (ECONOMY.loans.maxActive ?? 4);
  const minDraw = ECONOMY.loans.minDraw ?? 5_000_000;
  const maxDraw = Math.max(0, Math.floor(credit.available));
  const drawCeil = Math.max(minDraw, maxDraw);
  const [customAmt, setCustomAmt] = useState(() =>
    Math.min(maxDraw, Math.max(minDraw, Math.floor(maxDraw * 0.35))),
  );
  const [customTerm, setCustomTerm] = useState(45);
  const [companyTab] = useState<
    "staff" | "funding" | "marketing"
  >(workspace === "marketing" ? "marketing" : workspace === "capital" ? "funding" : "staff");
  const [capitalView, setCapitalView] = useState<CapitalView>("ownership");
  const [buybackPct, setBuybackPct] = useState(1);
  const pitchModels = useMemo(() => investorPitchModels(state), [state]);
  const [pitchModelId, setPitchModelId] = useState<string | null>(null);
  const capital = useMemo(() => capitalSnapshot(state), [state]);
  const equityOffers = useMemo(() => requestEquityOffers(state), [state]);
  const selectedPitchModelId = pitchModels.some((model) => model.id === pitchModelId)
    ? pitchModelId
    : pitchModels[0]?.id ?? null;
  const pitchPreview = selectedPitchModelId
    ? investorPitchPreview(state, selectedPitchModelId)
    : null;
  const bankProducts = useMemo(() => bankingProducts(state), [state]);
  const featuredBankProducts = bankProducts.filter((product) =>
    FEATURED_BANK_KINDS.includes(product.kind as FeaturedBankKind),
  );
  const channelSpend = useMemo(() => marketingChannels(state), [state]);
  const reach = useMemo(() => marketingReach(state), [state]);
  const marketingOutcome = useMemo(() => computeMarketingOutcome(state), [state]);
  const distress = cashDistressStage(financeModel.current.cash);
  const marketingBasis = marketingRevenueBasis(state);
  const marketingMultiple = marketingRevenueMultiple(state);
  const rivalMarketing = useMemo(
    () =>
      [...state.rivals]
        .sort(
          (a, b) =>
            (b.marketingSpendPerDay ?? 0) - (a.marketingSpendPerDay ?? 0),
        )
        .slice(0, 4),
    [state.rivals],
  );
  const companyHealth = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        p.brandTrust * 0.28 +
          capital.founderOwnership * 100 * 0.25 +
          Math.min(100, (staffTotal(staff) / Math.max(1, seats)) * 100) * 0.17 +
          Math.min(
            100,
            Math.max(
              0,
              50 +
                (financeModel.current.net / Math.max(1, financeModel.revenue.total)) *
                  50,
            ),
          ) *
            0.3,
      ),
    ),
  );
  const marketingWorkspace = workspace === "marketing";
  const capitalWorkspace = workspace === "capital";

  // Keep draw inside the bank’s current line as valuation / debt moves
  useEffect(() => {
    setCustomAmt((prev) => {
      if (maxDraw < minDraw) return minDraw;
      return Math.min(maxDraw, Math.max(minDraw, prev));
    });
  }, [maxDraw, minDraw]);

  useEffect(() => {
    if (pitchModelId !== selectedPitchModelId) setPitchModelId(selectedPitchModelId);
  }, [pitchModelId, selectedPitchModelId]);

  const clampedDraw =
    maxDraw < minDraw ? 0 : Math.min(maxDraw, Math.max(minDraw, customAmt));
  const quoteInterest = useMemo(
    () =>
      clampedDraw > 0 ? interestForDraw(state, clampedDraw, customTerm) : 0,
    [state, clampedDraw, customTerm],
  );
  const quoteTotalDue = clampedDraw * (1 + quoteInterest);
  const quoteDaily = customTerm > 0 ? quoteTotalDue / customTerm : 0;
  const postLtv =
    credit.valuation > 1
      ? (credit.outstanding + quoteTotalDue) / credit.valuation
      : quoteTotalDue > 0
        ? 1
        : 0;
  const canDraw =
    clampedDraw >= minDraw &&
    loans.length < (ECONOMY.loans.maxActive ?? 4) &&
    maxDraw >= minDraw;

  const hqs = facilityAnchorTiles(state, { ownerId: "player" }).filter(
    (t) =>
      t.owner === "player" &&
      isHqKind(t.kind) &&
      isHqAnchor(t) &&
      t.buildingProgress >= t.buildingTarget,
  );

  const headcount = staffTotal(staff);
  const runwayLabel =
    Number.isFinite(financeModel.current.runwayDays) &&
    financeModel.current.runwayDays < 9000
      ? `${Math.max(0, Math.floor(financeModel.current.runwayDays))}d`
      : "∞";
  if (marketingWorkspace) {
    return (
      <PanelScaffold
        eyebrow="Growth"
        title="Marketing"
        description="Budget, channels, reach, brand."
      >
        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
          <MetricTile
            label="Brand trust"
            value={num(p.brandTrust, 0)}
            tone="gold"
          />
          <MetricTile
            label="Spend / day"
            value={money(p.marketingSpendPerDay)}
            detail={`${pct(marketingMultiple, 0)} of revenue`}
            tone="positive"
          />
          <MetricTile
            label="Demand equiv."
            value={money(reach.demandEquivalentSpend)}
            detail="/ day"
            tone="serve"
          />
          <MetricTile
            label="Acquired customers"
            value={num(marketingOutcome.acquiredCustomers, 0)}
            detail="/ day"
          />
          <MetricTile
            label="Effective CAC"
            value={
              marketingOutcome.effectiveCac > 0
                ? money(marketingOutcome.effectiveCac)
                : "—"
            }
            detail={`${num(marketingOutcome.qualifiedLeads, 0)} leads / day`}
          />
        </div>

        <div className="mt-3 space-y-3 anim-stagger">
          <GameCard eyebrow="Budget" title="Revenue allocation" tone="mint">
            <SliderField
              label="Revenue allocated"
              value={marketingMultiple}
              min={0}
              max={MARKETING_MAX_REVENUE_MULTIPLE}
              step={0.01}
              format={(value) =>
                value <= 0
                  ? "Off"
                  : `${pct(value, 0)} · ${money(marketingBasis * value)}/d`
              }
              colorClass="bg-mint"
              accentClass="text-mint"
              onChange={(value) => setMarketing(marketingBasis * value)}
            />
            <ChannelMixBar
              channels={channelSpend}
              total={p.marketingSpendPerDay}
              onChange={(channel, value) => setMarketingChannel(channel, value)}
            />
          </GameCard>

          <CardGrid min="11rem" className="anim-stagger">
            <GameCard eyebrow="Reach" title="Web traffic" tone="mint">
              <div className="font-mono text-xl font-semibold tabular-nums text-bone">
                {num(reach.webVisits, 0)}
              </div>
              <p className="mt-1 text-[0.8125rem] text-muted">visits / day</p>
            </GameCard>
            <GameCard eyebrow="Reach" title="Billboards" tone="infer">
              <div className="font-mono text-xl font-semibold tabular-nums text-bone">
                {num(reach.billboardImpressions, 0)}
              </div>
              <p className="mt-1 text-[0.8125rem] text-muted">views / day</p>
            </GameCard>
            <GameCard eyebrow="Reach" title="Restaurant trials" tone="train">
              <div className="font-mono text-xl font-semibold tabular-nums text-bone">
                {num(reach.restaurantTrials, 0)}
              </div>
              <p className="mt-1 text-[0.8125rem] text-muted">users / day</p>
            </GameCard>
            <GameCard eyebrow="Reach" title="Enterprise events" tone="research">
              <div className="font-mono text-xl font-semibold tabular-nums text-bone">
                {num(reach.enterpriseLeads, 0)}
              </div>
              <p className="mt-1 text-[0.8125rem] text-muted">leads / day</p>
            </GameCard>
          </CardGrid>

          <GameCard eyebrow="Impact" title="Measured acquisition" tone="mint">
            <div className="grid grid-cols-2 gap-1.5">
              <Stat
                label="Qualified leads"
                value={`${num(marketingOutcome.qualifiedLeads, 0)}/d`}
              />
              <Stat
                label="Customers won"
                value={`${num(marketingOutcome.acquiredCustomers, 0)}/d`}
              />
              <Stat
                label="Enterprise leads"
                value={`${num(marketingOutcome.enterpriseLeads, 1)}/d`}
              />
              <Stat
                label="Brand lift"
                value={`+${num(marketingOutcome.brandGain, 2)}/d`}
              />
            </div>
            <div className="mt-2 space-y-1">
              {(
                [
                  ["web", "Web & developer"],
                  ["billboards", "Billboards"],
                  ["restaurants", "Restaurants"],
                  ["enterprise", "Enterprise"],
                ] as const
              ).map(([channel, label]) => {
                const slice = marketingOutcome.channelBreakdown[channel];
                return (
                  <div
                    key={channel}
                    className="flex items-center justify-between gap-2 rounded border border-line/60 bg-void/35 px-2 py-1 font-mono text-[0.6875rem] tabular-nums"
                  >
                    <span className="text-muted">{label}</span>
                    <span className="text-bone">
                      {num(slice.effectiveAcquisitions, 1)} customers ·{" "}
                      {slice.spend > 0
                        ? money(slice.spend / Math.max(0.01, slice.effectiveAcquisitions))
                        : "—"}{" "}
                      CAC
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[0.6875rem] text-muted">
              Market expansion {num(marketingOutcome.marketExpansion, 0)} new
              reachable customers / day. Saturation caps each channel — past
              its audience, extra spend buys little.
            </p>
          </GameCard>

          <GameCard eyebrow="Competition" title="Spend race">
            <SpendRace
              playerSpend={p.marketingSpendPerDay}
              rivals={rivalMarketing.map((rival) => ({
                id: rival.id,
                name: rival.name,
                spend: rival.marketingSpendPerDay ?? 0,
              }))}
            />
          </GameCard>
        </div>
      </PanelScaffold>
    );
  }

  const body = (
    <>
      {!capitalWorkspace ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile
          label="Headcount"
          value={`${headcount}/${seats}`}
          detail={`${openSeats} open`}
        />
        <MetricTile
          label="Cash runway"
          value={runwayLabel}
          tone={
            Number.isFinite(financeModel.current.runwayDays) &&
              financeModel.current.runwayDays < 30
              ? "danger"
              : Number.isFinite(financeModel.current.runwayDays) &&
                  financeModel.current.runwayDays < 90
                ? "warning"
                : "neutral"
          }
        />
        <MetricTile
          label="Brand trust"
          value={num(p.brandTrust, 0)}
          detail={`Net ${money(financeModel.current.net)}/d`}
          tone={financeModel.current.net < 0 ? "danger" : "gold"}
        />
      </div> : null}

      {!capitalWorkspace && distress !== "stable" && (
        <div
          className={`mt-3 rounded-lg border px-3 py-2 text-[0.75rem] leading-snug ${
            distress === "distressed"
              ? "border-amber/35 bg-amber/10 text-amber"
              : "border-danger/40 bg-danger/10 text-danger"
          }`}
        >
          {distress === "distressed" && (
            <>
              <span className="font-medium">Cash distress.</span> Cash is below
              zero — credit gets expensive and vendor terms may worsen. Raise
              cash, cut burn, or take emergency funding in Capital.
            </>
          )}
          {distress === "severe" && (
            <>
              <span className="font-medium">Severe distress.</span> Cash below
              -$100M. Lenders charge distress rates; an emergency facility may
              be available in Capital.
            </>
          )}
          {distress === "final" && (
            <>
              <span className="font-medium">Final warning.</span> Cash below
              -$250M. At -$500M the board forces a fire sale and the run ends.
            </>
          )}
          {distress === "bankrupt" && (
            <>
              <span className="font-medium">Bankruptcy.</span> Cash at or below
              -$500M — the company is being wound down.
            </>
          )}
        </div>
      )}

      <div key={companyTab} className={`panel-swap space-y-3${embedded ? '' : ' mt-3'}`}>
        {companyTab === "staff" ? (
          <>
            <HqOfficeSummary state={state} hqs={hqs} />
            <GameCard eyebrow="Office-owned" title="Team management lives on the floor" tone="mint">
              <p className="text-[0.8125rem] leading-5 text-muted">
                Open an HQ from the map or the floor list above to place desks,
                inspect seat capacity, hire local staff, and poach specialists.
              </p>
              {hqs.length === 0 ? (
                <HudButton type="button" variant="secondary" className="mt-3" onClick={() => openSites()}>
                  Open sites
                </HudButton>
              ) : null}
            </GameCard>
          </>
        ) : null}

        {companyTab === "funding" ? (
          <div className="rounded-lg border border-line bg-panel-2 p-3 space-y-3">
            <CapitalActionSelector
              active={capitalView}
              onChange={setCapitalView}
            />
            {capitalView === "ownership" ? (
              <section className="space-y-2 border-b border-line/70 pb-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
                    Capital stack
                  </h3>
                  <span className="font-mono text-[0.75rem] text-mint">
                    founders {(capital.founderOwnership * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <Stat label="Cash" value={money(financeModel.current.cash)} />
                  <Stat
                    label="Runway"
                    value={
                        Number.isFinite(financeModel.current.runwayDays)
                        ? `${Math.max(0, Math.floor(financeModel.current.runwayDays))}d`
                        : "∞"
                    }
                  />
                  <Stat
                    label="Typed debt"
                    value={money(capital.debtOutstanding)}
                  />
                  <Stat
                    label="Board pressure"
                    value={pct(capital.boardPressure)}
                    accent={
                      capital.boardPressure > 0.65 ? "text-amber" : "text-bone"
                    }
                  />
                </div>
                <CapitalRail
                  founder={capital.founderOwnership}
                  debt={capital.debtOutstanding}
                  valuation={Math.max(1, financeModel.current.valuation)}
                  board={capital.boardPressure}
                />
                {state.player.capital?.restructuring.active &&
                  financeModel.current.cash < 0 && (
                  <div className="rounded-lg border border-danger/35 bg-danger/10 px-2 py-1.5 text-[0.6875rem] text-danger">
                    Recovery ladder:{" "}
                    {state.player.capital.restructuring.stage.replace("_", " ")}{" "}
                    · {state.player.capital.restructuring.daysLeft}d to
                    stabilize cash, refinance, raise equity, or sell assets.
                  </div>
                )}

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted">
                      Cap table & buybacks
                    </h4>
                    <span
                      className={`font-mono text-[0.6875rem] ${capital.founderOwnership < 0.1 ? "text-danger" : "text-muted"}`}
                    >
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
                  {(state.player.capital?.capTable ?? []).map(
                    (stake, index) => {
                      const ownership = Math.min(
                        stake.ownership,
                        buybackPct / 100,
                      );
                      const quote = equityBuybackQuote(
                        state,
                        stake.holderId,
                        ownership,
                      );
                      return (
                        <div
                          key={`${stake.holderId}-${index}`}
                          className="flex items-center justify-between gap-2 rounded border border-line/60 bg-void/35 px-2 py-1.5 font-mono text-[0.6875rem]"
                        >
                          <span className="min-w-0 text-muted">
                            <span className="block truncate">
                              {stake.holderName}
                            </span>
                            <span className="text-bone">
                              {(stake.ownership * 100).toFixed(2)}%
                            </span>
                          </span>
                          {quote ? (
                            <HudButton
                              type="button"
                              variant="ghost"
                              disabled={financeModel.current.cash < quote.cost}
                              onClick={() =>
                                setState(
                                  buyBackEquity(
                                    state,
                                    stake.holderId,
                                    ownership,
                                  ),
                                )
                              }
                              className="min-h-11 shrink-0 rounded border border-amber/30 px-2 py-1 text-amber hover:bg-amber/10 disabled:opacity-35 sm:min-h-0"
                            >
                              Buy {money(quote.cost)}
                            </HudButton>
                          ) : (
                            <span className="text-muted/70">locked</span>
                          )}
                        </div>
                      );
                    },
                  )}
                  {capital.founderOwnership < 0.1 && (
                    <div className="rounded border border-danger/35 bg-danger/10 px-2 py-1.5 text-[0.6875rem] text-danger">
                      Control warning:{" "}
                      {(capital.founderOwnership * 100).toFixed(1)}% founder
                      ownership remains. Below 5% ends the run.
                    </div>
                  )}
                </div>

                <div className="space-y-2 rounded-lg border border-mint/25 bg-mint/5 p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="text-[0.75rem] font-medium text-bone">
                        Pitch a model to investors
                      </h4>
                      <p className="mt-0.5 text-[0.625rem] leading-4 text-muted">
                        Internal checkpoints and released models can unlock a
                        model-backed raise. Capability, reliability, and data
                        freshness change the odds and dilution.
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-[0.625rem] uppercase tracking-wider text-mint">
                      seeded desk
                    </span>
                  </div>
                  {pitchModels.length === 0 ? (
                    <p className="rounded border border-line/60 bg-void/35 px-2 py-1.5 text-[0.6875rem] text-muted">
                      Keep an internal checkpoint or release a model before
                      opening an investor conversation.
                    </p>
                  ) : (
                    <>
                      <label className="block text-[0.625rem] uppercase tracking-wider text-muted" htmlFor="investor-pitch-model">
                        Model to disclose
                      </label>
                      <HudSelect
                        id="investor-pitch-model"
                        value={selectedPitchModelId ?? ""}
                        onChange={(event) => setPitchModelId(event.target.value)}
                        className="min-h-11 w-full rounded border border-line bg-void/60 px-2 text-[0.75rem] text-bone sm:min-h-0"
                        aria-label="Model to pitch to investors"
                      >
                        {pitchModels.map((model) => (
                          <option key={model.id} value={model.id} className="bg-void">
                            {model.name} · cap {model.capability.toFixed(0)} · {model.release === "released" || model.shipped ? "released" : "internal"}
                          </option>
                        ))}
                      </HudSelect>
                      {pitchPreview ? (
                        <div className="space-y-1.5 rounded border border-line/70 bg-void/35 p-2" aria-live="polite">
                          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                            <Stat label="Chance" value={`${(pitchPreview.successChance * 100).toFixed(0)}%`} accent={pitchPreview.successChance >= 0.6 ? "text-mint" : "text-amber"} />
                            <Stat label="Raise" value={pitchPreview.cashRaised > 0 ? money(pitchPreview.cashRaised) : "—"} />
                            <Stat label="Dilution" value={pitchPreview.investorOwnership > 0 ? `${(pitchPreview.investorOwnership * 100).toFixed(1)}%` : "—"} />
                            <Stat label="Data drag" value={`${(pitchPreview.overusePenalty * 100).toFixed(0)}%`} accent={pitchPreview.overusePenalty > 0.35 ? "text-amber" : "text-bone"} />
                          </div>
                          <p className="font-mono text-[0.625rem] leading-4 text-muted">
                            {pitchPreview.investorName} · {money(pitchPreview.preMoneyValuation)} pre / {money(pitchPreview.postMoneyValuation)} post · frontier {pitchPreview.frontierCapability.toFixed(0)} · confidence floor {(pitchPreview.confidenceRequired * 100).toFixed(0)}%
                          </p>
                          {pitchPreview.reason ? (
                            <p className="rounded border border-amber/25 bg-amber/5 px-2 py-1 text-[0.625rem] text-amber" role="status">
                              {pitchPreview.reason}
                            </p>
                          ) : null}
                          <HudButton
                            type="button"
                            variant="primary"
                            disabled={!pitchPreview.eligible}
                            onClick={() => setState(acceptInvestorPitch(state, pitchPreview.modelId))}
                            className="min-h-11 w-full rounded bg-mint/20 px-2 py-1.5 font-mono text-[0.6875rem] text-mint disabled:opacity-35 sm:min-h-0"
                            title={pitchPreview.eligible ? "Resolve the seeded investor pitch" : pitchPreview.reason}
                          >
                            Pitch {pitchPreview.modelName}
                          </HudButton>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="space-y-1.5">
                  <h4 className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted">
                    Equity term sheets
                  </h4>
                  {equityOffers.slice(0, 3).map((offer) => (
                    <div
                      key={offer.id}
                      className="rounded-lg border border-line/70 bg-void/35 p-2"
                    >
                      <div className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-start min-[420px]:justify-between">
                        <div className="min-w-0">
                          <div className="text-[0.75rem] text-bone">
                            {offer.investorName}
                          </div>
                          <div className="font-mono text-[0.625rem] text-muted">
                            {money(offer.preMoneyValuation)} pre ·{" "}
                            {money(offer.postMoneyValuation)} post ·{" "}
                            {(offer.investorOwnership * 100).toFixed(1)}%
                            dilution
                            {offer.optionPoolTopUp > 0
                              ? ` · +${(offer.optionPoolTopUp * 100).toFixed(1)}% pool`
                              : ""}
                          </div>
                        </div>
                        <HudButton
                          type="button"
                          variant="primary"
                          disabled={
                            (state.player.capital?.investorConfidence ?? 0) <
                            offer.confidenceRequired
                          }
                          onClick={() =>
                            setState(acceptEquityOffer(state, offer))
                          }
                          className="min-h-11 w-full shrink-0 rounded bg-mint/20 px-2 py-1 font-mono text-[0.6875rem] text-mint disabled:opacity-35 min-[420px]:min-h-0 min-[420px]:w-auto"
                        >
                          Raise {money(offer.cashRaised)}
                        </HudButton>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-2 rounded-lg border border-amber/20 bg-amber/5 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h4 className="text-[0.75rem] font-medium text-bone">
                        Bank offers
                      </h4>
                      <p className="mt-0.5 text-[0.625rem] text-muted">
                        Specialist lenders. Choose the fit for your next move.
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-[0.625rem] text-amber">
                      Updates daily
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {featuredBankProducts.map((product) => (
                      <BankingOfferCard
                        key={product.kind}
                        product={product}
                        onAccept={(amount) =>
                          setState(applyForDebt(state, product.kind, amount))
                        }
                      />
                    ))}
                  </div>
                  {(state.player.capital?.debt ?? []).map((debt) => (
                    <div
                      key={debt.id}
                      className="flex items-center justify-between gap-2 border-t border-line/60 pt-1.5"
                    >
                      <div className="min-w-0 font-mono text-[0.625rem] text-muted">
                        <span className="block truncate text-bone">
                          {debt.label}
                        </span>
                        {money(debt.remaining)} · {(debt.apr * 100).toFixed(1)}%
                        · {debt.daysLeft}d left
                      </div>
                      <HudButton
                        type="button"
                        variant="ghost"
                        className="min-h-11 shrink-0 px-2 text-[0.6875rem] text-mint hover:underline sm:min-h-0"
                        onClick={() => setState(repayTypedDebt(state, debt.id))}
                      >
                        Repay
                      </HudButton>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-bone">
                    Simple loans
                  </h3>
                  <span className="font-mono text-[0.75rem] tabular-nums text-muted">
                    {loans.length}/{ECONOMY.loans.maxActive} open
                  </span>
                </div>
                <p className="text-[0.8125rem] text-muted">
                  Borrow cash now. Pay it back daily.
                </p>

                {pendingApplication && (
                  <div className="rounded-lg border border-amber/30 bg-amber/10 px-2.5 py-2 text-[0.75rem] text-amber">
                    <span className="block font-medium">
                      Credit review pending
                    </span>
                    <span className="mt-0.5 block font-mono text-[0.6875rem] text-muted">
                      {money(pendingApplication.principal)} ·{" "}
                      {pendingApplication.termDays}d requested · decision next
                      day
                    </span>
                  </div>
                )}

                {firmOffer && (
                  <div className="space-y-2 rounded-lg border border-mint/35 bg-mint/5 p-3">
                    <div className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-start min-[420px]:justify-between">
                      <div className="min-w-0">
                        <h4 className="text-[0.8125rem] font-medium text-bone">
                          Credit offer ready
                        </h4>
                        <p className="mt-1 font-mono text-[0.6875rem] text-muted">
                          {firmOffer.termDays}d ·{" "}
                          {(firmOffer.interestTotal * 100).toFixed(1)}% total
                          interest ·{" "}
                          {money(
                            (firmOffer.principal *
                              (1 + firmOffer.interestTotal)) /
                              firmOffer.termDays,
                          )}
                          /d
                        </p>
                        <p className="mt-0.5 font-mono text-[0.6875rem] text-muted">
                          Expires D{firmOffer.expiresDay}
                        </p>
                      </div>
                      <span className="shrink-0 font-mono text-[0.875rem] text-mint">
                        {money(firmOffer.principal)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <HudButton
                        type="button"
                        variant="ghost"
                        onClick={() => declineLoanOffer(firmOffer.id)}
                        className="min-h-11 rounded-lg border border-line px-2 py-1.5 text-[0.75rem] text-muted hover:border-danger/40 hover:text-danger"
                      >
                        Decline
                      </HudButton>
                      <HudButton
                        type="button"
                        variant="primary"
                        disabled={!canAcceptFirmOffer}
                        onClick={() => acceptLoanOffer(firmOffer.id)}
                        title={
                          canAcceptFirmOffer
                            ? "Accept this credit offer"
                            : "Repay an open facility before accepting"
                        }
                        className="min-h-11 rounded-lg border border-mint/45 bg-mint/15 px-2 py-1.5 text-[0.75rem] font-medium text-mint hover:bg-mint/25 disabled:cursor-not-allowed disabled:border-line disabled:bg-line/20 disabled:text-muted"
                      >
                        {canAcceptFirmOffer
                          ? "Accept offer"
                          : "Facility limit reached"}
                      </HudButton>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat
                    label="Can borrow"
                    value={money(credit.available)}
                    accent={
                      credit.available >= minDraw ? "text-mint" : "text-amber"
                    }
                  />
                  <Stat
                    label="Already borrowed"
                    value={money(credit.outstanding)}
                  />
                  <Stat
                    label="Credit limit"
                    value={money(credit.creditLimit)}
                  />
                  <Stat label="Daily service" value={`${money(dayDebt)}/d`} />
                </div>
                <p className="text-[0.8125rem] text-muted">
                  Pick a loan below. Cash received, term, daily payment, and
                  total repay are shown up front.
                </p>

                {loans.length > 0 && (
                  <div className="space-y-1.5">
                    <h4 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">
                      Open facilities
                    </h4>
                    {loans.map((l) => (
                      <div
                        key={l.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-line bg-void/40 px-2.5 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-bone">
                            {l.label}
                          </div>
                          <div className="font-mono text-[0.75rem] text-muted">
                            {money(l.remaining)} left · {money(l.dailyPayment)}
                            /d · {l.daysLeft}d ·{" "}
                            {((l.interestTotal ?? 0) * 100).toFixed(1)}% int
                          </div>
                        </div>
                        <HudButton
                          type="button"
                          variant="ghost"
                          onClick={() => repayLoan(l.id)}
                          className="min-h-11 shrink-0 rounded-lg border border-line px-2 py-1 text-[0.75rem] text-mint hover:bg-panel sm:min-h-0"
                        >
                          Pay off
                        </HudButton>
                      </div>
                    ))}
                  </div>
                )}

                {state.player.cash < 0 && isBailoutEligible(state) && (
                  <div className="rounded-lg border border-danger/40 bg-danger/10 p-2.5 space-y-1.5">
                    <div className="text-[0.8125rem] font-medium text-danger">
                      Cash stress — bailout available
                    </div>
                    <p className="text-[0.6875rem] leading-snug text-muted">
                      Expensive short-term facility. Use only to avoid a crash;
                      repay as soon as you can.
                    </p>
                    <HudButton
                      type="button"
                      variant="danger"
                      className="min-h-11 w-full rounded-lg bg-danger/25 py-1.5 text-[0.8125rem] font-medium text-danger hover:bg-danger/35"
                      onClick={() => takeLoan("bailout")}
                    >
                      Take emergency bailout
                    </HudButton>
                  </div>
                )}

                {!creditRequestOpen && packagedOffers.length > 0 && (
                  <div className="space-y-1">
                    <h4 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">
                      Packaged facilities
                    </h4>
                    {packagedOffers.slice(0, 4).map((o) => {
                        const daily =
                          o.termDays > 0
                            ? (o.principal * (1 + o.interestTotal)) / o.termDays
                            : 0;
                        return (
                          <HudButton
                            key={o.id}
                            type="button"
                            variant="ghost"
                            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-line px-2.5 py-2 text-left hover:border-mint/40"
                            onClick={() => takeLoan(o.id)}
                          >
                            <div className="min-w-0">
                              <div className="text-[0.8125rem] text-bone">
                                Apply · {o.label}
                              </div>
                              <div className="font-mono text-[0.6875rem] text-muted">
                                {o.termDays}d ·{" "}
                                {(o.interestTotal * 100).toFixed(1)}% ·{" "}
                                {money(daily)}/d
                              </div>
                            </div>
                            <span className="shrink-0 font-mono text-[0.8125rem] text-mint">
                              {money(o.principal)}
                            </span>
                          </HudButton>
                        );
                      })}
                  </div>
                )}

                {!creditRequestOpen && (
                  <div className="space-y-2 rounded-lg border border-mint/20 bg-mint/5 p-3">
                    <div className="flex flex-col gap-1 min-[420px]:flex-row min-[420px]:items-baseline min-[420px]:justify-between">
                      <h4 className="text-[0.8125rem] font-medium text-bone">
                        Custom draw
                      </h4>
                      <span className="font-mono text-[0.75rem] text-muted">
                        min {money(minDraw)} · max {money(maxDraw)}
                      </span>
                    </div>

                    {maxDraw < minDraw ? (
                      <p className="text-[0.75rem] text-amber">
                        Credit line too thin to draw (need ≥ {money(minDraw)}{" "}
                        available). Raise valuation or repay debt.
                      </p>
                    ) : (
                      <>
                        <SliderField
                          label="Principal"
                          value={clampedDraw}
                          min={minDraw}
                          max={drawCeil}
                          step={Math.max(
                            100_000,
                            Math.floor((drawCeil - minDraw) / 200) || 100_000,
                          )}
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
                            <QuoteStat
                            label="Interest rate"
                            value={`${(quoteInterest * 100).toFixed(1)}%`}
                          />
                          <QuoteStat
                            label="Total interest"
                            value={money(clampedDraw * quoteInterest)}
                          />
                          <QuoteStat
                            label="Total repay"
                            value={money(quoteTotalDue)}
                          />
                          <QuoteStat
                            label="Daily payment"
                            value={`${money(quoteDaily)}/d`}
                          />
                          <QuoteStat
                            label="Post-draw LTV"
                            value={pct(postLtv)}
                            warn={postLtv > credit.maxLtv * 0.9}
                          />
                          <QuoteStat
                            label="Cash after draw"
                            value={money(financeModel.current.cash + clampedDraw)}
                          />
                        </div>

                        <HudButton
                          type="button"
                          variant="primary"
                          disabled={!canDraw}
                          className={`min-h-11 w-full rounded-lg py-2 text-[0.8125rem] font-medium ${
                            canDraw
                              ? "bg-mint/25 text-mint hover:bg-mint/35"
                              : "bg-line/40 text-muted cursor-not-allowed"
                          }`}
                          onClick={() =>
                            takeCustomLoan({
                              principal: clampedDraw,
                              termDays: customTerm,
                            })
                          }
                        >
                          Draw {money(clampedDraw)} ·{" "}
                          {(quoteInterest * 100).toFixed(1)}% ·{" "}
                          {money(quoteDaily)}/d
                        </HudButton>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : null}

      </div>
    </>
  );

  if (capitalWorkspace && embedded) {
    return body;
  }

  return (
    <PanelScaffold
      eyebrow={capitalWorkspace ? "Finances" : "People"}
      title={capitalWorkspace ? "Capital" : "Company"}
      description={
        capitalWorkspace
          ? "Ownership, credit, and recovery decisions."
          : "HQ capacity, hiring, and the people who run the lab."
      }
      actions={
        !capitalWorkspace ? (
          <StatusChip
            tone={
              companyHealth >= 70
                ? "positive"
                : companyHealth >= 40
                  ? "warning"
                  : "danger"
            }
          >
            Health {companyHealth}
          </StatusChip>
        ) : undefined
      }
    >
      {body}
    </PanelScaffold>
  );
}

const FEATURED_BANK_KINDS = [
  "revolver",
  "equipment",
  "project_finance",
  "venture_debt",
] as const;
type FeaturedBankKind = (typeof FEATURED_BANK_KINDS)[number];

const BANKING_OFFER_PROFILE: Record<
  FeaturedBankKind,
  { bank: string; name: string; share: number; locked: string }
> = {
  revolver: {
    bank: "Harbor Bank",
    name: "Cashflow credit",
    share: 0.35,
    locked: "Build recurring revenue to unlock",
  },
  equipment: {
    bank: "Foundry Finance",
    name: "Equipment loan",
    share: 0.6,
    locked: "Own racks to unlock",
  },
  project_finance: {
    bank: "Atlas Infrastructure",
    name: "Campus finance",
    share: 0.35,
    locked: "Build a data-center campus to unlock",
  },
  venture_debt: {
    bank: "Frontier Capital",
    name: "Growth loan",
    share: 0.3,
    locked: "Raise company value to unlock",
  },
};

function HqOfficeSummary({
  state,
  hqs,
}: {
  state: SimState;
  hqs: ReturnType<typeof facilityAnchorTiles>;
}) {
  const open = useGameStore((store) => store.openHqOfficeEditor);
  const layouts = state.hqOfficeLayouts ?? {};
  const totalSeats = hqs.reduce((sum, hq) => {
    const facilityId = hq.campusId ?? `facility:${hq.x},${hq.y}`;
    return sum + hqOfficeEffects(layouts[facilityId], hq.kind as BuildableKind).capacityBonus;
  }, 0);
  return (
    <section className="rounded-lg border border-mint/25 bg-mint/5 p-3">
      <div className="flex flex-col gap-2 min-[460px]:flex-row min-[460px]:items-start min-[460px]:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-mint">HQ floor plan</p>
          <h3 className="mt-1 text-[0.9375rem] font-semibold text-bone">Build a productive office</h3>
          <p className="mt-1 max-w-[42rem] text-[0.75rem] leading-relaxed text-muted">
            Furniture is persistent: desks add seats, and plants, copy stations,
            meeting rooms, and research walls improve the team&apos;s daily output.
          </p>
        </div>
        <div className="shrink-0 text-left min-[460px]:text-right">
          <div className="font-mono text-[0.8125rem] text-mint">+{totalSeats} fit-out seats</div>
          <div className="text-[0.625rem] text-muted">{hqs.length} completed HQ{hqs.length === 1 ? "" : "s"}</div>
        </div>
      </div>
      {hqs.length === 0 ? (
        <p className="mt-2 rounded border border-amber/25 bg-amber/5 px-2 py-1.5 text-[0.75rem] text-amber">Build a completed HQ to unlock the office floor editor.</p>
      ) : (
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {hqs.map((hq) => {
            const facilityId = hq.campusId ?? `facility:${hq.x},${hq.y}`;
            const effects = hqOfficeEffects(layouts[facilityId], hq.kind as BuildableKind);
            return (
              <div key={facilityId} className="flex items-center justify-between gap-2 rounded-md border border-line/70 bg-void/35 px-2.5 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[0.75rem] font-medium text-bone">{hq.name || "Headquarters"}</div>
                  <div className="font-mono text-[0.625rem] text-muted">{effects.objectCount} objects · +{effects.capacityBonus} seats · +{(effects.productivityBonus * 100).toFixed(1)}% output</div>
                </div>
                <HudButton type="button" variant="secondary" className="min-h-11 shrink-0 px-2 py-1 text-[0.6875rem] sm:min-h-0" onClick={() => open(facilityId)}>Open floor</HudButton>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function bankingOfferAmount(product: BankingProduct): number {
  if (product.available < 100_000) return 0;
  const profile = BANKING_OFFER_PROFILE[product.kind as FeaturedBankKind];
  if (!profile) return 0;
  const proposed =
    Math.floor((product.available * profile.share) / 100_000) * 100_000;
  return Math.min(product.available, Math.max(100_000, proposed));
}

function BankingOfferCard({
  product,
  onAccept,
}: {
  product: BankingProduct;
  onAccept: (amount: number) => void;
}) {
  const profile = BANKING_OFFER_PROFILE[product.kind as FeaturedBankKind];
  if (!profile) return null;
  const principal = bankingOfferAmount(product);
  const financingCost = principal * product.apr * (product.termDays / 365);
  const dailyService =
    product.termDays > 0 ? (principal + financingCost) / product.termDays : 0;
  const available = principal >= 100_000;

  return (
    <article
      className={`rounded-lg border bg-void/40 p-2.5 transition ${available ? "border-line/80 hover:border-amber/40" : "border-line/50"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border font-mono text-[0.6875rem] ${available ? "border-amber/35 bg-amber/10 text-amber" : "border-line bg-panel-2 text-muted"}`}
          >
            {profile.bank.charAt(0)}
          </span>
          <div className="min-w-0">
            <h5 className="truncate text-[0.75rem] font-medium text-bone">
              {profile.bank}
            </h5>
            <p className="truncate text-[0.625rem] text-muted">
              {profile.name} · {product.purpose}
            </p>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[0.5625rem] uppercase ${available ? "bg-mint/10 text-mint" : "bg-line/40 text-muted"}`}
        >
          {available ? "Ready" : "Locked"}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        <OfferTerm label="Amount" value={available ? money(principal) : "—"} />
        <OfferTerm label="Rate" value={`${(product.apr * 100).toFixed(1)}%`} />
        <OfferTerm
          label="Payment"
          value={available ? `${money(dailyService)}/d` : "—"}
        />
      </dl>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-line/50 pt-2">
        <span className="min-w-0 truncate text-[0.625rem] text-muted">
          {available
            ? `${Math.round(product.termDays / 30)} months · ${money(financingCost)} interest`
            : profile.locked}
        </span>
        <HudButton
          type="button"
          variant="secondary"
          disabled={!available}
          onClick={() => onAccept(principal)}
          className="min-h-11 shrink-0 rounded-md border border-amber/35 bg-amber/10 px-2.5 py-1 font-mono text-[0.6875rem] text-amber transition hover:border-amber/60 hover:bg-amber/15 active:translate-y-px disabled:cursor-not-allowed disabled:border-line disabled:bg-line/20 disabled:text-muted"
        >
          {available ? "Accept offer" : "Unavailable"}
        </HudButton>
      </div>
    </article>
  );
}

function OfferTerm({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-panel-2/55 px-2 py-1.5">
      <dt className="truncate text-[0.5rem] uppercase tracking-wider text-muted">
        {label}
      </dt>
      <dd
        className="truncate font-mono text-[0.625rem] text-bone"
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

/** Legacy export retained for downstream integrations; People no longer renders
 * this redundant history card because Finances owns KPI history. */
export function CompanyPulse({
  cash,
  net,
  brand,
  control,
  team,
  seats,
  history,
}: {
  cash: number;
  net: number;
  brand: number;
  control: number;
  team: number;
  seats: number;
  history: FinanceDaySnapshot[];
}) {
  type PulseMetric = "cash" | "valuation" | "net" | "share" | "brand";
  const [metric, setMetric] = useState<PulseMetric>("cash");
  const recent = history.slice(-30);
  const [scrubIndex, setScrubIndex] = useState(Math.max(0, recent.length - 1));
  useEffect(
    () => setScrubIndex(Math.max(0, recent.length - 1)),
    [recent.length],
  );
  const metrics = {
    cash: {
      label: "Cash",
      description:
        "Liquid cash available for payroll, facilities, data, and research.",
      values: recent.map((point) => point.cash),
      value: money(cash),
      color: "text-mint",
    },
    valuation: {
      label: "Value",
      description:
        "Estimated company value from earnings, assets, talent, and model leadership.",
      values: recent.map((point) => point.valuation),
      value: recent.length ? money(recent.at(-1)?.valuation ?? 0) : "—",
      color: "text-violet-400",
    },
    net: {
      label: "P&L",
      description: "Revenue minus every operating cost for the current day.",
      values: recent.map((point) => point.net),
      value: money(net),
      color: net < 0 ? "text-danger" : "text-mint",
    },
    share: {
      label: "Share",
      description:
        "Your share of AI demand after capacity and service quality are applied.",
      values: recent.map((point) => point.share),
      value: recent.length ? pct(recent.at(-1)?.share ?? 0, 1) : "—",
      color: "text-sky-400",
    },
    brand: {
      label: "Brand",
      description:
        "Trust and awareness built through products, reliability, and marketing.",
      values: recent.map((point) => point.brand ?? brand),
      value: brand.toFixed(0),
      color: "text-amber",
    },
  } as const;
  const activeMetric = metric;
  const selectedMetric = metrics[activeMetric];
  const selectedFormat = (value: number) =>
    activeMetric === "share"
      ? pct(value, 1)
      : activeMetric === "brand"
        ? value.toFixed(0)
        : money(value);
  const firstValue = selectedMetric.values[0];
  const lastValue = selectedMetric.values.at(-1);
  const change =
    firstValue == null || lastValue == null ? null : lastValue - firstValue;
  const changeLabel =
    change == null
      ? "Building history"
      : activeMetric === "share"
        ? `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)} pts / 30d`
        : activeMetric === "brand"
          ? `${change >= 0 ? "+" : ""}${change.toFixed(0)} / 30d`
          : `${change >= 0 ? "+" : ""}${money(change)} / 30d`;
  const scrubbedPoint = recent[scrubIndex];
  const scrubbedValue = selectedMetric.values[scrubIndex];
  const scrubbedLabel =
    scrubbedValue == null
      ? selectedMetric.value
      : activeMetric === "share"
        ? pct(scrubbedValue, 1)
        : activeMetric === "brand"
          ? scrubbedValue.toFixed(0)
          : money(scrubbedValue);
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-void/35">
      <div className="grid grid-cols-2 divide-x divide-y divide-line/70 sm:grid-cols-4 sm:divide-y-0">
        <PulseStat label="Cash" value={money(cash)} />
        <PulseStat
          label="Day net"
          value={money(net)}
          tone={net < 0 ? "danger" : "mint"}
        />
        <PulseStat
          label="Control"
          value={pct(control)}
          tone={control < 0.1 ? "danger" : undefined}
        />
        <PulseStat label="Team" value={`${team}/${seats}`} />
      </div>
      <div className="border-t border-line/70 px-2.5 py-2">
        <div className="mb-1.5 flex flex-col gap-1.5 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
          <div className="grid w-full grid-cols-5 gap-0.5 min-[420px]:flex min-[420px]:w-auto">
            {(Object.keys(metrics) as (keyof typeof metrics)[]).map((key) => (
              <HudButton
                key={key}
                type="button"
                variant="ghost"
                aria-describedby="company-pulse-detail"
                title={metrics[key].description}
                onClick={() => setMetric(key)}
                className={`min-h-11 rounded px-1.5 py-1 text-[0.5625rem] transition min-[420px]:min-h-0 ${activeMetric === key ? "bg-panel-2 text-bone" : "text-muted hover:text-bone"}`}
              >
                {metrics[key].label}
              </HudButton>
            ))}
          </div>
          <span
            className={`font-mono text-[0.6875rem] ${selectedMetric.color}`}
          >
            {scrubbedPoint ? `D${scrubbedPoint.day} · ` : ""}
            {scrubbedLabel}
          </span>
        </div>
        <Sparkline
          values={selectedMetric.values}
          days={recent.map((point) => point.day)}
          format={selectedFormat}
          label={`${selectedMetric.label} 30-day`}
          height={38}
          color="currentColor"
          className={`h-10 w-full ${selectedMetric.color}`}
          selectedIndex={scrubIndex}
          ariaLabel={`30 day ${selectedMetric.label} trend`}
          onActiveChange={(point) => {
            if (point) setScrubIndex(point.index)
          }}
        />
        {recent.length > 1 ? (
          <label className="mt-1 block text-[0.5625rem] text-muted">
            <span className="sr-only">History day</span>
            <HudRange
              min={0}
              max={recent.length - 1}
              step={1}
              value={scrubIndex}
              onChange={(event) => setScrubIndex(Number(event.target.value))}
              className="h-11 w-full accent-mint"
              aria-label={`Scrub ${selectedMetric.label} history`}
            />
          </label>
        ) : null}
        <div
          id="company-pulse-detail"
          role="status"
          className="mt-1 flex flex-col gap-1 border-t border-line/60 pt-1.5 text-[0.5625rem] leading-snug text-muted min-[420px]:flex-row min-[420px]:items-start min-[420px]:justify-between"
        >
          <span>{selectedMetric.description}</span>
          <span className={`shrink-0 font-mono ${selectedMetric.color}`}>
            {changeLabel}
          </span>
        </div>
      </div>
    </section>
  );
}

function PulseStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "mint" | "danger";
}) {
  return (
    <div className="min-w-0 px-2 py-2">
      <div className="truncate text-[0.5625rem] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div
        className={`truncate font-mono text-[0.75rem] ${tone === "danger" ? "text-danger" : tone === "mint" ? "text-mint" : "text-bone"}`}
      >
        {value}
      </div>
    </div>
  );
}

function CapitalRail({
  founder,
  debt,
  valuation,
  board,
}: {
  founder: number;
  debt: number;
  valuation: number;
  board: number;
}) {
  const debtShare = Math.min(1, debt / valuation);
  return (
    <div className="rounded-lg border border-line/70 bg-void/35 p-2">
      <div className="mb-1.5 flex justify-between font-mono text-[0.625rem] text-muted">
        <span>capital pressure</span>
        <span>{pct(Math.max(debtShare, board))}</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-line/60">
        <div
          className="bg-mint"
          style={{ width: `${Math.max(0, founder * 100)}%` }}
          title={`Founder control ${pct(founder)}`}
        />
        <div
          className="bg-amber"
          style={{
            width: `${Math.max(0, Math.min(1 - founder, debtShare) * 100)}%`,
          }}
          title={`Debt / value ${pct(debtShare)}`}
        />
        <div
          className="bg-danger"
          style={{
            width: `${Math.max(0, Math.min(1 - founder - debtShare, board) * 100)}%`,
          }}
          title={`Board pressure ${pct(board)}`}
        />
      </div>
      <div className="mt-1 flex justify-between text-[0.5625rem] text-muted">
        <span>Founder {pct(founder)}</span>
        <span>Debt {pct(debtShare)}</span>
        <span>Board {pct(board)}</span>
      </div>
    </div>
  );
}

function ChannelMixBar({
  channels,
  total: _total,
  onChange,
}: {
  channels: ReturnType<typeof marketingChannels>;
  total: number;
  onChange?: (
    channel: "web" | "billboards" | "restaurants" | "enterprise",
    value: number,
  ) => void;
}) {
  const order = ["web", "billboards", "restaurants", "enterprise"] as const;
  const labels = {
    web: "Web",
    billboards: "Outdoor",
    restaurants: "Trials",
    enterprise: "Enterprise",
  } as const;
  const colors = {
    web: "bg-mint",
    billboards: "bg-sky-400",
    restaurants: "bg-amber",
    enterprise: "bg-violet-400",
  } as const;
  const dots = {
    web: "text-mint",
    billboards: "text-sky-400",
    restaurants: "text-amber",
    enterprise: "text-violet-400",
  } as const;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<Record<
    (typeof order)[number],
    number
  > | null>(null);
  const live = draft ?? {
    web: channels.web,
    billboards: channels.billboards,
    restaurants: channels.restaurants,
    enterprise: channels.enterprise,
  };
  const liveTotal = Math.max(
    0,
    order.reduce((sum, key) => sum + live[key], 0),
  );

  const commitFromClientX = (clientX: number, finalize: boolean) => {
    const el = trackRef.current;
    if (!el || !onChange || liveTotal <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)),
    );
    const edges = [0];
    let running = 0;
    for (const key of order) {
      running += live[key] / liveTotal;
      edges.push(running);
    }
    // Find nearest interior divider (1..3)
    let best = 1;
    let bestDist = Infinity;
    for (let i = 1; i < edges.length - 1; i++) {
      const dist = Math.abs(ratio - edges[i]!);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    const leftKeys = order.slice(0, best);
    const rightKeys = order.slice(best);
    const leftShare = Math.max(
      0.02 * leftKeys.length,
      Math.min(1 - 0.02 * rightKeys.length, ratio),
    );
    const rightShare = 1 - leftShare;
    const leftBase = leftKeys.reduce((sum, key) => sum + channels[key], 0) || 1;
    const rightBase =
      rightKeys.reduce((sum, key) => sum + channels[key], 0) || 1;
    const next: Record<(typeof order)[number], number> = { ...channels };
    for (const key of leftKeys) {
      next[key] = liveTotal * leftShare * (channels[key] / leftBase);
    }
    for (const key of rightKeys) {
      next[key] = liveTotal * rightShare * (channels[key] / rightBase);
    }
    // Normalize tiny drift
    const sum = order.reduce((s, key) => s + next[key], 0) || 1;
    for (const key of order) next[key] = (next[key] / sum) * liveTotal;
    setDraft(next);
    if (finalize) {
      for (const key of order) onChange(key, next[key]);
      setDraft(null);
    }
  };

  return (
    <div className="rounded-lg border border-line/70 bg-void/35 p-3">
      <div className="mb-2 flex flex-col gap-1 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
        <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
          Channel mix
        </span>
        <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
          Drag dividers · ←/→ 1% · Shift 5%
        </span>
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Marketing channel allocation"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          liveTotal > 0 ? Math.round((live.web / liveTotal) * 100) : 0
        }
        className="mb-2 flex h-8 cursor-ew-resize overflow-hidden rounded-md border border-line/60 bg-line/40 outline-none focus-visible:ring-2 focus-visible:ring-mint/50"
        onPointerDown={(event) => {
          if (!onChange) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          commitFromClientX(event.clientX, false);
        }}
        onPointerMove={(event) => {
          if (
            !onChange ||
            !event.currentTarget.hasPointerCapture(event.pointerId)
          )
            return;
          commitFromClientX(event.clientX, false);
        }}
        onPointerUp={(event) => {
          if (!onChange) return;
          commitFromClientX(event.clientX, true);
        }}
        onKeyDown={(event) => {
          if (!onChange || liveTotal <= 0) return;
          const step = event.shiftKey ? 0.05 : 0.01;
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const delta = event.key === "ArrowLeft" ? -step : step;
          const webShare = live.web / liveTotal;
          const nextWeb = Math.max(0.02, Math.min(0.94, webShare + delta));
          const remain = 1 - nextWeb;
          const otherBase =
            live.billboards + live.restaurants + live.enterprise || 1;
          const next = {
            web: liveTotal * nextWeb,
            billboards: liveTotal * remain * (live.billboards / otherBase),
            restaurants: liveTotal * remain * (live.restaurants / otherBase),
            enterprise: liveTotal * remain * (live.enterprise / otherBase),
          };
          for (const key of order) onChange(key, next[key]);
        }}
      >
        {order.map((key) => (
          <div
            key={key}
            className={`${colors[key]} relative h-full`}
            style={{
              width: `${liveTotal > 0 ? (live[key] / liveTotal) * 100 : 0}%`,
            }}
            title={`${labels[key]}: ${money(live[key])}/d`}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {order.map((key) => (
          <div
            key={key}
            className="min-w-0 rounded-md border border-line/50 bg-panel-2/60 px-2 py-1.5"
          >
            <div className="truncate text-[0.6875rem] text-muted">
              <span className={dots[key]}>●</span> {labels[key]}
            </div>
            <div className="font-mono text-[0.8125rem] tabular-nums text-bone">
              {liveTotal > 0 ? Math.round((live[key] / liveTotal) * 100) : 0}%
            </div>
            <div className="font-mono text-[0.6875rem] tabular-nums text-muted">
              {money(live[key])}/d
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SpendRace({
  playerSpend,
  rivals,
}: {
  playerSpend: number;
  rivals: { id: string; name: string; spend: number }[];
}) {
  const rows = [{ id: "player", name: "You", spend: playerSpend }, ...rivals];
  const max = Math.max(1, ...rows.map((row) => row.spend));
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <div
          key={row.id}
          className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-[0.625rem]"
        >
          <span
            className={
              row.id === "player" ? "truncate text-mint" : "truncate text-muted"
            }
          >
            {row.name}
          </span>
          <div className="h-1.5 overflow-hidden rounded-full bg-line/60">
            <div
              className={
                row.id === "player" ? "h-full bg-mint" : "h-full bg-bone/45"
              }
              style={{ width: `${(row.spend / max) * 100}%` }}
            />
          </div>
          <span className="w-16 text-right font-mono text-muted">
            {money(row.spend)}/d
          </span>
        </div>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  accent = "text-bone",
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-2.5 py-2">
      <div className="text-[0.75rem] text-muted">{label}</div>
      <div className={`font-mono text-sm ${accent}`}>{value}</div>
    </div>
  );
}

function QuoteStat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line/70 bg-void/40 px-2 py-1.5">
      <div className="text-[0.6875rem] text-muted">{label}</div>
      <div className={`text-[0.8125rem] ${warn ? "text-amber" : "text-bone"}`}>
        {value}
      </div>
    </div>
  );
}
