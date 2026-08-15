import type { Model } from "../../../../sim/types";
import {
  normalizeModelEvaluations,
  suiteComposite,
} from "../../../../sim/balance/evaluationSuites";
import { GameCard, CardGrid, MeterBar, StatRow } from "../../ui/kit";
import { EmptyState, HudButton, StatusChip } from "../../ui/HudPrimitives";
import { money } from "../../format";
import { ModelProductSummary } from "../../ui/ModelProductSummary";
import { RadarChart } from "../../ui/RadarChart";
import {
  checkpointRivalDelta,
  confidenceLabel,
  type CheckpointUiRecord,
} from "./checkpointUi";

function modelTier(capability: number) {
  if (capability >= 80)
    return { label: "Breakthrough", floor: 80, nextAt: null as number | null };
  if (capability >= 60) return { label: "Frontier", floor: 60, nextAt: 80 };
  if (capability >= 40) return { label: "Competitive", floor: 40, nextAt: 60 };
  return { label: "Prototype", floor: 0, nextAt: 40 };
}

function displayRate(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function FleetTab({
  internal,
  released,
  pricingId,
  onSelect,
  onRelease,
  onDelete,
  frontierCapability,
  unitCostForModel,
  onTrainFurther,
  onDistill,
  safetySlot,
  checkpointEvidence,
}: {
  internal: Model[];
  released: Model[];
  pricingId: string | null;
  onSelect: (id: string) => void;
  onRelease: (id: string) => void;
  onDelete: (id: string) => void;
  frontierCapability: number;
  /** Canonical $/MTok unit cost for suggested list prices. */
  unitCostForModel?: (model: Model) => number;
  onTrainFurther: (model: Model) => void;
  onDistill: (model: Model) => void;
  safetySlot?: React.ReactNode;
  /** Persisted, noisy evidence for models promoted from stealth checkpoints. */
  checkpointEvidence?: Readonly<Record<string, CheckpointUiRecord>>;
}) {
  return (
    <div className="panel-swap space-y-4">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="hud-eyebrow">Internal</p>
            <h3 className="text-sm font-semibold text-bone">
              Private checkpoints
            </h3>
          </div>
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
            {internal.length}
          </span>
        </div>
        {internal.length === 0 ? (
          <EmptyState
            title="No private checkpoints"
            description="Finish a job with Keep internal to unlock teachers and continue-train."
          />
        ) : (
          <CardGrid min="min(32rem, 100%)" className="anim-stagger">
            {internal.map((source) => {
              const model = normalizeModelEvaluations(source);
              const selected = pricingId === model.id;
              const evidence = checkpointEvidence?.[model.id];
              const tier = evidence ? null : modelTier(model.capability);
              const nextAt = tier?.nextAt;
              const progress =
                tier == null
                  ? evidence?.confidence ?? 0
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
              const primarySuite = evidence
                ? undefined
                : model.benchmarkSuites?.omni_overview ??
                  model.benchmarkSuites?.image_generation ??
                  model.benchmarkSuites?.video_generation ??
                  model.benchmarkSuites?.audio_generation ??
                  model.benchmarkSuites?.language;
              const suiteScore = evidence ? null : suiteComposite(primarySuite);
              const suiteId = evidence
                ? null
                : model.benchmarkSuites?.omni_overview
                  ? "omni_overview"
                  : model.benchmarkSuites?.image_generation
                    ? "image_generation"
                    : model.benchmarkSuites?.video_generation
                      ? "video_generation"
                      : model.benchmarkSuites?.audio_generation
                        ? "audio_generation"
                        : "language";
              const measuredScore = evidence?.evaluationScore.estimate;
              const measuredLow = evidence?.evaluationScore.low;
              const measuredHigh = evidence?.evaluationScore.high;
              return (
                <GameCard
                  key={model.id}
                  className={`hover-lift ${selected ? "ring-1 ring-mint/40" : ""}`}
                  tone={selected ? "mint" : undefined}
                  eyebrow={
                    evidence
                      ? "internal · measured checkpoint"
                      : `internal · ${tier!.label}`
                  }
                  title={
                    <button
                      type="button"
                      onClick={() => onSelect(model.id)}
                      className="truncate text-left"
                    >
                      {model.name}
                    </button>
                  }
                  actions={
                    <StatusChip tone="neutral">
                      {evidence
                        ? measuredScore?.toFixed(1) ?? "Unknown"
                        : model.capability.toFixed(0)}
                    </StatusChip>
                  }
                >
                  <button
                    type="button"
                    onClick={() => onSelect(model.id)}
                    className="w-full text-left"
                  >
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      <StatRow
                        label={evidence ? "Eval score" : "Suite"}
                        value={
                          evidence
                            ? measuredScore?.toFixed(1) ?? "Unknown"
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
                        label={evidence ? "Evidence confidence" : "Tier progress"}
                        value={progress}
                        detail={
                          evidence
                            ? confidenceLabel(evidence.confidence)
                            : tier!.label
                        }
                        tone="positive"
                      />
                    </div>
                  </button>
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
                        scores={model.benchmarkSuites?.[suiteId!] ?? {}}
                        profile={model.evaluationProfile}
                      />
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
                    <HudButton
                      type="button"
                      variant="secondary"
                      className="!px-2 !py-1 text-[0.6875rem]"
                      onClick={() => onTrainFurther(model)}
                    >
                      Train further
                    </HudButton>
                    <HudButton
                      type="button"
                      variant="ghost"
                      className="!px-2 !py-1 text-[0.6875rem]"
                      onClick={() => onDistill(model)}
                    >
                      Distill
                    </HudButton>
                    <HudButton
                      type="button"
                      variant="primary"
                      className="!px-2 !py-1 text-[0.6875rem]"
                      onClick={() => onRelease(model.id)}
                    >
                      Release
                    </HudButton>
                    <HudButton
                      type="button"
                      variant="danger"
                      className="sm:ml-auto !px-2 !py-1 text-[0.6875rem]"
                      onClick={() => onDelete(model.id)}
                    >
                      Delete
                    </HudButton>
                  </div>
                  {selected && safetySlot ? (
                    <div className="mt-3">{safetySlot}</div>
                  ) : null}
                </GameCard>
              );
            })}
          </CardGrid>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="hud-eyebrow">Released</p>
            <h3 className="text-sm font-semibold text-bone">Public fleet</h3>
          </div>
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
            {released.length}
          </span>
        </div>
        {released.length === 0 ? (
          <EmptyState
            title="No public models"
            description="Release an internal checkpoint when it is ready for production."
          />
        ) : (
          <CardGrid min="16rem" className="anim-stagger">
            {released.map((source) => {
              const model = normalizeModelEvaluations(source);
              const selected = pricingId === model.id;
              const evidence = checkpointEvidence?.[model.id];
              const tier = evidence ? null : modelTier(model.capability);
              const unit = unitCostForModel?.(model);
              const measuredDelta = evidence?.benchmark
                ? checkpointRivalDelta(evidence.benchmark)
                : null;
              const gap = evidence
                ? measuredDelta
                : model.capability - frontierCapability;
              const speed =
                model.serviceProfile?.interactiveTokPerSec ??
                52 * model.tokPerSecMult;
              const primarySuite = evidence
                ? undefined
                : model.benchmarkSuites?.omni_overview ??
                  model.benchmarkSuites?.language;
              const suiteScore = evidence ? null : suiteComposite(primarySuite);
              const measuredScore = evidence?.evaluationScore.estimate;
              return (
                <GameCard
                  key={model.id}
                  className={`hover-lift ${selected ? "ring-1 ring-gold/40" : ""}`}
                  tone="gold"
                  eyebrow={
                    evidence
                      ? "released · measured checkpoint"
                      : `released · ${tier!.label}`
                  }
                  title={
                    <button
                      type="button"
                      onClick={() => onSelect(model.id)}
                      className="truncate text-left"
                    >
                      {model.name}
                    </button>
                  }
                  actions={
                    <StatusChip tone="positive">
                      {evidence
                        ? measuredScore?.toFixed(1) ?? "Unknown"
                        : model.capability.toFixed(0)}
                    </StatusChip>
                  }
                >
                  <button
                    type="button"
                    onClick={() => onSelect(model.id)}
                    className="w-full text-left"
                  >
                    <ModelProductSummary
                      model={model}
                      badge={
                        evidence
                          ? "released · measured"
                          : `released · ${tier!.label}`
                      }
                      badgeTone={
                        gap == null ? "muted" : gap >= 0 ? "mint" : "amber"
                      }
                      score={
                        evidence
                          ? measuredScore?.toFixed(1) ?? "Unknown"
                          : model.capability.toFixed(2)
                      }
                      metrics={
                        evidence
                          ? [
                              {
                                label: "evaluation",
                                value:
                                  measuredScore?.toFixed(1) ?? "Unknown",
                              },
                              {
                                label: "rival",
                                value:
                                  gap == null
                                    ? "Unknown"
                                    : `${gap >= 0 ? "+" : ""}${gap.toFixed(1)}`,
                                tone:
                                  gap == null
                                    ? "text-muted"
                                    : gap >= 0
                                      ? "text-mint"
                                      : "text-amber",
                              },
                              {
                                label: "speed",
                                value: `${speed.toFixed(1)} t/s`,
                              },
                              {
                                label: "serve",
                                value:
                                  unit == null ? "—" : `${displayRate(unit)}/M`,
                              },
                            ]
                          : [
                              {
                                label: "suite",
                                value: suiteScore!.toFixed(2),
                              },
                              {
                                label: "frontier",
                                value: `${gap! >= 0 ? "+" : ""}${gap!.toFixed(2)}`,
                                tone:
                                  gap! >= 0 ? "text-mint" : "text-amber",
                              },
                              {
                                label: "speed",
                                value: `${speed.toFixed(1)} t/s`,
                              },
                              {
                                label: "serve",
                                value:
                                  unit == null ? "—" : `${displayRate(unit)}/M`,
                              },
                            ]
                      }
                    >
                      {evidence ? (
                        <p className="mt-2 text-[0.6875rem] leading-5 text-muted">
                          {evidence.evaluationScore.label ?? "No measured metric"}
                          {evidence.evaluationScore.low != null &&
                          evidence.evaluationScore.high != null
                            ? ` · ${evidence.evaluationScore.low.toFixed(1)}–${evidence.evaluationScore.high.toFixed(1)}`
                            : " · private evaluation required"}
                        </p>
                      ) : null}
                    </ModelProductSummary>
                  </button>
                  <div className="mt-3 grid grid-cols-2 gap-1.5 border-t border-line/50 pt-3 sm:flex sm:flex-wrap">
                    <HudButton
                      type="button"
                      variant="secondary"
                      className="!px-2 !py-1 text-[0.6875rem]"
                      onClick={() => onTrainFurther(model)}
                    >
                      Train new version
                    </HudButton>
                    <HudButton
                      type="button"
                      variant="ghost"
                      className="!px-2 !py-1 text-[0.6875rem]"
                      onClick={() => onDistill(model)}
                    >
                      Distill
                    </HudButton>
                  </div>
                  {selected ? (
                    <div className="mt-3 flex flex-col gap-2 rounded-md border border-line/60 bg-void/25 p-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                      <p className="text-[0.6875rem] leading-5 text-muted">
                        Edit input/output list prices from Plans → API.
                      </p>
                      <HudButton
                        type="button"
                        variant="danger"
                        className="!px-2 !py-1 text-[0.6875rem]"
                        onClick={() => onDelete(model.id)}
                      >
                        Delete
                      </HudButton>
                    </div>
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
