import { useEffect, useMemo, useState } from "react";
import { Check, Flask, Gauge, ShieldCheck, Warning } from "@phosphor-icons/react";
import type {
  BenchmarkSuiteId,
  TrainingCheckpointCandidate,
} from "../../../../sim/types";
import {
  eligibleCheckpointEvaluationSuites,
  quoteCheckpointEvaluation,
  type CheckpointEvaluationBudgetTier,
  type CheckpointEvaluationMode,
  type CheckpointEvaluationRequest,
} from "../../../../sim/balance/checkpointEvaluation";
import { money } from "../../format";
import { HudButton } from "../../ui/HudPrimitives";
import { ConsoleDialog } from "../../ui/ConsoleDialog";
import { BENCHMARK_SUITE_UI } from "./benchmarkRunUi";

const MODE_OPTIONS: ReadonlyArray<{
  id: CheckpointEvaluationMode;
  label: string;
  description: string;
  risk: string;
}> = [
  {
    id: "internal",
    label: "Internal red team",
    description: "Fastest, cheapest review using your own blind red-team panel.",
    risk: "No external leak surface",
  },
  {
    id: "nda_external",
    label: "NDA external",
    description: "Independent blind panel with stronger contamination control.",
    risk: "Small information-leak risk",
  },
  {
    id: "partner_pilot",
    label: "Partner pilot",
    description: "Field-use evidence from a larger production-oriented panel.",
    risk: "Highest cost, duration and leak risk",
  },
];

