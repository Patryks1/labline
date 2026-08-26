import { useMemo, useState } from 'react'
import { Flask } from '@phosphor-icons/react'
import type { BenchmarkSuiteId, Model } from '../../../../sim/types'
import {
  eligibleCheckpointEvaluationSuites,
  quoteCheckpointEvaluation,
  type CheckpointEvaluationBudgetTier,
  type CheckpointEvaluationMode,
  type CheckpointEvaluationRequest,
} from '../../../../sim/balance/checkpointEvaluation'
import { money } from '../../format'
import { HudButton } from '../../ui/HudPrimitives'
import { BENCHMARK_SUITE_UI } from './benchmarkRunUi'

const MODE_OPTIONS: ReadonlyArray<{
  id: CheckpointEvaluationMode
  label: string
  description: string
}> = [
  {
    id: 'internal',
    label: 'Internal red team',
    description: 'Fastest, cheapest review using your own blind panel.',
  },
  {
    id: 'nda_external',
    label: 'NDA external',
    description: 'Independent blind panel with stronger contamination control.',
  },
  {
    id: 'partner_pilot',
    label: 'Partner pilot',
    description: 'Field-use evidence from a larger production-oriented panel.',
  },
]

const BUDGET_OPTIONS: ReadonlyArray<{
  id: CheckpointEvaluationBudgetTier
  label: string
  spend: number
}> = [
  { id: 'lean', label: 'Lean', spend: 50_000 },
  { id: 'standard', label: 'Standard', spend: 100_000 },
  { id: 'rigorous', label: 'Rigorous', spend: 150_000 },
]

export function ReleaseEvaluationOrder({
  model,
  cash,
  preferredSuiteIds,
  onSubmit,
}: {
  model: Model
  cash: number
  preferredSuiteIds: readonly BenchmarkSuiteId[]
  onSubmit: (request: CheckpointEvaluationRequest) => void
}) {
  const eligible = useMemo(
    () => eligibleCheckpointEvaluationSuites(model),
    [model],
  )
  const defaultSuites = useMemo(() => {
    const preferred = preferredSuiteIds.filter((suiteId) =>
      eligible.includes(suiteId),
    )
    return (preferred.length > 0 ? preferred : eligible).slice(0, 1)
  }, [eligible, preferredSuiteIds])
  const [selected, setSelected] = useState<BenchmarkSuiteId[]>(defaultSuites)
  const [mode, setMode] = useState<CheckpointEvaluationMode>('nda_external')
  const [budgetTier, setBudgetTier] =
    useState<CheckpointEvaluationBudgetTier>('standard')

  const request = useMemo<CheckpointEvaluationRequest>(
    () => ({ suiteIds: selected, budgetTier, mode }),
    [selected, budgetTier, mode],
  )
  const { quote, error } = useMemo(() => {
    if (selected.length === 0) {
      return { quote: null, error: 'Select at least one evaluation suite.' }
    }
    try {
      return { quote: quoteCheckpointEvaluation(model, request), error: null }
    } catch (cause) {
      return {
        quote: null,
        error:
          cause instanceof Error ? cause.message : 'Evaluation quote failed.',
      }
    }
  }, [model, request, selected.length])
  const affordable = quote != null && quote.totalCost <= cash
  const valid = quote != null && affordable && selected.length > 0

  const toggleSuite = (suiteId: BenchmarkSuiteId) => {
    setSelected((current) =>
      current.includes(suiteId)
        ? current.filter((id) => id !== suiteId)
        : [...current, suiteId],
    )
  }

  if (eligible.length === 0) {
    return (
      <p className="mt-3 text-[0.75rem] leading-relaxed text-muted">
        This version has no compatible public suites yet.
      </p>
    )
  }

  return (
    <div className="mt-3 space-y-3" data-release-evaluation-mobile="stacked">
      <div className="grid gap-2 sm:grid-cols-2">
        {eligible.map((suiteId) => {
          const suite = BENCHMARK_SUITE_UI[suiteId]
          const checked = selected.includes(suiteId)
          return (
            <label
              key={suiteId}
              className={`min-h-11 cursor-pointer rounded-md border px-3 py-2 text-[0.75rem] transition ${
                checked
                  ? 'border-mint/55 bg-mint/10'
                  : 'border-line/60 bg-void/35 hover:border-line'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleSuite(suiteId)}
                className="sr-only"
              />
              <strong className="block text-bone">{suite.label}</strong>
              <span className="hud-mobile-detail mt-0.5 block text-[0.6875rem] leading-relaxed text-muted">
                {suite.description}
              </span>
            </label>
          )
        })}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {MODE_OPTIONS.map((option) => {
          const checked = mode === option.id
          return (
            <label
              key={option.id}
              className={`min-h-11 cursor-pointer rounded-md border px-3 py-2 text-[0.75rem] ${
                checked
                  ? 'border-mint/55 bg-mint/10'
                  : 'border-line/60 bg-void/35'
              }`}
            >
              <input
                type="radio"
                name={`release-eval-mode-${model.id}`}
                checked={checked}
                onChange={() => setMode(option.id)}
                className="sr-only"
              />
              <strong className="block text-bone">{option.label}</strong>
              <span className="hud-mobile-detail mt-0.5 block text-[0.6875rem] text-muted">
                {option.description}
              </span>
            </label>
          )
        })}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {BUDGET_OPTIONS.map((option) => {
          const checked = budgetTier === option.id
          return (
            <label
              key={option.id}
              className={`min-h-11 cursor-pointer rounded-md border px-3 py-2 text-[0.75rem] ${
                checked
                  ? 'border-research/60 bg-research/10'
                  : 'border-line/60 bg-void/35'
              }`}
            >
              <input
                type="radio"
                name={`release-eval-budget-${model.id}`}
                checked={checked}
                onChange={() => setBudgetTier(option.id)}
                className="sr-only"
              />
              <span className="flex items-center justify-between gap-2">
                <strong className="text-bone">{option.label}</strong>
                <span className="font-mono text-[0.625rem] tabular-nums text-research">
                  {money(option.spend)}/suite
                </span>
              </span>
            </label>
          )
        })}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="font-mono text-[0.6875rem] tabular-nums text-muted">
          {quote
            ? `${money(quote.totalCost)} · ${quote.durationDays}d · ${(quote.accuracy * 100).toFixed(0)}% accuracy`
            : error}
          {quote && !affordable
            ? ` · need ${money(quote.totalCost - cash)} more`
            : ''}
        </p>
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
          className="min-h-11 w-full sm:w-auto"
        >
          <Flask size="0.875rem" />
          Run evaluation
          {quote ? ` · ${money(quote.totalCost)}` : ''}
        </HudButton>
      </div>
    </div>
  )
}
