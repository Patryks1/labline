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

function fleetStatus(model: Model): "archived" | "released" | "internal" {
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

export function FleetTab({
  internal,
  released,
  archived = [],
  pricingId,
  onSelect,
  onRelease,
  onArchive,
  onRestore,
  onDelete,
  frontierCapability,
  onTrainFurther,
  onDistill,
  onSetDefaultEffort,
  onSetServedEffort,
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
  onDelete: (id: string) => void;
  frontierCapability: number;
  /** Canonical $/MTok unit cost for suggested list prices. */
  unitCostForModel?: (model: Model) => number;
  onTrainFurther: (model: Model) => void;
  onDistill: (model: Model) => void;
  onSetDefaultEffort?: (id: string, effort: string) => void;
  onSetServedEffort?: (id: string, effort: string, served: boolean) => void;
  safetySlot?: React.ReactNode;
  /** Persisted, noisy evidence for models promoted from stealth checkpoints. */
  checkpointEvidence?: Readonly<Record<string, CheckpointUiRecord>>;
  /** Day P&L attribution for public fleet cards. */
  modelFinance?: readonly ModelFinanceRow[];
  /** Campaign day, used for a light freshness hint on released cards. */
  day?: number;
}) {
  const financeById = new Map(modelFinance.map((row) => [row.modelId, row]));
  const fleet = [...internal, ...released, ...archived].sort(compareFleetFinishDay);

  return (
    <div className="panel-swap space-y-4">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="hud-eyebrow">Fleet</p>
            <h3 className="text-sm font-semibold text-bone">Trained models</h3>
            <p className="mt-1 text-[0.6875rem] leading-5 text-muted">
              After release, set list prices in Plans → API and add the model
              to a router to serve.
            </p>
          </div>
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
            {fleet.length}
          </span>
        </div>
        {fleet.length === 0 ? (
          <EmptyState
            title="No trained models"
            description="Finish a job with Keep internal or Release. Archive takes a live model off serving without deleting the weights."
          />
        ) : (
          <CardGrid min="min(32rem, 100%)" className="anim-stagger">
            {fleet.map((source) => {
              const model = normalizeModelEvaluations(source);
              const status = fleetStatus(source);
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
                status === "archived"
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
                <GameCard
                  key={model.id}
                  className={`hover-lift ${selected ? selectedRing : ""}`}
                  tone={
                    finance?.isActive
                      ? "mint"
                      : status === "released"
                        ? "gold"
                        : selected
                          ? "mint"
                          : undefined
                  }
                  eyebrow={
                    evidence
                      ? `${statusLabel} · measured checkpoint · Day ${model.releaseDay}`
                      : `${statusLabel} · ${tier!.label} · Day ${model.releaseDay}${freshness ? ` · ${freshness}` : ""}`
                  }
                  title={
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <HudButton
                        type="button"
                        variant="ghost"
                        onClick={() => onSelect(model.id)}
                        aria-label={`Select ${model.name}`}
                        className="!min-h-11 !min-w-0 !flex-1 !justify-start !truncate !border-0 !bg-transparent !px-0 !py-0 !text-left !font-semibold !text-bone hover:!bg-transparent sm:!min-h-0"
                      >
                        {model.name}
                      </HudButton>
                      {status === "archived" ? (
                        <StatusChip tone="neutral">ARCHIVED</StatusChip>
                      ) : null}
                      {status === "released" && finance?.isActive ? (
                        <StatusChip tone="positive">ACTIVE</StatusChip>
                      ) : null}
                      {status === "released" && !finance?.isActive ? (
                        <StatusChip tone="gold">RELEASED</StatusChip>
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
                  <HudButton
                    type="button"
                    variant="ghost"
                    onClick={() => onSelect(model.id)}
                    aria-label={`Select ${model.name}`}
                    className="!h-auto !min-h-11 !w-full !justify-start !rounded-none !border-0 !bg-transparent !p-0 !text-left !text-bone hover:!bg-transparent"
                  >
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
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
                      <StatRow label="Family" value={model.family} />
                    </div>
                    {model.economics ? (
                      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-line/40 pt-2">
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
                  </HudButton>
                  <div className="mt-3 border-t border-line/50 pt-3">
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
                  </div>
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
                    <div className="mt-3 space-y-2 border-t border-line/50 pt-3">
                      <FleetServingEconomics finance={finance} />
                      {finance.note ? (
                        <p className="text-[0.8125rem] leading-snug text-muted">
                          {finance.note}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {status === "archived" ? (
                    <p className="mt-3 text-[0.6875rem] leading-5 text-muted">
                      Not serving customers. Train a new version, distill, or
                      restore to the public fleet.
                    </p>
                  ) : null}
                  <div className="mt-3 grid grid-cols-2 gap-1.5 border-t border-line/50 pt-3 sm:flex sm:flex-wrap">
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
                    <HudButton
                      type="button"
                      variant="ghost"
                      className="!px-2 !py-1 text-[0.6875rem]"
                      onClick={() => onDistill(model)}
                    >
                      Distill
                    </HudButton>
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
                        className="!px-2 !py-1 text-[0.6875rem]"
                        onClick={() => onArchive(model.id)}
                      >
                        Archive
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
              );
            })}
          </CardGrid>
        )}
      </section>
    </div>
  );
}
