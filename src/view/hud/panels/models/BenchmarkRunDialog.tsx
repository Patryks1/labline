import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Flask, Gauge, Stack } from '@phosphor-icons/react'
import type { BenchmarkSuiteId, TrainingBenchmarkRequest, TrainingJob } from '../../../../sim/types'
import { money } from '../../format'
import { useGameStore } from '../../../../store/gameStore'
import { quoteTrainingBenchmark } from '../../../../sim/systems/training'
import { HudButton, HudRange } from '../../ui/HudPrimitives'
import { ConsoleDialog } from '../../ui/ConsoleDialog'
import {
  BENCHMARK_MAX_SPEND,
  BENCHMARK_MIN_SPEND,
  BENCHMARK_SPEND_STEP,
  BENCHMARK_SUITE_UI,
  eligibleBenchmarkSuitesForTraining,
  estimatedBenchmarkAccuracy,
} from './benchmarkRunUi'
import { benchmarkEffortRecipes } from '../../../../sim/balance/benchmarkCost'
import { INSTANT_EFFORT_ID } from '../../../../sim/balance/modelProduct'

export type BenchmarkRunRequest = TrainingBenchmarkRequest

export function BenchmarkRunDialog({
  open,
  job,
  cash,
  onClose,
  onSubmit,
}: {
  open: boolean
  job: TrainingJob
  cash: number
  onClose: () => void
  onSubmit: (request: BenchmarkRunRequest) => void
}) {
  const eligible = useMemo(() => eligibleBenchmarkSuitesForTraining(job), [job])
  const state = useGameStore((store) => store.state)
  const effortRecipes = useMemo(
    () => benchmarkEffortRecipes({ productProfile: job.productProfile }),
    [job.productProfile],
  )
  const [selected, setSelected] = useState<BenchmarkSuiteId[]>(() => eligible.slice(0, 1))
  const [spendPerSuite, setSpendPerSuite] = useState(100_000)
  const [effortRecipeId, setEffortRecipeId] = useState(INSTANT_EFFORT_ID)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (open && !wasOpen.current) {
      setSelected(eligible.slice(0, 1))
      setSpendPerSuite(100_000)
      setEffortRecipeId(INSTANT_EFFORT_ID)
    }
    wasOpen.current = open
  }, [open, eligible])

  const request = useMemo<BenchmarkRunRequest>(
    () => ({ suiteIds: selected, spendPerSuite, effortRecipeId }),
    [selected, spendPerSuite, effortRecipeId],
  )
  const quote = useMemo(() => {
    if (selected.length === 0) return null
    try {
      return quoteTrainingBenchmark(state, job, request)
    } catch {
      return null
    }
  }, [job, request, selected.length, state])
  const total = quote?.totalCost ?? spendPerSuite * selected.length
  const accuracy = estimatedBenchmarkAccuracy(spendPerSuite)
  const affordable = total <= cash
  const valid = quote != null && selected.length > 0 && affordable

  const toggleSuite = (suiteId: BenchmarkSuiteId) => {
    setSelected((current) => current.includes(suiteId)
      ? current.filter((candidate) => candidate !== suiteId)
      : [...current, suiteId])
  }

  return (
    <ConsoleDialog
      open={open}
      titleId={`benchmark-run-${job.id}`}
      eyebrow="Measure, do not train"
      title={`Benchmark ${job.name}`}
      description="This snapshots the current weights and scores Instant plus every trained effort head. Named heads need Process Reward research. Extra spend buys tighter intervals, not a stronger model."
      mobileDescription="Pick suites and effort, check the live cost, then run."
      onClose={onClose}
      maxWidthClass="max-w-4xl"
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="font-mono text-[0.6875rem] tabular-nums text-muted">
            <span className={affordable ? 'text-bone' : 'text-danger'}>{money(total)} total</span>
            {' · '}{money(cash)} cash available
          </div>
          <div className="grid grid-cols-2 gap-2 [&_.hud-button]:!min-h-11 sm:flex sm:[&_.hud-button]:!w-auto">
            <HudButton type="button" variant="ghost" onClick={onClose}>Cancel</HudButton>
            <HudButton
              type="button"
              variant="primary"
              disabled={!valid}
              title={
                selected.length === 0
                  ? 'Select at least one benchmark suite.'
                  : quote == null
                    ? 'A valid effort and workload quote is required.'
                  : !affordable
                    ? `Need ${money(total - cash)} more cash.`
                    : undefined
              }
              onClick={() =>
                onSubmit(request)
              }
            >
              Run {selected.length || 0} suite{selected.length === 1 ? '' : 's'}
            </HudButton>
          </div>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="space-y-4">
        <section aria-labelledby={`benchmark-suites-${job.id}`}>
          <div className="mb-2 flex items-end justify-between gap-3">
            <div>
              <p id={`benchmark-suites-${job.id}`} className="hud-eyebrow">Eligible suites</p>
              <p className="mt-1 text-[0.75rem] text-muted">
                {eligible.length} suite{eligible.length === 1 ? '' : 's'} matched to this model’s outputs
              </p>
            </div>
            {eligible.length > 1 ? (
              <HudButton
                type="button"
                variant="ghost"
                onClick={() => setSelected(selected.length === eligible.length ? [] : eligible)}
                className="!min-h-11 !px-2 !py-1 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-mint hover:text-bone xl:!min-h-0"
              >
                {selected.length === eligible.length ? 'Clear all' : 'Select all'}
              </HudButton>
            ) : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {eligible.map((suiteId) => {
              const suite = BENCHMARK_SUITE_UI[suiteId]
              const checked = selected.includes(suiteId)
              return (
                <label
                  key={suiteId}
                  className={`group relative cursor-pointer rounded-lg border p-3 transition focus-within:ring-2 focus-within:ring-mint/40 ${
                    checked
                      ? 'border-mint/55 bg-mint/10'
                      : 'border-line/70 bg-void/35 hover:border-line hover:bg-panel-2'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSuite(suiteId)}
                    className="sr-only"
                  />
                  <span className="flex items-start gap-2.5">
                    <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                      checked ? 'border-mint bg-mint text-void' : 'border-line bg-void text-transparent'
                    }`}>
                      <Check size="0.75rem" weight="bold" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start justify-between gap-2">
                        <strong className="block text-[0.8125rem] text-bone">{suite.label}</strong>
                        <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-muted">
                          {money(spendPerSuite)}
                        </span>
                      </span>
                      <span className="hud-mobile-detail mt-1 block text-[0.6875rem] leading-relaxed text-muted">
                        {suite.description}
                      </span>
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        </section>

        <fieldset>
          <legend className="hud-eyebrow">Inference effort</legend>
          <p className="mt-1 text-[0.6875rem] text-muted">
            Higher trained budgets use more generated tokens, PF and wall time.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2" role="radiogroup">
            {effortRecipes.map((recipe) => (
              <label
                key={recipe.id}
                className={`cursor-pointer rounded-lg border p-3 ${
                  effortRecipeId === recipe.id
                    ? 'border-mint/55 bg-mint/10'
                    : 'border-line/70 bg-void/35'
                }`}
              >
                <input
                  type="radio"
                  name={`benchmark-effort-${job.id}`}
                  value={recipe.id}
                  checked={effortRecipeId === recipe.id}
                  onChange={() => setEffortRecipeId(recipe.id)}
                  className="sr-only"
                />
                <span className="flex justify-between gap-2 text-[0.8125rem]">
                  <strong className="text-bone">{recipe.name}</strong>
                  <span className="font-mono text-mint">
                    {recipe.thinkingTokenMult.toFixed(1)}×
                  </span>
                </span>
                <span className="hud-mobile-detail mt-1 block text-[0.6875rem] text-muted">
                  {recipe.kind === 'instant'
                    ? 'Official base inference'
                    : 'Private projection; not an official public rank'}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        </div>

        <aside className="order-first rounded-lg border border-line/70 bg-void/45 p-3.5 lg:order-none lg:sticky lg:top-0 lg:h-fit [@media(max-height:600px)]:!order-first" data-mobile-priority="quote-first">
          <div className="flex items-center gap-2 text-mint">
            <Flask size="1rem" weight="duotone" />
            <p className="hud-eyebrow !text-mint">Sampling budget</p>
          </div>
          <div className="mt-3 flex items-end justify-between gap-3">
            <span className="text-[0.75rem] text-muted">Per selected suite</span>
            <strong className="font-mono text-lg tabular-nums text-bone">{money(spendPerSuite)}</strong>
          </div>
          <HudRange
            type="range"
            min={BENCHMARK_MIN_SPEND}
            max={BENCHMARK_MAX_SPEND}
            step={BENCHMARK_SPEND_STEP}
            value={spendPerSuite}
            aria-label="Benchmark spend per suite"
            aria-valuetext={money(spendPerSuite)}
            onChange={(event) => setSpendPerSuite(Number(event.target.value))}
            className="mt-2"
          />
          <div className="mt-1 flex justify-between font-mono text-[0.625rem] tabular-nums text-muted">
            <span>{money(BENCHMARK_MIN_SPEND)}</span>
            <span>{money(BENCHMARK_MAX_SPEND)}</span>
          </div>

          <div className="mt-4 space-y-2 border-t border-line/60 pt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.75rem] text-muted">Effort</span>
              <span className="font-mono text-[0.8125rem] text-bone">
                {effortRecipes.find((recipe) => recipe.id === effortRecipeId)?.name ?? 'Instant'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.75rem] text-muted">Inference cost</span>
              <span className="font-mono text-[0.8125rem] tabular-nums text-bone">
                {money(quote?.inferenceCost ?? 0)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.75rem] text-muted">Compute</span>
              <span className="font-mono text-[0.8125rem] tabular-nums text-research">
                {(quote?.workload.computePfDays ?? 0).toFixed(3)} PF-d
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.75rem] text-muted">Cost / task</span>
              <span className="font-mono text-[0.8125rem] tabular-nums text-bone">
                {money(
                  quote && quote.workload.taskCount > 0
                    ? quote.totalCost / quote.workload.taskCount
                    : 0,
                )}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.75rem] text-muted">Speed / latency</span>
              <span className="font-mono text-[0.8125rem] tabular-nums text-bone">
                {(quote?.workload.estimatedTokensPerSecond ?? 0).toFixed(1)} tok/s · {((quote?.workload.averageLatencyMs ?? 0) / 1_000).toFixed(1)}s
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-[0.75rem] text-muted">
                <Stack size="0.875rem" /> Suites
              </span>
              <span className="font-mono text-[0.8125rem] tabular-nums text-bone">{selected.length}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-[0.75rem] text-muted">
                <Gauge size="0.875rem" /> Est. accuracy
              </span>
              <span className="font-mono text-[0.8125rem] tabular-nums text-mint">
                {(accuracy * 100).toFixed(0)}%
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line/50 pt-2">
              <span className="text-[0.75rem] text-muted">Live total</span>
              <strong className={`font-mono text-base tabular-nums ${affordable ? 'text-bone' : 'text-danger'}`}>
                {money(total)}
              </strong>
            </div>
          </div>
          <p className="mt-3 rounded-md border border-mint/20 bg-mint/5 p-2 text-[0.6875rem] leading-relaxed text-muted">
            Expected uncertainty ±{((1 - accuracy) * 100).toFixed(0)}%. Results arrive after the simulator’s evaluation window.
          </p>
          {!affordable ? (
            <p role="alert" className="mt-2 text-[0.6875rem] text-danger">
              Insufficient cash by {money(total - cash)}.
            </p>
          ) : null}
        </aside>
      </div>
    </ConsoleDialog>
  )
}
