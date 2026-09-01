import { useState, type ReactNode } from "react";
import type {
  Model,
  ModelFinanceRow,
} from "../../../../sim/types";
import { productProfileFromModel } from "../../../../sim/balance/modelProduct";
import { EffortStudio } from "./EffortStudio";
import {
  normalizeModelEvaluations,
  suiteComposite,
} from "../../../../sim/balance/evaluationSuites";
import {
  isArchivedModel,
  isLivePublicModel,
} from "../../../../sim/modelRelease";
import { GameCard, CardGrid, MeterBar, StatRow } from "../../ui/kit";
import { EmptyState, HudButton, StatusChip } from "../../ui/HudPrimitives";
import { money, num } from "../../format";
import { modelAgeDays, modelFreshnessLabel } from "../../../../sim/balance/modelAging";
import { RadarChart } from "../../ui/RadarChart";
import {
  checkpointRivalDelta,
  confidenceLabel,
  type CheckpointUiRecord,
} from "./checkpointUi";
import { buildPublicBenchmarkData } from "../../data/benchmarkViewModel";
import { HudDesktopDefaultDetails } from "../../ui/HudDesktopDefaultDetails";
import { hudDesktopDefaultDisclosureOpen } from "../../ui/hudDesktopDisclosure";

const PREFERRED_SUITE_IDS = [
  "omni_overview",
  "image_generation",
  "video_generation",
  "audio_generation",
  "language",
] as const;

function modelTier(capability: number) {
  if (capability >= 80)
    return { label: "Breakthrough", floor: 80, nextAt: null as number | null };
  if (capability >= 60) return { label: "Frontier", floor: 60, nextAt: 80 };
  if (capability >= 40) return { label: "Competitive", floor: 40, nextAt: 60 };
  return { label: "Prototype", floor: 0, nextAt: 40 };
}

export function compareFleetFinishDay(
  a: Pick<Model, "releaseDay" | "id">,
  b: Pick<Model, "releaseDay" | "id">,
) {
  return b.releaseDay - a.releaseDay || a.id.localeCompare(b.id);
}

function fleetStatus(model: Model): "sold" | "archived" | "released" | "internal" {
  if (model.soldIp) return "sold";
  if (isArchivedModel(model)) return "archived";
  if (isLivePublicModel(model)) return "released";
  return "internal";
}

function FleetServingEconomics({ finance }: { finance: ModelFinanceRow }) {
  return (
    <div className="space-y-2">
      <div className="font-mono text-[0.6875rem] tabular-nums text-muted">
        cap {finance.capability.toFixed(0)} · {money(finance.apiPricePerMTok)}/MTok
      </div>
      <div className="space-y-0.5">
        <StatRow label="API rev" value={money(finance.dayApiRevenue)} />
        <StatRow label="API COGS" value={money(-finance.dayApiCogs)} tone="danger" />
        <StatRow label="API MTok" value={num(finance.dayApiMTok, 2)} />
        <StatRow label="Sub rev" value={money(finance.daySubRevenue)} />
        <StatRow label="Sub COGS" value={money(-finance.daySubCogs)} tone="danger" />
        <StatRow label="Enterprise" value={money(finance.dayEnterpriseShare)} />
      </div>
    </div>
  );
}

function FleetEvidenceDisclosure({
  status,
  summary,
  children,
}: {
  status: "archived" | "released" | "internal";
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(hudDesktopDefaultDisclosureOpen);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group mt-3 min-w-0 border-t border-line/50"
      data-fleet-radar={status}
      data-fleet-evidence-disclosure="compact"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 py-2 text-[0.6875rem] text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint/60 xl:hidden [@media(max-height:600px)]:!flex [&::-webkit-details-marker]:hidden">
        <span>Evaluation profile</span>
        <span className="font-mono text-bone">
          {summary} · <span className="group-open:hidden">Show radar</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <div
        className="min-w-0 overflow-hidden pt-3 max-xl:border-t max-xl:border-line/40 [@media(max-height:600px)]:border-t [@media(max-height:600px)]:border-line/40"
        data-shell-gesture-ignore="true"
      >
        {children}
      </div>
    </details>
  );
}

