import { useMemo, useState } from "react";
import { TRAINING_V4 } from "../../../../../../sim/training/constants";
import { evalCost } from "../../../../../../sim/training/evaluate";
import { trainingStateOf } from "../../../../../../sim/training/state";
import {
  TIER_BUDGETS,
  THINKING_UNLOCK_REASON,
  scaleEvalCost,
  thinkingLockReason,
  thinkingUnlocked,
  trainedThinkingBudgets,
  tierLabel,
} from "../../../../../../sim/training/thinking";
import type { EvalMetric, EvalTier, TierBudget } from "../../../../../../sim/training/types";
import { useGameStore } from "../../../../../../store/gameStore";
import { money } from "../../../../format";
import { HudButton } from "../../../../ui/HudPrimitives";
import { ConsoleDialog } from "../../../../ui/ConsoleDialog";
import { GameCard } from "../../../../ui/kit";
import { EvalRadar } from "../EvalCharts";
import { LockedChoice } from "./LockedChoice";
import { DialogFooter } from "./DialogStepper";
import { CORE_EVAL_METRICS, actionError, checkpointById, formatDays, hasTrainingUnlock } from "./designState";

const ALL_METRICS: EvalMetric[] = [
  "overall",
  "language",
  "reasoning",
  "code",
  "math",
  "science",
  "vision",
  "video",
  "audio",
  "tools",
  "safety",
  "steerability",
  "reliability",
];

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function metricsForCheckpoint(checkpoint: ReturnType<typeof checkpointById>): EvalMetric[] {
  const inputs = new Set(checkpoint?.arch.inputs ?? ["text"]);
  const outputs = new Set(checkpoint?.arch.outputs ?? ["text"]);
  return ALL_METRICS.filter((metric) => {
    if (metric === "vision") return inputs.has("image") || outputs.has("image");
    if (metric === "video") return inputs.has("video") || outputs.has("video");
    if (metric === "audio") return inputs.has("audio") || outputs.has("audio");
    return true;
  });
}

const TIER_CARDS: ReadonlyArray<{
  id: EvalTier;
  label: string;
  blurb: string;
}> = [
  { id: "quick", label: "Quick", blurb: "Free directional read. Wide interval." },
  { id: "suite", label: "Suite", blurb: "Paid panel, tighter sigma." },
  { id: "audit", label: "Audit", blurb: "Deep study. Leak risk on the public board." },
];

function fallbackEvalCost(
  tier: EvalTier,
  metrics: EvalMetric[],
): { cash: number; days: number; sigma: number } {
  const n = Math.max(1, metrics.length);
  if (tier === "quick") {
    return { cash: TRAINING_V4.evals.quick.cash, days: TRAINING_V4.evals.quick.days, sigma: TRAINING_V4.evals.quick.sigma };
  }
  if (tier === "audit") {
    return { cash: TRAINING_V4.evals.audit.cash, days: TRAINING_V4.evals.audit.days, sigma: TRAINING_V4.evals.audit.sigma };
  }
  const { cashMin, cashMax, daysMin, daysMax, sigmaStart, sigmaEnd } = TRAINING_V4.evals.suite;
  const t = Math.min(1, (n - 1) / 8);
  return {
    cash: cashMin + (cashMax - cashMin) * t,
    days: daysMin + (daysMax - daysMin) * t,
    sigma: sigmaStart + (sigmaEnd - sigmaStart) * t,
  };
}

function quoteEval(tier: EvalTier, metrics: EvalMetric[], budget: TierBudget = 1) {
  try {
    return evalCost(tier, metrics, budget);
  } catch {
    return scaleEvalCost(fallbackEvalCost(tier, metrics), budget);
  }
}

function quoteEvals(tier: EvalTier, metrics: EvalMetric[], budgets: TierBudget[]) {
  return budgets.reduce(
    (acc, budget) => {
      const next = quoteEval(tier, metrics, budget);
      return {
        cash: acc.cash + next.cash,
        days: Math.max(acc.days, next.days),
        sigma: next.sigma,
      };
    },
    { cash: 0, days: 0, sigma: 0 },
  );
}

