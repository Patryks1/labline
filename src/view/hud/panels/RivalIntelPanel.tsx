import { useEffect, useMemo } from "react";
import { blendApiPrice } from "../../../sim/balance/pricing";
import { planAllowanceMTokPerMonth } from "../../../sim/systems/plans";
import { competitiveCatchUpSnapshot } from "../../../sim/systems/sharedMarkets";
import { useGameStore } from "../../../store/gameStore";
import {
  selectCompanyModels,
  selectPlayerCompany,
} from "../../../sim/company";
import { isLivePublicModel } from "../../../sim/modelRelease";
import { useUiStore } from "../../../store/uiStore";
import { money, num, pct } from "../format";
import { FeedPost } from "../ui/FeedPost";
import { GameCard, MeterBar, StatRow } from "../ui/kit";
import { EmptyState, HudButton, PanelScaffold, StatusChip } from "../ui/HudPrimitives";
import { buildFinanceDashboardModel } from "../data/financeDashboardModel";
import { normalizeTrainingJobs } from "../trainingJobViewModel";

import { HudDesktopDefaultDetails } from "../ui/HudDesktopDefaultDetails";

function RangeBar({
  label,
  values,
  format,
}: {
  label: string;
  values: [number, number] | undefined;
  format: (value: number) => string;
}) {
  if (!values) {
    return (
      <div className="rounded-lg border border-line/60 bg-void/35 px-2.5 py-2">
        <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
          {label}
        </div>
        <div className="mt-1 font-mono text-[0.875rem] text-muted">—</div>
      </div>
    );
  }
  const [min, max] = values;
  const mid = (min + max) / 2;
  const span = Math.max(1e-9, max - min);
  const left = 12;
  const width = Math.max(
    18,
    Math.min(76, (span / Math.max(Math.abs(max), Math.abs(min), 1)) * 100),
  );
  return (
    <div className="min-w-0 rounded-lg border border-line/60 bg-void/35 px-2.5 py-2">
      <div className="flex flex-col gap-1 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
        <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
          {label}
        </div>
        <div className="min-w-0 font-mono text-[0.75rem] tabular-nums text-bone min-[420px]:text-right">
          {format(min)} – {format(max)}
        </div>
      </div>
      <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-panel">
        <div
          className="absolute inset-y-0 rounded-full bg-research/55"
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        <div
          className="absolute top-1/2 size-2 -translate-y-1/2 rounded-full bg-research"
          style={{ left: `calc(${left + width / 2}% - 0.25rem)` }}
          title={format(mid)}
        />
      </div>
    </div>
  );
}