const BUDGET_OPTIONS: ReadonlyArray<{
  id: CheckpointEvaluationBudgetTier;
  label: string;
  spend: number;
  description: string;
}> = [
  {
    id: "lean",
    label: "Lean",
    spend: 50_000,
    description: "Directional evidence with a wider interval.",
  },
  {
    id: "standard",
    label: "Standard",
    spend: 100_000,
    description: "Balanced sampling and repeat adjudication.",
  },
  {
    id: "rigorous",
    label: "Rigorous",
    spend: 150_000,
    description: "Largest sample and tightest expected interval.",
  },
];

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function CheckpointEvaluationDialog({
  open,
  candidate,
  cash,
  initialMode = "internal",
  onClose,
  onSubmit,
}: {
  open: boolean;
  candidate: TrainingCheckpointCandidate;
  cash: number;
  initialMode?: CheckpointEvaluationMode;
  onClose: () => void;
  onSubmit: (request: CheckpointEvaluationRequest) => void;
}) {
  const eligible = useMemo(
    () => eligibleCheckpointEvaluationSuites(candidate.model),
    [candidate.model],
  );
  const eligibleKey = eligible.join("|");
  const firstEligibleSuite = eligible[0];
  const [selected, setSelected] = useState<BenchmarkSuiteId[]>(() =>
    eligible.slice(0, 1),
  );
  const [mode, setMode] = useState<CheckpointEvaluationMode>(initialMode);
  const [budgetTier, setBudgetTier] =
    useState<CheckpointEvaluationBudgetTier>("standard");

  useEffect(() => {
    if (!open) return;
    setSelected(firstEligibleSuite ? [firstEligibleSuite] : []);
    setMode(initialMode);
    setBudgetTier("standard");
    // eligibleKey resets the order when a different checkpoint supports a
    // different modality set without making array identity an effect input.
    void eligibleKey;
  }, [open, candidate.id, initialMode, eligibleKey, firstEligibleSuite]);

  const request = useMemo<CheckpointEvaluationRequest>(
    () => ({ suiteIds: selected, budgetTier, mode }),
    [selected, budgetTier, mode],
  );
  const { quote, error } = useMemo(() => {
    if (selected.length === 0) {
      return { quote: null, error: "Select at least one evaluation suite." };
    }
    try {
      return {
        quote: quoteCheckpointEvaluation(candidate.model, request),
        error: null,
      };
    } catch (cause) {
      return {
        quote: null,
        error:
          cause instanceof Error ? cause.message : "Evaluation quote failed.",
      };
    }
  }, [candidate.model, request, selected.length]);
  const affordable = quote != null && quote.totalCost <= cash;
  const valid = quote != null && affordable && selected.length > 0;

  const toggleSuite = (suiteId: BenchmarkSuiteId) => {
    setSelected((current) =>
      current.includes(suiteId)
        ? current.filter((candidateId) => candidateId !== suiteId)
        : [...current, suiteId],
    );
  };

  return (
    <ConsoleDialog
      open={open}
      titleId={`checkpoint-evaluation-${candidate.id}`}
      eyebrow="Stealth evaluation order"
      title={`Evaluate ${candidate.model.name}`}
      description="Choose compatible suites, panel exposure and study depth. This produces noisy evidence only—it does not improve the weights or start serving customers."
      onClose={onClose}
      closeLabel="Close checkpoint evaluation"
      maxWidthClass="max-w-5xl"
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="font-mono text-[0.6875rem] tabular-nums text-muted">
            <span className={affordable ? "text-bone" : "text-danger"}>
              {quote ? money(quote.totalCost) : "No quote"}
            </span>{" "}
            · {money(cash)} cash available
          </div>
          <div className="flex gap-2">
            <HudButton type="button" variant="ghost" onClick={onClose}>
              Cancel
            </HudButton>
            <HudButton
              type="button"
              variant="primary"
              disabled={!valid}
              title={
                error ??
                (!affordable && quote
                  ? `Need ${money(quote.totalCost - cash)} more cash.`
                  : undefined)
              }
              onClick={() => valid && onSubmit(request)}
            >
              Schedule evaluation
            </HudButton>
          </div>
        </div>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="space-y-4">
          <section aria-labelledby={`checkpoint-suites-${candidate.id}`}>
            <div className="mb-2 flex items-end justify-between gap-3">
              <div>
                <p
                  id={`checkpoint-suites-${candidate.id}`}
                  className="hud-eyebrow"
                >
                  Compatible suites
                </p>
                <p className="mt-1 text-[0.75rem] text-muted">
                  Only outputs this checkpoint can produce are available.
                </p>
              </div>
              {eligible.length > 1 ? (
                <HudButton
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setSelected(
                      selected.length === eligible.length ? [] : eligible,
                    )
                  }
                  className="!min-h-11 !px-2 !py-1 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-mint transition hover:text-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/45 sm:!min-h-0"
                >
                  {selected.length === eligible.length
                    ? "Clear all"
                    : "Select all"}
                </HudButton>
              ) : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {eligible.map((suiteId) => {
                const suite = BENCHMARK_SUITE_UI[suiteId];
                const checked = selected.includes(suiteId);
                return (
                  <label
                    key={suiteId}
                    className={`cursor-pointer rounded-lg border p-3 transition focus-within:ring-2 focus-within:ring-mint/40 ${
                      checked
                        ? "border-mint/55 bg-mint/10"
                        : "border-line/70 bg-void/35 hover:border-line hover:bg-panel-2"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSuite(suiteId)}
                      className="sr-only"
                    />
                    <span className="flex items-start gap-2.5">
                      <span
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                          checked
                            ? "border-mint bg-mint text-void"
                            : "border-line bg-void text-transparent"
                        }`}
                      >
                        <Check size="0.75rem" weight="bold" />
                      </span>
                      <span className="min-w-0">
                        <strong className="block text-[0.8125rem] text-bone">
                          {suite.label}
                        </strong>
                        <span className="mt-1 block text-[0.6875rem] leading-relaxed text-muted">
                          {suite.description}
                        </span>
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <fieldset>
            <legend className="hud-eyebrow">Review mode</legend>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              {MODE_OPTIONS.map((option) => {
                const checked = mode === option.id;
                return (
                  <label
                    key={option.id}
                    className={`cursor-pointer rounded-lg border p-3 transition focus-within:ring-2 focus-within:ring-mint/40 ${
                      checked
                        ? "border-mint/55 bg-mint/10"
                        : "border-line/70 bg-void/35 hover:border-line"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`checkpoint-mode-${candidate.id}`}
                      value={option.id}
                      checked={checked}
                      onChange={() => setMode(option.id)}
                      className="sr-only"
                    />
                    <strong className="block text-[0.8125rem] text-bone">
                      {option.label}
                    </strong>
                    <span className="mt-1 block text-[0.6875rem] leading-5 text-muted">
                      {option.description}
                    </span>
                    <span
                      className={`mt-2 block font-mono text-[0.625rem] uppercase tracking-[0.1em] ${
                        option.id === "internal" ? "text-mint" : "text-amber"
                      }`}
                    >
                      {option.risk}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="hud-eyebrow">Study depth</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {BUDGET_OPTIONS.map((option) => {
                const checked = budgetTier === option.id;
                return (
                  <label
                    key={option.id}
                    className={`cursor-pointer rounded-lg border p-3 transition focus-within:ring-2 focus-within:ring-mint/40 ${
                      checked
                        ? "border-research/60 bg-research/10"
                        : "border-line/70 bg-void/35 hover:border-line"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`checkpoint-budget-${candidate.id}`}
                      value={option.id}
                      checked={checked}
                      onChange={() => setBudgetTier(option.id)}
                      className="sr-only"
                    />
                    <span className="flex items-start justify-between gap-2">
                      <strong className="text-[0.8125rem] text-bone">
                        {option.label}
                      </strong>
                      <span className="font-mono text-[0.6875rem] tabular-nums text-research">
                        {money(option.spend)}/suite
                      </span>
                    </span>
                    <span className="mt-1 block text-[0.6875rem] leading-5 text-muted">
                      {option.description}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>

        <aside
          aria-label="Checkpoint evaluation quote"
          className="h-fit rounded-lg border border-line/70 bg-void/45 p-3.5 xl:sticky xl:top-0"
        >
          <div className="flex items-center gap-2 text-mint">
            <Flask size="1rem" weight="duotone" />
            <p className="hud-eyebrow !text-mint">Live quote</p>
          </div>
          {quote ? (
            <>
              <dl className="mt-3 space-y-2 font-mono text-[0.6875rem] tabular-nums">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted">Suite studies</dt>
                  <dd className="text-bone">{money(quote.suiteCost)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted">Blind panel</dt>
                  <dd className="text-bone">{money(quote.panelCost)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-line/50 pt-2">
                  <dt className="text-muted">Total</dt>
                  <dd
                    className={`text-base font-semibold ${
                      affordable ? "text-bone" : "text-danger"
                    }`}
                  >
                    {money(quote.totalCost)}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <div className="rounded-md bg-panel-2/65 p-2">
                  <span className="flex items-center gap-1 text-[0.625rem] uppercase tracking-[0.1em] text-muted">
                    <Gauge size="0.75rem" /> Accuracy
                  </span>
                  <strong className="mt-1 block font-mono text-sm tabular-nums text-mint">
                    {percent(quote.accuracy)}
                  </strong>
                </div>
                <div className="rounded-md bg-panel-2/65 p-2">
                  <span className="flex items-center gap-1 text-[0.625rem] uppercase tracking-[0.1em] text-muted">
                    <ShieldCheck size="0.75rem" /> Confidence
                  </span>
                  <strong className="mt-1 block font-mono text-sm tabular-nums text-bone">
                    {percent(quote.confidence)}
                  </strong>
                </div>
                <div className="rounded-md bg-panel-2/65 p-2">
                  <span className="block text-[0.625rem] uppercase tracking-[0.1em] text-muted">
                    Duration
                  </span>
                  <strong className="mt-1 block font-mono text-sm tabular-nums text-bone">
                    {quote.durationDays}d
                  </strong>
                </div>
                <div className="rounded-md bg-panel-2/65 p-2">
                  <span className="block text-[0.625rem] uppercase tracking-[0.1em] text-muted">
                    Reviewers
                  </span>
                  <strong className="mt-1 block font-mono text-sm tabular-nums text-bone">
                    {quote.reviewerCount}
                  </strong>
                </div>
              </div>
              <div
                className={`mt-3 flex gap-2 rounded-md border p-2.5 ${
                  quote.leakRisk > 0
                    ? "border-amber/35 bg-amber/10"
                    : "border-mint/25 bg-mint/5"
                }`}
              >
                {quote.leakRisk > 0 ? (
                  <Warning
                    className="mt-0.5 shrink-0 text-amber"
                    size="0.875rem"
                    weight="fill"
                  />
                ) : (
                  <ShieldCheck
                    className="mt-0.5 shrink-0 text-mint"
                    size="0.875rem"
                  />
                )}
                <p className="text-[0.6875rem] leading-5 text-muted">
                  Leak risk {percent(quote.leakRisk)} · contamination risk {percent(quote.contaminationRisk)}.
                </p>
              </div>
              {!affordable ? (
                <p role="alert" className="mt-2 text-[0.6875rem] text-danger">
                  Insufficient cash by {money(quote.totalCost - cash)}.
                </p>
              ) : null}
            </>
          ) : (
            <p role="alert" className="mt-3 text-[0.6875rem] text-danger">
              {error}
            </p>
          )}
        </aside>
      </div>
    </ConsoleDialog>
  );
}
