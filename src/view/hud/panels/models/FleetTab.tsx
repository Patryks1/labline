import { useEffect, useState } from "react";
import type { Model } from "../../../../sim/types";
import {
  normalizeModelEvaluations,
  suiteComposite,
} from "../../../../sim/balance/evaluationSuites";
import {
  modelCostMult,
  suggestApiInOut,
} from "../../../../sim/balance/pricing";
import { GameCard, CardGrid, MeterBar, StatRow } from "../../ui/kit";
import { EmptyState, HudButton, StatusChip } from "../../ui/HudPrimitives";
import { money } from "../../format";
import { ModelProductSummary } from "../../ui/ModelProductSummary";
import { useUiStore } from "../../../../store/uiStore";
import { RadarChart } from "../../ui/RadarChart";

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

function PriceInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | null;
  placeholder: number;
  onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(() =>
    value == null ? "" : value.toFixed(2),
  );
  useEffect(() => {
    setDraft(value == null ? "" : value.toFixed(2));
  }, [value]);
  const commit = () => {
    if (draft.trim() === "") {
      onChange(null);
      return;
    }
    const parsed = Number(draft);
    const next = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    const rounded = Math.round(next * 100) / 100;
    setDraft(rounded.toFixed(2));
    onChange(rounded);
  };
  return (
    <label className="text-[0.6875rem] text-muted">
      {label}
      <input
        type="number"
        min={0}
        step={0.01}
        inputMode="decimal"
        placeholder={placeholder.toFixed(2)}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape")
            setDraft(value == null ? "" : value.toFixed(2));
        }}
        className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1 font-mono text-xs text-bone outline-none focus:border-mint/50"
      />
    </label>
  );
}

function MarkupControl({
  initialPercent,
  onApply,
}: {
  initialPercent: number;
  onApply: (percent: number) => void;
}) {
  const [draft, setDraft] = useState(() => String(initialPercent));
  const parsed = Number(draft);
  const valid =
    draft.trim() !== "" &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= 10_000;
  useEffect(() => {
    setDraft(String(initialPercent));
  }, [initialPercent]);
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-mint/25 bg-mint/10">
      <label className="flex items-center gap-1 px-2 text-[0.6875rem] text-muted">
        <span>Markup</span>
        <input
          type="number"
          min={0}
          max={10_000}
          step={0.01}
          inputMode="decimal"
          aria-label="Custom API markup percentage"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && valid) onApply(parsed);
          }}
          className="w-16 border-0 bg-transparent py-1 text-right font-mono text-[0.6875rem] text-bone outline-none"
        />
        <span aria-hidden>%</span>
      </label>
      <button
        type="button"
        disabled={!valid}
        onClick={() => valid && onApply(parsed)}
        className="border-l border-mint/25 px-2 py-1 text-[0.6875rem] text-mint hover:bg-mint/15 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Apply
      </button>
    </div>
  );
}