/** Public-only rival intelligence. Exact private bids, cash, recipes, and research stay hidden. */
export function RivalIntelPanel() {
  const state = useGameStore((store) => store.state);
  const playerCompany = selectPlayerCompany(state);
  const playerModels = selectCompanyModels(state, playerCompany.id);
  const financeModel = useMemo(() => buildFinanceDashboardModel(state), [state]);
  const trainingJobs = useMemo(() => normalizeTrainingJobs(state), [state]);
  const selectedRivalId = useUiStore((store) => store.selectedRivalId);
  const setSelectedRivalId = useUiStore((store) => store.setSelectedRivalId);
  const rivals = state.rivals;
  const rankedRivals = useMemo(
    () =>
      rivals.toSorted((left, right) => right.marketShare - left.marketShare),
    [rivals],
  );

  useEffect(() => {
    if (selectedRivalId === "player" || !rankedRivals.length) return;
    if (
      selectedRivalId &&
      rankedRivals.some((entry) => entry.id === selectedRivalId)
    )
      return;
    setSelectedRivalId(rankedRivals[0]!.id);
  }, [rankedRivals, selectedRivalId, setSelectedRivalId]);

  const isPlayerSelected = selectedRivalId === "player";
  const rival =
    rankedRivals.find((entry) => entry.id === selectedRivalId) ??
    rankedRivals[0];

  if (!rival && !isPlayerSelected) {
    return (
      <PanelScaffold
        title="Rival intelligence"
        description="No rival labs in this campaign."
      >
        <EmptyState
          title="Empty field"
          description="This campaign has no rival labs to inspect."
        />
      </PanelScaffold>
    );
  }

  const estimate = rival?.publicEstimate;
  const publicModels = rival?.models.filter(isLivePublicModel) ?? [];
  const competitiveResponse = competitiveCatchUpSnapshot(state);
  const marketRows = [
    { id: "player", name: "You", share: financeModel.current.share },
    ...rankedRivals.map((entry) => ({
      id: entry.id,
      name: entry.name,
      share: entry.marketShare,
    })),
  ].toSorted((left, right) => right.share - left.share);

  const announcementPosts = [
    rival && estimate?.announcedProject
      ? {
          id: `${rival.id}-announced`,
          source: rival.name,
          dayLabel: `D${state.day}`,
          body: estimate.announcedProject,
          tone: "train" as const,
        }
      : null,
    ...state.news
      .filter(
        (line) =>
          rival && line.toLowerCase().includes(rival.name.toLowerCase()),
      )
      .slice(0, 3)
      .map((line, index) => ({
        id: `${rival?.id ?? "player"}-news-${index}`,
        source: rival?.name ?? playerCompany.identity.name,
        dayLabel: `D${Math.max(0, state.day - index)}`,
        body: line,
        tone: "serve" as const,
      })),
  ]
    .filter(Boolean)
    .slice(0, 3) as Array<{
    id: string;
    source: string;
    dayLabel: string;
    body: string;
    tone: "train" | "serve";
  }>;

  return (
    <PanelScaffold
      title="Rival intelligence"
      eyebrow={`Day ${state.day}`}
      description="Public offers, projects, and operating ranges."
      mobileDescription="Compare public rival signals."
    >
      <div className="space-y-3">
        <GameCard eyebrow="Field" title="Market position" tone="research">
          <div className="anim-stagger space-y-1.5">
            {marketRows.map((entry) => {
              const selected =
                entry.id === (isPlayerSelected ? "player" : rival?.id);
              const isPlayer = entry.id === "player";
              return (
                <HudButton
                  key={entry.id}
                  type="button"
                  variant="ghost"
                  aria-pressed={selected}
                  onClick={() => setSelectedRivalId(entry.id)}
                  className={`flex min-h-12 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition sm:min-h-11 sm:gap-3 ${
                    selected
                      ? "bg-research/10 ring-1 ring-research/35"
                      : isPlayer
                        ? "hover-lift bg-mint/8 hover:bg-mint/12"
                        : "hover-lift hover:bg-void/55"
                  }`}
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-[0.875rem] font-medium ${
                      selected
                        ? "text-research"
                        : isPlayer
                          ? "text-mint"
                          : "text-bone"
                    }`}
                  >
                    {entry.name}
                  </span>
                  <div className="w-[46%] min-w-[7rem] sm:w-[42%]">
                    <MeterBar
                      value={entry.share}
                      tone={
                        isPlayer
                          ? "positive"
                          : selected
                            ? "research"
                            : "warning"
                      }
                      detail={pct(entry.share, 0)}
                    />
                  </div>
                </HudButton>
              );
            })}
          </div>
        </GameCard>

        {isPlayerSelected ? (
          <>
            <GameCard
              eyebrow={playerCompany.identity.name || "Your company"}
              title="Company performance"
              tone="mint"
              actions={<StatusChip tone="positive">Exact</StatusChip>}
            >
              <div className="grid gap-x-5 min-[420px]:grid-cols-2">
                <StatRow
                  label="Cash"
                  value={money(financeModel.current.cash)}
                  tone={financeModel.current.cash < 0 ? "danger" : "positive"}
                />
                <StatRow
                  label="Runway"
                  value={
                    Number.isFinite(financeModel.current.runwayDays)
                      ? `${num(financeModel.current.runwayDays, 0)}d`
                      : "Profitable"
                  }
                />
                <StatRow
                  label="Revenue / day"
                  value={money(financeModel.current.revenue)}
                />
                <StatRow
                  label="Net / day"
                  value={money(financeModel.current.net)}
                  tone={financeModel.current.net < 0 ? "danger" : "positive"}
                />
              </div>
              <HudDesktopDefaultDetails className="group mt-2 border-t border-line/50 pt-1">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 py-2 text-[0.75rem] marker:hidden lg:min-h-0">
                  <span className="font-medium text-bone">Long-term position</span>
                  <span className="font-mono text-muted">{money(financeModel.current.valuation)} value · <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-180">⌄</span></span>
                </summary>
                <div className="grid gap-x-5 pb-1 min-[420px]:grid-cols-2">
                  <StatRow
                    label="Lifetime revenue"
                    value={money(financeModel.current.lifetimeRevenue)}
                  />
                  <StatRow
                    label="Lifetime net"
                    value={money(financeModel.current.lifetimeNet)}
                    tone={
                      financeModel.current.lifetimeNet < 0 ? "danger" : "positive"
                    }
                  />
                  <StatRow
                    label="Company value"
                    value={money(financeModel.current.valuation)}
                  />
                  <StatRow
                    label="Debt"
                    value={money(financeModel.current.debtOutstanding)}
                  />
                </div>
              </HudDesktopDefaultDetails>
            </GameCard>

            <GameCard
              eyebrow="Operations"
              title="Models & service"
              tone="infer"
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  [
                    "Released",
                    playerModels.filter(
                      isLivePublicModel,
                    ).length,
                  ],
                  [
                    "Internal",
                    playerModels.filter(
                      (model) => model.release !== "released" && !model.shipped,
                    ).length,
                  ],
                  [
                    "Training",
                    trainingJobs.length,
                  ],
                  [
                    "Subscribers",
                    state.lastMarket.planStats.reduce(
                      (sum, plan) => sum + plan.subscribers,
                      0,
                    ),
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-line/60 bg-void/35 px-3 py-2.5"
                  >
                    <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                      {label}
                    </div>
                    <strong className="mt-1 block font-mono text-lg tabular-nums text-bone">
                      {num(Number(value), 0)}
                    </strong>
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-0.5">
                <StatRow
                  label="API traffic"
                  value={`${num(state.lastMarket.apiDayMTok, 2)} MTok/d`}
                />
                <StatRow
                  label="Service"
                  value={
                    state.lastMarket.unservedRatio > 0.05
                      ? `${pct(state.lastMarket.unservedRatio, 0)} unserved`
                      : "Healthy"
                  }
                  tone={
                    state.lastMarket.unservedRatio > 0.05
                      ? "danger"
                      : "positive"
                  }
                />
                <StatRow
                  label="Brand trust"
                  value={num(playerCompany.ops.brandTrust, 0)}
                />
              </div>
            </GameCard>

            <GameCard eyebrow="Fleet" title="Your released models" tone="mint">
              {playerModels.filter(isLivePublicModel).length === 0 ? (
                <EmptyState
                  title="No public release"
                  description="Release a trained model to begin competing for demand."
                />
              ) : (
                <div className="anim-stagger space-y-2">
                  {playerModels
                    .filter(
                      isLivePublicModel,
                    )
                    .toSorted(
                      (left, right) => right.capability - left.capability,
                    )
                    .slice(0, 5)
                    .map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center gap-3 rounded-lg border border-line/60 bg-void/35 px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <strong className="block truncate text-[0.875rem] text-bone">
                            {model.name}
                          </strong>
                          <span className="text-[0.75rem] text-muted">
                            {model.backbone ?? model.family} ·{" "}
                            {num(model.paramsB, 1)}B
                          </span>
                        </div>
                        <div className="text-right">
                          <strong className="font-mono text-base tabular-nums text-mint">
                            {model.capability.toFixed(1)}
                          </strong>
                          <span className="block text-[0.6875rem] text-muted">
                            capability
                          </span>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </GameCard>
          </>
        ) : rival ? (
          <>
            <GameCard
              eyebrow={rival.name}
              title="Estimated range"
              tone="research"
              actions={
                <StatusChip tone="research">
                  {estimate ? `${pct(estimate.confidence, 0)} conf.` : "—"}
                </StatusChip>
              }
            >
              <div className="grid grid-cols-2 gap-2">
                <RangeBar
                  label="Compute"
                  values={estimate?.computePf}
                  format={(value) => `${num(value, 0)} PF`}
                />
                <RangeBar
                  label="Training data"
                  values={estimate?.dataMTok}
                  format={(value) => `${num(value, 0)} MTok`}
                />
                <RangeBar
                  label="Runway"
                  values={estimate?.runwayDays}
                  format={(value) => `${num(value, 0)}d`}
                />
                <RangeBar label="Cash" values={estimate?.cash} format={money} />
              </div>
              <div className="mt-3 space-y-0.5">
                <StatRow label="Focus" value={estimate?.focus ?? rival.archetype.replaceAll("_", " ")} />
                <StatRow
                  label="Current bet"
                  value={estimate?.currentBet ?? "Undisclosed"}
                />
                <StatRow
                  label="Debt"
                  value={
                    estimate
                      ? `${money(estimate.debt[0])} – ${money(estimate.debt[1])}`
                      : "—"
                  }
                />
                <StatRow
                  label="Service"
                  value={
                    (rival.lastUnserved ?? 0) > 0.05
                      ? `${pct(rival.lastUnserved ?? 0, 0)} short`
                      : "Healthy"
                  }
                  tone={
                    (rival.lastUnserved ?? 0) > 0.05 ? "danger" : "positive"
                  }
                />
              </div>
            </GameCard>

            <GameCard eyebrow="Wire" title="Recent announcements" tone="train">
              {announcementPosts.length === 0 ? (
                <EmptyState
                  title="No public posts"
                  description="Announced projects and rival headlines will appear here."
                />
              ) : (
                <div className="anim-stagger space-y-2">
                  {announcementPosts.map((post) => (
                    <FeedPost
                      key={post.id}
                      source={post.source}
                      dayLabel={post.dayLabel}
                      body={post.body}
                      tone={post.tone === "train" ? "warning" : "serve"}
                    />
                  ))}
                </div>
              )}
            </GameCard>

            {competitiveResponse.active &&
            competitiveResponse.rivalId === rival.id ? (
              <GameCard tone="mint" title="Lead challenger">
                <p className="text-[0.8125rem] text-mint">
                  Capital markets are funding accelerator purchases against a{" "}
                  {(competitiveResponse.shareGap * 100).toFixed(0)}-point share
                  gap
                  {competitiveResponse.capabilityGap >= 1
                    ? ` and ${competitiveResponse.capabilityGap.toFixed(0)} capability-point gap.`
                    : "."}
                </p>
              </GameCard>
            ) : null}

            <GameCard
              eyebrow="Public fleet"
              title="Released models & API"
              tone="infer"
            >
              <div
                className="anim-stagger space-y-2 lg:hidden"
                data-testid="rival-public-model-mobile-list"
              >
                {publicModels.map((model) => {
                  const input =
                    model.apiPriceInPerMTok ?? rival.pricing.apiPriceInPerMTok;
                  const output =
                    model.apiPriceOutPerMTok ?? rival.pricing.apiPriceOutPerMTok;
                  return (
                    <article
                      key={model.id}
                      className="rounded-lg border border-line/60 bg-void/35 p-2.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <strong className="block truncate text-[0.875rem] text-bone">
                            {model.name}
                          </strong>
                          <span className="mt-0.5 block truncate text-[0.6875rem] text-muted">
                            {model.backbone ?? model.family} · {num(model.paramsB, 1)}B
                          </span>
                        </div>
                        <span className="shrink-0 font-mono text-base font-semibold tabular-nums text-mint">
                          {model.capability.toFixed(0)} cap
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 border-t border-line/50 pt-2 font-mono text-[0.6875rem] tabular-nums">
                        <span className="min-w-0 text-bone">
                          ${input.toFixed(2)} in · ${output.toFixed(2)} out
                        </span>
                        <span className="text-right text-muted">
                          {num(
                            model.serviceProfile?.interactiveTokPerSec ??
                              52 * model.tokPerSecMult,
                            0,
                          )} tok/s
                        </span>
                      </div>
                    </article>
                  );
                })}
                {publicModels.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line px-3 py-5 text-center text-[0.8125rem] text-muted">
                    No public release.
                  </p>
                ) : null}
              </div>
              <div
                className="hidden overflow-x-auto overscroll-x-contain rounded-lg border border-line/60 lg:block"
                data-testid="rival-public-model-desktop-table"
              >
                <table className="w-full min-w-[42rem] text-left text-[0.8125rem]">
                  <thead className="bg-void/60 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                    <tr>
                      <th className="sticky left-0 z-10 bg-void px-3 py-2.5">Model</th>
                      <th className="px-3 py-2.5">Capability</th>
                      <th className="px-3 py-2.5">Price in / out</th>
                      <th className="px-3 py-2.5">Speed</th>
                      <th className="px-3 py-2.5">Features</th>
                    </tr>
                  </thead>
                  <tbody className="anim-stagger">
                    {publicModels.map((model) => {
                      const input =
                        model.apiPriceInPerMTok ??
                        rival.pricing.apiPriceInPerMTok;
                      const output =
                        model.apiPriceOutPerMTok ??
                        rival.pricing.apiPriceOutPerMTok;
                      return (
                        <tr
                          key={model.id}
                          className="border-t border-line/70 text-bone"
                        >
                          <td className="sticky left-0 z-10 bg-panel-2 px-3 py-3">
                            <strong className="text-[0.875rem]">
                              {model.name}
                            </strong>
                            <span className="mt-0.5 block text-[0.75rem] text-muted">
                              {model.backbone ?? model.family} ·{" "}
                              {num(model.paramsB, 1)}B
                            </span>
                          </td>
                          <td className="px-3 py-3 font-mono tabular-nums">
                            {model.capability.toFixed(0)}
                          </td>
                          <td className="px-3 py-3 font-mono tabular-nums">
                            ${input.toFixed(2)} / ${output.toFixed(2)}
                            <span className="mt-0.5 block text-[0.75rem] text-muted">
                              ${blendApiPrice(input, output).toFixed(2)} blend
                            </span>
                          </td>
                          <td className="px-3 py-3 font-mono tabular-nums">
                            {num(
                              model.serviceProfile?.interactiveTokPerSec ??
                                52 * model.tokPerSecMult,
                              0,
                            )}{" "}
                            tok/s
                          </td>
                          <td className="px-3 py-3 text-muted">
                            {model.modalities.join(", ")}
                          </td>
                        </tr>
                      );
                    })}
                    {publicModels.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-3 py-6 text-center text-muted"
                        >
                          No public release.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </GameCard>

            <GameCard eyebrow="Offers" title="Subscription offers" tone="mint">
              {(rival.pricing.plans ?? []).filter((plan) => plan.enabled)
                .length === 0 ? (
                <EmptyState
                  title="No public plans"
                  description="This rival has not disclosed consumer subscription offers."
                />
              ) : (
                <div className="anim-stagger grid gap-2 sm:grid-cols-2">
                  {(rival.pricing.plans ?? [])
                    .filter((plan) => plan.enabled)
                    .map((plan) => (
                      <div
                        key={plan.id}
                        className="rounded-lg border border-line/70 bg-void/35 px-3 py-2.5"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <strong className="truncate text-[0.875rem] text-bone">
                            {plan.name}
                          </strong>
                          <span className="shrink-0 font-mono text-[0.875rem] tabular-nums text-mint">
                            {money(plan.pricePerMonth)}/mo
                          </span>
                        </div>
                        <div className="mt-1 font-mono text-[0.8125rem] text-muted">
                          {num(planAllowanceMTokPerMonth(plan), 2)} MTok ·{" "}
                          {plan.servePrecision ?? "fp32"}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </GameCard>
          </>
        ) : null}
      </div>
    </PanelScaffold>
  );
}