export function EvaluateDialog({
  open,
  onClose,
  checkpointId,
}: {
  open: boolean;
  onClose: () => void;
  checkpointId: string;
}) {
  const sim = useGameStore((s) => s.state);
  const orderEval = useGameStore((s) => s.orderEval);
  const checkpoint = checkpointById(sim, checkpointId);
  const training = trainingStateOf(sim, sim.playerLabId);
  const latestEval = training.evals
    .filter((row) => row.checkpointId === checkpointId && row.status === "complete" && row.result)
    .sort((a, b) => b.completeDay - a.completeDay || b.orderedDay - a.orderedDay)[0];
  const runningEval = training.evals.find(
    (row) => row.checkpointId === checkpointId && row.status === "running",
  );
  const [tier, setTier] = useState<EvalTier>("quick");
  const [metrics, setMetrics] = useState<EvalMetric[]>([...CORE_EVAL_METRICS]);
  const [tierBudgets, setTierBudgets] = useState<TierBudget[]>([1]);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const quote = useMemo(() => quoteEvals(tier, metrics, tierBudgets), [metrics, tier, tierBudgets]);
  const listedMetrics = metricsForCheckpoint(checkpoint);
  const coreMetrics = CORE_EVAL_METRICS.filter((metric) => listedMetrics.includes(metric));
  const selectedListed = metrics.filter((metric) => listedMetrics.includes(metric));
  const allSelected =
    listedMetrics.length > 0 && selectedListed.length === listedMetrics.length;
  const coreSelected =
    coreMetrics.length > 0 &&
    selectedListed.length === coreMetrics.length &&
    coreMetrics.every((metric) => selectedListed.includes(metric));
  const trainedBudgets = checkpoint ? trainedThinkingBudgets(checkpoint) : ([1] as TierBudget[]);
  const canTrainThinking = hasTrainingUnlock(sim, "thinking_tiers");
  const allThinkingSelected =
    trainedBudgets.length > 0 &&
    trainedBudgets.every((budget) => tierBudgets.includes(budget));
  const leak = tier === "audit" ? TRAINING_V4.evals.audit.leakRisk : 0;

  const toggleMetric = (metric: EvalMetric) => {
    setMetrics((current) => {
      const next = current.includes(metric)
        ? current.filter((row) => row !== metric)
        : [...current, metric];
      return next.length > 0 ? next : current;
    });
  };

  const selectListed = (next: EvalMetric[]) => {
    if (next.length === 0) return;
    setMetrics(next);
  };

  const toggleBudget = (budget: TierBudget) => {
    setTierBudgets((current) => {
      const on = current.includes(budget);
      if (on) {
        const next = current.filter((row) => row !== budget);
        return next.length > 0 ? next : current;
      }
      return [...current, budget].sort((a, b) => a - b);
    });
  };

  const order = () => {
    try {
      const result = orderEval({ checkpointId, tier, tierBudgets, metrics });
      if (result.ok) {
        setActionErr(null);
        onClose();
        return;
      }
      setActionErr(result.reason);
    } catch (cause) {
      setActionErr(actionError(cause));
    }
  };

  return (
    <ConsoleDialog
      open={open}
      titleId="v4-evaluate"
      eyebrow="Evaluation"
      title={checkpoint ? `Evaluate ${checkpoint.name}` : "Evaluate checkpoint"}
      onClose={onClose}
      closeLabel="Close evaluation"
      maxWidthClass="max-w-4xl"
      footer={
        <DialogFooter
          onCancel={onClose}
          primaryLabel="Order"
          onPrimary={order}
          disabled={metrics.length === 0 || tierBudgets.length === 0}
        />
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2.5">
          {TIER_CARDS.map((card) => {
            const cost = quoteEvals(card.id, metrics, tierBudgets);
            const selected = tier === card.id;
            return (
              <GameCard
                key={card.id}
                title={card.label}
                interactive
                selected={selected}
                ariaLabel={card.label}
                onActivate={() => setTier(card.id)}
              >
                <p data-eval-tier={card.id} className="text-[0.75rem] leading-5 text-muted">
                  {card.blurb}
                </p>
                <p className="mt-2 font-mono text-[0.6875rem] tabular-nums text-bone">
                  {money(cost.cash)} · {formatDays(cost.days)} · σ {cost.sigma}
                </p>
              </GameCard>
            );
          })}
        </div>
        <div>
          <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="text-[0.75rem] text-muted">Metrics</p>
            <div className="flex flex-wrap gap-1">
              <HudButton
                type="button"
                variant={allSelected ? "primary" : "ghost"}
                className="!min-h-11"
                data-eval-metrics-all="true"
                aria-pressed={allSelected}
                onClick={() => selectListed(listedMetrics)}
              >
                All
              </HudButton>
              <HudButton
                type="button"
                variant={coreSelected ? "primary" : "ghost"}
                className="!min-h-11"
                data-eval-metrics-core="true"
                aria-pressed={coreSelected}
                onClick={() => selectListed(coreMetrics)}
              >
                Core
              </HudButton>
            </div>
          </div>
          <div className="flex flex-wrap gap-2" data-eval-metrics="true">
            {listedMetrics.map((metric) => {
              const on = metrics.includes(metric);
              return (
                <HudButton
                  key={metric}
                  type="button"
                  variant={on ? "primary" : "ghost"}
                  className="!min-h-11 capitalize"
                  aria-pressed={on}
                  onClick={() => toggleMetric(metric)}
                >
                  {titleCase(metric)}
                </HudButton>
              );
            })}
          </div>
        </div>
        <div>
          <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="text-[0.75rem] text-muted">Thinking budget</p>
            <HudButton
              type="button"
              variant={allThinkingSelected ? "primary" : "ghost"}
              className="!min-h-11"
              data-eval-thinking-all="true"
              aria-pressed={allThinkingSelected}
              disabled={trainedBudgets.length === 0}
              onClick={() => setTierBudgets([...trainedBudgets])}
            >
              All trained
            </HudButton>
          </div>
          <div className="flex flex-wrap gap-2" data-tier-budget="true">
            {TIER_BUDGETS.map((budget) => {
              const locked = checkpoint ? !thinkingUnlocked(checkpoint, budget) : budget !== 1;
              const selected = tierBudgets.includes(budget);
              return (
                <LockedChoice
                  key={budget}
                  selected={selected}
                  locked={locked}
                  reason={
                    checkpoint
                      ? thinkingLockReason(checkpoint, budget, canTrainThinking)
                      : THINKING_UNLOCK_REASON
                  }
                  onClick={() => toggleBudget(budget)}
                >
                  {tierLabel(budget)}
                </LockedChoice>
              );
            })}
          </div>
        </div>
        {leak > 0 ? (
          <p data-leak-risk="true" className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-[0.75rem] text-amber">
            Audit leak risk {Math.round(leak * 100)}%. Contaminated public scores can flag this endpoint later.
          </p>
        ) : null}
        <p className="font-mono text-[0.75rem] tabular-nums text-muted">
          {tierBudgets.length} {tierBudgets.length === 1 ? "bench" : "benches"} · {money(quote.cash)} ·{" "}
          {formatDays(quote.days)} · σ {quote.sigma}
        </p>
        {actionErr ? (
          <p role="alert" className="text-[0.75rem] text-danger">
            {actionErr}
          </p>
        ) : null}
      </div>
      <aside className="min-w-0 space-y-3 xl:sticky xl:top-0">
        {runningEval ? (
          <p className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 font-mono text-[0.6875rem] text-amber">
            Eval in flight · {runningEval.tier}
          </p>
        ) : null}
        {latestEval?.result ? (
          <>
            <EvalRadar measured={latestEval.result.measured} title="Last complete eval" />
          </>
        ) : (
          <p className="font-mono text-[0.6875rem] text-muted">
            No complete eval yet. Quick is free and wide; Suite is the usual paid panel; Audit can leak.
          </p>
        )}
      </aside>
      </div>
    </ConsoleDialog>
  );
}