export function FleetTab({
  internal,
  released,
  archived = [],
  pricingId,
  onSelect,
  onRelease,
  onArchive,
  onRestore,
  onSellIp,
  ipSaleQuoteFor,
  onDelete,
  frontierCapability,
  onTrainFurther,
  onDistill,
  onSetDefaultEffort,
  onSetServedEffort,
  activeSafetyCampaignModelId,
  safetySlot,
  checkpointEvidence,
  modelFinance = [],
  day = 1,
}: {
  internal: Model[];
  released: Model[];
  archived?: Model[];
  pricingId: string | null;
  onSelect: (id: string) => void;
  onRelease: (id: string) => void;
  onArchive?: (id: string) => void;
  onRestore?: (id: string) => void;
  onSellIp?: (id: string) => void;
  ipSaleQuoteFor?: (model: Model) => number;
  onDelete: (id: string) => void;
  frontierCapability: number;
  /** Canonical $/MTok unit cost for suggested list prices. */
  unitCostForModel?: (model: Model) => number;
  onTrainFurther: (model: Model) => void;
  onDistill: (model: Model) => void;
  onSetDefaultEffort?: (id: string, effort: string) => void;
  onSetServedEffort?: (id: string, effort: string, served: boolean) => void;
  /** The active campaign source must remain visible until the campaign ends. */
  activeSafetyCampaignModelId?: string | null;
  safetySlot?: React.ReactNode;
  /** Persisted, noisy evidence for models promoted from stealth checkpoints. */
  checkpointEvidence?: Readonly<Record<string, CheckpointUiRecord>>;
  /** Day P&L attribution for public fleet cards. */
  modelFinance?: readonly ModelFinanceRow[];
  /** Campaign day, used for a light freshness hint on released cards. */
  day?: number;
}) {
  const financeById = new Map(modelFinance.map((row) => [row.modelId, row]));
  const publicModels = [...released].sort((a, b) => {
    const activeDelta =
      Number(financeById.get(b.id)?.isActive || b.id === pricingId) -
      Number(financeById.get(a.id)?.isActive || a.id === pricingId);
    return activeDelta || compareFleetFinishDay(a, b);
  });
  const privateModels = [...internal].sort(compareFleetFinishDay);
  const archivedModels = [...archived].sort(compareFleetFinishDay);
  const fleetCount = publicModels.length + privateModels.length + archivedModels.length;

  const renderFleet = (models: readonly Model[]) => (
    <CardGrid min="min(32rem, 100%)" className="anim-stagger">
      {models.map((source) => {
              const model = normalizeModelEvaluations(source);
              const status = fleetStatus(source);
              const archiveBlocked =
                status === "released" &&
                activeSafetyCampaignModelId === source.id;
              const freshness =
                status === "released"
                  ? modelFreshnessLabel(modelAgeDays(model.releaseDay, day))
                  : null;
              const selected = pricingId === model.id;
              const evidence = checkpointEvidence?.[model.id];
              const finance = financeById.get(model.id);
              const publicBenchmark = evidence
                ? null
                : buildPublicBenchmarkData(model);
              const tier = evidence ? null : modelTier(model.capability);
              const nextAt = tier?.nextAt;
              const progress =
                tier == null
                  ? (evidence?.confidence ?? 0)
                  : nextAt == null
                    ? 1
                    : (model.capability - tier.floor) /
                      Math.max(1, nextAt - tier.floor);
              const measuredDelta = evidence?.benchmark
                ? checkpointRivalDelta(evidence.benchmark)
                : null;
              const gap = evidence
                ? measuredDelta
                : model.capability - frontierCapability;
              const speed =
                model.serviceProfile?.interactiveTokPerSec ??
                52 * model.tokPerSecMult;
              const suiteId = evidence
                ? null
                : (PREFERRED_SUITE_IDS.find((candidate) =>
                    Boolean(publicBenchmark?.suites[candidate]),
                  ) ?? "language");
              const primarySuite =
                evidence || !publicBenchmark
                  ? undefined
                  : publicBenchmark.suites[suiteId!];
              const suiteScore = evidence ? null : suiteComposite(primarySuite);
              const measuredScore = evidence?.evaluationScore.estimate;
              const measuredLow = evidence?.evaluationScore.low;
              const measuredHigh = evidence?.evaluationScore.high;
              const statusLabel =
                status === "sold"
                  ? "sold"
                  : status === "archived"
                    ? "archived"
                    : status === "released"
                      ? "released"
                      : "internal";
              const selectedRing =
                status === "released"
                  ? "ring-1 ring-gold/40"
                  : status === "archived"
                    ? "ring-1 ring-line/80"
                    : "ring-1 ring-mint/40";
              return (
                <div
                  key={model.id}
                  className="contents"
                  data-archived-card={
                    status === "archived" ? "true" : undefined
                  }
                >
                <GameCard
                  className={`hover-lift ${selected ? selectedRing : ""} ${
                    status === "archived"
                      ? "!border-line/50 !bg-panel-2/45 [&>header]:!border-line/40 [&>header]:bg-void/15"
                      : ""
                  }`}
                  tone={
                    finance?.isActive
                      ? "mint"
                      : status === "released"
                        ? "gold"
                        : selected
                          ? "mint"
                          : undefined
                  }
                  mobilePriority={status === "archived" ? "secondary" : "primary"}
                  mobileSummary={`${statusLabel} · cap ${model.capability.toFixed(0)} · ${speed.toFixed(0)} t/s`}
                  eyebrow={
                    evidence
                      ? `${statusLabel === "internal" ? "private" : statusLabel} · measured checkpoint · Day ${model.releaseDay}`
                      : `${statusLabel === "internal" ? "private" : statusLabel} · ${tier!.label} · Day ${model.releaseDay}${freshness ? ` · ${freshness}` : ""}`
                  }
                  title={
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <HudButton
                        type="button"
                        variant="ghost"
                        onClick={() => onSelect(model.id)}
                        aria-label={`Select ${model.name}`}
                        className={`!min-h-11 !min-w-0 !flex-1 !justify-start !truncate !border-0 !bg-transparent !px-0 !py-0 !text-left !font-semibold hover:!bg-transparent xl:!min-h-0 ${
                          status === "archived" ? "!text-muted" : "!text-bone"
                        }`}
                      >
                        {model.name}
                      </HudButton>
                      {status === "sold" ? (
                        <span className="hud-mobile-detail hidden sm:inline-flex"><StatusChip tone="danger">SOLD</StatusChip></span>
                      ) : status === "archived" ? (
                        <span className="hud-mobile-detail hidden sm:inline-flex"><StatusChip tone="neutral">ARCHIVED</StatusChip></span>
                      ) : null}
                      {status === "released" && finance?.isActive ? (
                        <span className="hud-mobile-detail hidden sm:inline-flex"><StatusChip tone="positive">ACTIVE</StatusChip></span>
                      ) : null}
                      {status === "released" && !finance?.isActive ? (
                        <span className="hud-mobile-detail hidden sm:inline-flex"><StatusChip tone="gold">RELEASED</StatusChip></span>
                      ) : null}
                    </span>
                  }
                  actions={
                    <StatusChip
                      tone={status === "released" ? "positive" : "neutral"}
                    >
                      {evidence
                        ? (measuredScore?.toFixed(1) ?? "Unknown")
                        : model.capability.toFixed(0)}
                    </StatusChip>
                  }
                >
                  <div
                    className={
                      status === "archived"
                        ? "opacity-60 grayscale-[0.65] saturate-50"
                        : undefined
                    }
                    data-archived-visual={
                      status === "archived" ? "muted" : undefined
                    }
                  >
                    <div className="grid min-h-11 grid-cols-2 gap-x-3 gap-y-0.5">
                      <StatRow
                        label={evidence ? "Eval score" : "Suite"}
                        value={
                          evidence
                            ? (measuredScore?.toFixed(1) ?? "Unknown")
                            : suiteScore!.toFixed(2)
                        }
                      />
                      <StatRow
                        label={evidence ? "Rival delta" : "Frontier"}
                        value={
                          gap == null
                            ? "Unknown"
                            : `${gap >= 0 ? "+" : ""}${gap.toFixed(2)}`
                        }
                        tone={
                          gap == null
                            ? undefined
                            : gap >= 0
                              ? "positive"
                              : "warning"
                        }
                      />
                      <StatRow
                        label="Speed"
                        value={`${speed.toFixed(1)} t/s`}
                      />
                    </div>
                    <div className="hud-mobile-detail mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
                      <StatRow label="Family" value={model.family} />
                      <StatRow label="Scale" value={`${num(model.paramsB, 2)}B`} />
                      <StatRow
                        label="Profile"
                        value={model.productPreset?.replaceAll("_", " ") ?? "general"}
                      />
                    </div>
                    {model.economics ? (
                      <HudDesktopDefaultDetails className="group mt-2 rounded-md border border-line/50 bg-void/25">
                        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5 text-[0.6875rem] text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint/60 [&::-webkit-details-marker]:hidden">
                          <span>Lifetime economics</span>
                          <span className="font-mono tabular-nums text-bone">
                            {money(model.economics.lifetimeNet)} · <span className="group-open:hidden">Details</span><span className="hidden group-open:inline">Hide</span>
                          </span>
                        </summary>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-line/40 p-2">
                        <StatRow
                          label="Setup"
                          value={money(model.economics.trainingInitialCost)}
                        />
                        <StatRow
                          label="Data cost"
                          value={money(model.economics.trainingDataCost)}
                        />
                        <StatRow
                          label="Daily train"
                          value={money(model.economics.trainingDailyCost)}
                        />
                        <StatRow
                          label="Life net"
                          value={money(model.economics.lifetimeNet)}
                          tone={
                            model.economics.lifetimeNet >= 0
                              ? "positive"
                              : "warning"
                          }
                        />
                        <StatRow
                          label="API rev"
                          value={money(model.economics.lifetimeApiRevenue)}
                        />
                        <StatRow
                          label="Sub+Ent"
                          value={money(
                            model.economics.lifetimeSubRevenue +
                              model.economics.lifetimeEnterpriseRevenue,
                          )}
                        />
                        </div>
                      </HudDesktopDefaultDetails>
                    ) : null}
                    <div className="mt-2">
                      <MeterBar
                        label={
                          evidence ? "Evidence confidence" : "Tier progress"
                        }
                        value={progress}
                        detail={
                          evidence
                            ? confidenceLabel(evidence.confidence)
                            : tier!.label
                        }
                        tone="positive"
                      />
                    </div>
                  </div>
                  <FleetEvidenceDisclosure
                    status={status}
                    summary={
                      evidence
                        ? `${Math.round(evidence.confidence * 100)}% confidence`
                        : `${suiteScore!.toFixed(1)} suite`
                    }
                  >
                    {evidence ? (
                      <div
                        aria-label={`${model.name} persisted checkpoint evidence`}
                        className="rounded-md border border-line/60 bg-void/30 p-2.5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="hud-eyebrow">Measured evidence</p>
                            <strong className="mt-1 block text-[0.8125rem] text-bone">
                              {evidence.evaluationScore.label ?? "Not evaluated"}
                            </strong>
                          </div>
                          <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                            {Math.round(evidence.confidence * 100)}% conf.
                          </span>
                        </div>
                        <p className="mt-2 font-mono text-[0.75rem] tabular-nums text-bone">
                          {measuredScore == null
                            ? "Evaluation score unknown"
                            : `${measuredScore.toFixed(1)} · ${(
                                measuredLow ?? measuredScore
                              ).toFixed(1)}–${(
                                measuredHigh ?? measuredScore
                              ).toFixed(1)}`}
                        </p>
                        <p className="mt-1 text-[0.6875rem] leading-5 text-muted">
                          {evidence.review?.summary ??
                            "Run a private evaluation to replace latent estimates with a measured interval."}
                        </p>
                      </div>
                    ) : (
                      <RadarChart
                        suiteId={suiteId!}
                        scores={publicBenchmark?.suites[suiteId!] ?? {}}
                        profile={publicBenchmark?.profile ?? {}}
                        ariaLabel={`${model.name} evaluation radar`}
                      />
                    )}
                  </FleetEvidenceDisclosure>
                  <div className="mt-3">
                    <EffortStudio
                      subjectId={model.id}
                      paramsB={model.paramsB}
                      profile={productProfileFromModel(model)}
                      capability={model.capability}
                      onDefault={
                        onSetDefaultEffort
                          ? (recipeId) => onSetDefaultEffort(model.id, recipeId)
                          : undefined
                      }
                      onToggleServe={
                        onSetServedEffort
                          ? (recipeId, served) =>
                              onSetServedEffort(model.id, recipeId, served)
                          : undefined
                      }
                    />
                  </div>
                  {status === "released" && finance ? (
                    <HudDesktopDefaultDetails className="group mt-3 border-t border-line/50 pt-2" data-serving-economics="collapsed">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint/60 [&::-webkit-details-marker]:hidden">
                        <span>Serving today</span>
                        <span className="font-mono tabular-nums text-bone">
                          {money(finance.dayApiRevenue + finance.daySubRevenue)} revenue · <span className="group-open:hidden">Details</span><span className="hidden group-open:inline">Hide</span>
                        </span>
                      </summary>
                      <div className="space-y-2 px-2 pb-2">
                        <FleetServingEconomics finance={finance} />
                      {finance.note ? (
                        <p className="text-[0.8125rem] leading-snug text-muted">
                          {finance.note}
                        </p>
                      ) : null}
                      </div>
                    </HudDesktopDefaultDetails>
                  ) : null}
                  {status === "sold" ? (
                    <p className="mt-3 text-[0.6875rem] leading-5 text-muted">
                      Sold. The buyer owns this IP — it cannot return to the
                      public fleet.
                    </p>
                  ) : status === "archived" ? (
                    <p className="mt-3 text-[0.6875rem] leading-5 text-muted">
                      Not serving customers. Train a new version, distill, or
                      restore to the public fleet.
                    </p>
                  ) : null}
                  <div
                    className="mt-3 grid grid-cols-2 gap-1.5 border-t border-line/50 pt-3 [&_.hud-button]:!min-h-11 [&_.hud-button]:!w-full sm:flex sm:flex-wrap sm:[&_.hud-button]:!w-auto"
                    data-fleet-actions={status}
                  >
                    {status !== "sold" ? (
                      <HudButton
                        type="button"
                        variant="secondary"
                        className="!px-2 !py-1 text-[0.6875rem]"
                        onClick={() => onTrainFurther(model)}
                      >
                        {status === "internal"
                          ? "Train further"
                          : "Train new version"}
                      </HudButton>
                    ) : null}
                    {status !== "sold" ? (
                      <HudButton
                        type="button"
                        variant="ghost"
                        className="!px-2 !py-1 text-[0.6875rem]"
                        onClick={() => onDistill(model)}
                      >
                        Distill
                      </HudButton>
                    ) : null}
                    {status === "internal" ? (
                      <HudButton
                        type="button"
                        variant="primary"
                        className="!px-2 !py-1 text-[0.6875rem]"
                        onClick={() => onRelease(model.id)}
                      >
                        Release
                      </HudButton>
                    ) : null}
                    {status === "released" && onArchive ? (
                      <HudButton
                        type="button"
                        variant="ghost"
                        disabled={archiveBlocked}
                        title={
                          archiveBlocked
                            ? "Finish or cancel this model's active safety campaign before archiving it."
                            : undefined
                        }
                        className="!px-2 !py-1 text-[0.6875rem]"
                        onClick={() => onArchive(model.id)}
                      >
                        {archiveBlocked ? "Safety active" : "Archive"}
                      </HudButton>
                    ) : null}
                    {status === "archived" && onRestore ? (
                      <HudButton
                        type="button"
                        variant="primary"
                        className="!px-2 !py-1 text-[0.6875rem]"
                        onClick={() => onRestore(model.id)}
                      >
                        Restore
                      </HudButton>
                    ) : null}
                    {status !== "sold" && onSellIp ? (
                      <HudButton
                        type="button"
                        variant="ghost"
                        disabled={archiveBlocked}
                        title={
                          archiveBlocked
                            ? "Finish or cancel this model's active safety campaign before selling it."
                            : undefined
                        }
                        className="!px-2 !py-1 text-[0.6875rem]"
                        onClick={() => onSellIp(model.id)}
                      >
                        {ipSaleQuoteFor
                          ? `Sell IP · ${money(ipSaleQuoteFor(model))}`
                          : "Sell IP"}
                      </HudButton>
                    ) : null}
                    <HudButton
                      type="button"
                      variant="danger"
                      className="sm:ml-auto !px-2 !py-1 text-[0.6875rem]"
                      onClick={() => onDelete(model.id)}
                    >
                      Delete
                    </HudButton>
                  </div>
                  {status === "released" ? (
                    <p className="mt-2 text-[0.6875rem] leading-5 text-muted">
                      Edit input/output list prices from Plans → API.
                    </p>
                  ) : null}
                  {selected && safetySlot ? (
                    <div className="mt-3">{safetySlot}</div>
                  ) : null}
                </GameCard>
                </div>
        );
      })}
    </CardGrid>
  );

  return (
    <div className="panel-swap space-y-4">
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-3 rounded-lg border border-line/60 bg-panel-2/45 p-3">
          <div className="min-w-0">
            <p className="hud-eyebrow">Fleet</p>
            <h3 className="mt-0.5 text-sm font-semibold text-bone">
              Trained models
            </h3>
            <p className="hud-mobile-detail mt-1 text-[0.6875rem] leading-5 text-muted">
              Public models can serve customers. Private checkpoints stay in
              your lab. Archived weights remain available for future training.
            </p>
          </div>
          <span className="shrink-0 rounded border border-line/70 px-2 py-1 font-mono text-[0.6875rem] tabular-nums text-muted">
            {fleetCount} total
          </span>
        </div>

        {fleetCount === 0 ? (
          <EmptyState
            title="No trained models"
            description="Finish a job with Keep internal or Release. Archive takes a live model off serving without deleting the weights."
          />
        ) : (
          <>
            <section className="space-y-2" aria-labelledby="public-fleet-heading">
              <div className="flex items-end justify-between gap-3 border-b border-line/60 pb-2">
                <div>
                  <p className="hud-eyebrow">Serving</p>
                  <h4 id="public-fleet-heading" className="mt-0.5 text-[0.8125rem] font-semibold text-bone">
                    Public fleet
                  </h4>
                  <p className="hud-mobile-detail mt-0.5 text-[0.6875rem] text-muted">
                    Released models eligible for API, plans, and routers.
                  </p>
                </div>
                <StatusChip tone={publicModels.length > 0 ? "positive" : "neutral"}>
                  {publicModels.length} live
                </StatusChip>
              </div>
              {publicModels.length > 0 ? (
                renderFleet(publicModels)
              ) : (
                <p className="rounded-md border border-dashed border-line/70 p-3 text-[0.6875rem] text-muted">
                  No public models. Release a private checkpoint when it is ready.
                </p>
              )}
            </section>

            <section className="space-y-2" aria-labelledby="private-fleet-heading">
              <div className="flex items-end justify-between gap-3 border-b border-line/60 pb-2">
                <div>
                  <p className="hud-eyebrow">Lab</p>
                  <h4 id="private-fleet-heading" className="mt-0.5 text-[0.8125rem] font-semibold text-bone">
                    Private checkpoints
                  </h4>
                  <p className="hud-mobile-detail mt-0.5 text-[0.6875rem] text-muted">
                    Internal weights that are not visible to customers.
                  </p>
                </div>
                <StatusChip tone="neutral">{privateModels.length} private</StatusChip>
              </div>
              {privateModels.length > 0 ? (
                renderFleet(privateModels)
              ) : (
                <p className="rounded-md border border-dashed border-line/70 p-3 text-[0.6875rem] text-muted">
                  No private checkpoints.
                </p>
              )}
            </section>

            {archivedModels.length > 0 ? (
              <HudDesktopDefaultDetails
                className="group rounded-lg border border-line/65 bg-void/20"
                data-fleet-archive-disclosure="true"
              >
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-panel-2/45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint/60 [&::-webkit-details-marker]:hidden">
                  <span>
                    <span className="hud-eyebrow">Storage</span>
                    <span className="mt-0.5 block text-[0.8125rem] font-semibold text-muted">
                      Archived models
                    </span>
                    <span className="mt-0.5 block text-[0.6875rem] text-muted/80">
                      Off-market weights ·
                      <span className="ml-1 group-open:hidden">Show archived models</span>
                      <span className="ml-1 hidden group-open:inline">Hide archived models</span>
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <StatusChip tone="neutral">{archivedModels.length} archived</StatusChip>
                    <span aria-hidden className="text-muted transition-transform group-open:rotate-180">⌄</span>
                  </span>
                </summary>
                <div className="border-t border-line/50 p-3">
                  {renderFleet(archivedModels)}
                </div>
              </HudDesktopDefaultDetails>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
