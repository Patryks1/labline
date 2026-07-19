import { BENCHMARK_DEFS } from '../balance/benchmarks'
import type { BenchmarkEvent, BenchmarkId, BenchmarkScores, Model, SimState } from '../types'

function publishedScoresFor(
  state: SimState,
  labId: string,
  model: Model,
): BenchmarkScores {
  const evaluation = state.evaluations
    .filter(
      (run) =>
        run.published &&
        run.kind === 'public' &&
        (run.labId ?? state.playerLabId) === labId &&
        run.modelId === model.id,
    )
    .toSorted((a, b) => b.publishDay - a.publishDay || b.id.localeCompare(a.id))[0]
  return { ...model.benchmarks, ...(evaluation?.scores ?? {}) }
}

/**
 * Build a post-release benchmark beat comparing the shipped model to rivals.
 * Pure helper for UI + unit tests.
 */
export function buildBenchmarkEvent(
  state: SimState,
  model: Model,
  day: number,
  publishedScores?: Partial<BenchmarkScores>,
): BenchmarkEvent {
  const modelScores: BenchmarkScores = { ...model.benchmarks, ...(publishedScores ?? {}) }
  const rivalCompare = BENCHMARK_DEFS.map((d) => {
    let bestRival = 0
    let rivalName = '—'
    for (const r of state.rivals) {
      const m = r.models.find((x) => x.shipped) ?? r.models[0]
      if (!m) continue
      const s = publishedScoresFor(state, r.id, m)[d.id] ?? 0
      if (s > bestRival) {
        bestRival = s
        rivalName = r.name
      }
    }
    const ours = modelScores[d.id] ?? 0
    return {
      benchmarkId: d.id as BenchmarkId,
      label: d.short,
      ours,
      bestRival,
      rivalName,
      win: ours >= bestRival,
    }
  })

  const wins = rivalCompare.filter((c) => c.win).length
  const losses = rivalCompare.length - wins
  const headline =
    wins >= losses + 2
      ? `${model.name} leads the board on ${wins} evals`
      : wins > losses
        ? `${model.name} edges rivals ${wins}–${losses}`
        : wins === losses
          ? `${model.name} ties the field — price and speed decide demand`
          : `${model.name} trails on ${losses} evals — compete on price or distill a specialist`

  return {
    id: `bench-${day}-${model.id}`,
    day,
    modelId: model.id,
    modelName: model.name,
    scores: modelScores,
    capability: model.capability,
    rivalCompare,
    wins,
    losses,
    headline,
    dismissed: false,
  }
}

export function attachBenchmarkOnRelease(state: SimState, model: Model): SimState {
  const ev = buildBenchmarkEvent(state, model, state.day)
  return {
    ...state,
    lastBenchmarkEvent: ev,
    news: [`Day ${state.day}: Benchmark day — ${ev.headline}`, ...state.news].slice(0, 20),
  }
}

export function dismissBenchmarkEvent(state: SimState): SimState {
  if (!state.lastBenchmarkEvent) return state
  return {
    ...state,
    lastBenchmarkEvent: { ...state.lastBenchmarkEvent, dismissed: true },
  }
}