export function FleetTab({
  internal,
  released,
  pricingId,
  onSelect,
  onRelease,
  onDelete,
  onPriceInOut,
  onApplyMarkup,
  markupPct,
  frontierCapability,
  unitCostActive,
  activeModelRef,
  onTrainFurther,
  onDistill,
  safetySlot,
}: {
  internal: Model[];
  released: Model[];
  pricingId: string | null;
  onSelect: (id: string) => void;
  onRelease: (id: string) => void;
  onDelete: (id: string) => void;
  onPriceInOut: (
    id: string,
    priceIn: number | null,
    priceOut: number | null,
  ) => void;
  onApplyMarkup: (id: string, markupPct: number) => void;
  markupPct: number;
  frontierCapability: number;
  unitCostActive?: number;
  activeModelRef?: Model | null;
  onTrainFurther: (model: Model) => void;
  onDistill: (model: Model) => void;
  safetySlot?: React.ReactNode;
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
          <CardGrid min="32rem" className="anim-stagger">
            {internal.map((source) => {
              const model = normalizeModelEvaluations(source);
              const selected = pricingId === model.id;
              const tier = modelTier(model.capability);
              const nextAt = tier.nextAt;
              const progress =
                nextAt == null
                  ? 1
                  : (model.capability - tier.floor) /
                    Math.max(1, nextAt - tier.floor);
              const gap = model.capability - frontierCapability;
              const speed =
                model.serviceProfile?.interactiveTokPerSec ??
                52 * model.tokPerSecMult;
              const primarySuite =
                model.benchmarkSuites?.omni_overview ??
                model.benchmarkSuites?.image_generation ??
                model.benchmarkSuites?.video_generation ??
                model.benchmarkSuites?.audio_generation ??
                model.benchmarkSuites?.language;
              const suiteScore = suiteComposite(primarySuite);
              const suiteId = model.benchmarkSuites?.omni_overview
                ? "omni_overview"
                : model.benchmarkSuites?.image_generation
                  ? "image_generation"
                  : model.benchmarkSuites?.video_generation
                    ? "video_generation"
                    : model.benchmarkSuites?.audio_generation
                      ? "audio_generation"
                      : "language";
              return (
                <GameCard
                  key={model.id}
                  className={`hover-lift ${selected ? "ring-1 ring-mint/40" : ""}`}
                  tone={selected ? "mint" : undefined}
                  eyebrow={`internal · ${tier.label}`}
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
                      {model.capability.toFixed(0)}
                    </StatusChip>
                  }
                >
                  <button
                    type="button"
                    onClick={() => onSelect(model.id)}
                    className="w-full text-left"
                  >
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      <StatRow label="Suite" value={suiteScore.toFixed(2)} />
                      <StatRow
                        label="Frontier"
                        value={`${gap >= 0 ? "+" : ""}${gap.toFixed(2)}`}
                        tone={gap >= 0 ? "positive" : "warning"}
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
                        label="Tier progress"
                        value={progress}
                        detail={tier.label}
                        tone="positive"
                      />
                    </div>
                  </button>
                  <div className="mt-3 border-t border-line/50 pt-3">
                    <RadarChart
                      suiteId={suiteId}
                      scores={model.benchmarkSuites?.[suiteId] ?? {}}
                      profile={model.evaluationProfile}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
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
                      onClick={() => {
                        onRelease(model.id);
                        useUiStore.getState().announceRelease({
                          name: model.name,
                          capability: model.capability,
                        });
                      }}
                    >
                      Release
                    </HudButton>
                    <HudButton
                      type="button"
                      variant="danger"
                      className="ml-auto !px-2 !py-1 text-[0.6875rem]"
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
              const tier = modelTier(model.capability);
              const unit =
                unitCostActive != null && activeModelRef
                  ? Math.max(
                      0.005,
                      unitCostActive *
                        (modelCostMult(model) /
                          Math.max(0.08, modelCostMult(activeModelRef))),
                    )
                  : unitCostActive;
              const suggested =
                unit != null
                  ? suggestApiInOut({
                      costPerMTokBase: unit,
                      paramsB: model.paramsB,
                      activeParamsB: model.activeParamsB,
                      family: model.family,
                      inferCostMult: model.inferCostMult,
                      capability: model.capability,
                      markupPct,
                      applyModelMult: false,
                    })
                  : null;
              const gap = model.capability - frontierCapability;
              const speed =
                model.serviceProfile?.interactiveTokPerSec ??
                52 * model.tokPerSecMult;
              const primarySuite =
                model.benchmarkSuites?.omni_overview ??
                model.benchmarkSuites?.language;
              const suiteScore = suiteComposite(primarySuite);
              return (
                <GameCard
                  key={model.id}
                  className={`hover-lift ${selected ? "ring-1 ring-gold/40" : ""}`}
                  tone="gold"
                  eyebrow={`released · ${tier.label}`}
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
                      {model.capability.toFixed(0)}
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
                      badge={`released · ${tier.label}`}
                      badgeTone={gap >= 0 ? "mint" : "amber"}
                      score={model.capability.toFixed(2)}
                      metrics={[
                        { label: "suite", value: suiteScore.toFixed(2) },
                        {
                          label: "frontier",
                          value: `${gap >= 0 ? "+" : ""}${gap.toFixed(2)}`,
                          tone: gap >= 0 ? "text-mint" : "text-amber",
                        },
                        { label: "speed", value: `${speed.toFixed(1)} t/s` },
                        {
                          label: "serve",
                          value: unit == null ? "—" : `${displayRate(unit)}/M`,
                        },
                      ]}
                    />
                  </button>
                  {selected ? (
                    <div className="mt-3 space-y-2 border-t border-line/50 pt-3">
                      <div className="grid grid-cols-2 gap-1.5">
                        <PriceInput
                          label="Input $/1M"
                          value={model.apiPriceInPerMTok}
                          placeholder={
                            model.suggestedApiPriceIn ?? model.costApiPriceIn
                          }
                          onChange={(value) =>
                            onPriceInOut(
                              model.id,
                              value,
                              model.apiPriceOutPerMTok,
                            )
                          }
                        />
                        <PriceInput
                          label="Output $/1M"
                          value={model.apiPriceOutPerMTok}
                          placeholder={
                            model.suggestedApiPriceOut ?? model.costApiPriceOut
                          }
                          onChange={(value) =>
                            onPriceInOut(
                              model.id,
                              model.apiPriceInPerMTok,
                              value,
                            )
                          }
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {suggested ? (
                          <>
                            <HudButton
                              type="button"
                              variant="ghost"
                              className="!px-2 !py-1 text-[0.6875rem]"
                              onClick={() =>
                                onPriceInOut(
                                  model.id,
                                  model.costApiPriceIn,
                                  model.costApiPriceOut,
                                )
                              }
                            >
                              At cost
                            </HudButton>
                            <MarkupControl
                              initialPercent={markupPct}
                              onApply={(percent) =>
                                onApplyMarkup(model.id, percent)
                              }
                            />
                          </>
                        ) : null}
                        <HudButton
                          type="button"
                          variant="danger"
                          className="ml-auto !px-2 !py-1 text-[0.6875rem]"
                          onClick={() => onDelete(model.id)}
                        >
                          Delete
                        </HudButton>
                      </div>
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
