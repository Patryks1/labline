import { describe, it } from 'vitest'
import type { RivalArchetype } from '../types'
import { runPlayBot } from './bot'

const env = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }
).process?.env ?? {}

interface RivalSummary {
  runs: number
  released: number
  modelCount: number[]
  capability: number[]
  firstReleaseDay: number[]
  cash: number[]
  corpus: number[]
  activeTraining: number
  noModelNoTraining: number
  bestParamsB: number[]
  bestCoverage: number[]
  bestDataQuality: number[]
  bestOutcomeDelta: number[]
  bestTrainCompute: number[]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

describe('early-game balance diagnostics', () => {
  it.runIf(env.LABLINE_EARLY_DIAGNOSTICS === '1')(
    'reports release timing and bottlenecks by rival archetype',
    () => {
      const seeds = Number(env.LABLINE_CALIBRATION_SEEDS ?? 50)
      const days = Number(env.LABLINE_CALIBRATION_DAYS ?? 180)
      const byArchetype = new Map<RivalArchetype, RivalSummary>()
      let example: unknown = null
      const player = {
        released: 0,
        capability: [] as number[],
        firstReleaseDay: [] as number[],
        cash: [] as number[],
        corpus: [] as number[],
        bestParamsB: [] as number[],
        bestCoverage: [] as number[],
        bestDataQuality: [] as number[],
        bestOutcomeDelta: [] as number[],
        bestTrainCompute: [] as number[],
      }

      for (let index = 0; index < seeds; index++) {
        const state = runPlayBot({ seed: index + 1, maxDays: days }).final
        const playerModels = state.player.models.filter(
          (model) => model.release === 'released' || model.shipped,
        )
        if (playerModels.length > 0) player.released++
        player.capability.push(
          Math.max(0, ...playerModels.map((model) => model.capability)),
        )
        if (playerModels.length > 0) {
          player.firstReleaseDay.push(
            Math.min(...playerModels.map((model) => model.releaseDay)),
          )
        }
        player.cash.push(state.player.cash)
        player.corpus.push(state.player.data.lifetimeProcessed)
        const playerBest = playerModels.toSorted(
          (a, b) => b.capability - a.capability,
        )[0]
        if (playerBest) {
          player.bestParamsB.push(playerBest.paramsB)
          player.bestCoverage.push(playerBest.dataCoverage ?? 0)
          player.bestDataQuality.push(playerBest.dataQualityUsed ?? 0)
          player.bestOutcomeDelta.push(playerBest.outcome?.capabilityDelta ?? 0)
          player.bestTrainCompute.push(playerBest.trainComputeSpent ?? 0)
        }

        for (const rival of state.rivals) {
          const summary = byArchetype.get(rival.archetype) ?? {
            runs: 0,
            released: 0,
            modelCount: [],
            capability: [],
            firstReleaseDay: [],
            cash: [],
            corpus: [],
            activeTraining: 0,
            noModelNoTraining: 0,
            bestParamsB: [],
            bestCoverage: [],
            bestDataQuality: [],
            bestOutcomeDelta: [],
            bestTrainCompute: [],
          }
          const models = rival.models.filter(
            (model) => model.release === 'released' || model.shipped,
          )
          summary.runs++
          summary.modelCount.push(models.length)
          if (models.length > 0) {
            summary.released++
            summary.firstReleaseDay.push(
              Math.min(...models.map((model) => model.releaseDay)),
            )
          }
          summary.capability.push(
            Math.max(0, ...models.map((model) => model.capability)),
          )
          summary.cash.push(rival.cash)
          summary.corpus.push(rival.data?.lifetimeProcessed ?? 0)
          if (rival.trainingJob) summary.activeTraining++
          if (models.length === 0 && !rival.trainingJob) summary.noModelNoTraining++
          const best = models.toSorted(
            (a, b) => b.capability - a.capability,
          )[0]
          if (best) {
            summary.bestParamsB.push(best.paramsB)
            summary.bestCoverage.push(best.dataCoverage ?? 0)
            summary.bestDataQuality.push(best.dataQualityUsed ?? 0)
            summary.bestOutcomeDelta.push(best.outcome?.capabilityDelta ?? 0)
            summary.bestTrainCompute.push(best.trainComputeSpent ?? 0)
          }
          byArchetype.set(rival.archetype, summary)
        }
        if (index === 0) {
          const modelFacts = (models: typeof state.player.models) =>
            models.map((model) => ({
              day: model.releaseDay,
              capability: model.capability,
              paramsB: model.paramsB,
              coverage: model.dataCoverage,
              quality: model.dataQualityUsed,
              postTrain: model.postTrain,
              outcome: model.outcome?.capabilityDelta,
              trainCompute: model.trainComputeSpent,
            }))
          example = {
            player: modelFacts(state.player.models),
            rivals: Object.fromEntries(
              state.rivals.map((rival) => [rival.archetype, modelFacts(rival.models)]),
            ),
          }
        }
      }

      const report = {
        seeds,
        days,
        player: {
          releaseRate: player.released / seeds,
          medianCapability: median(player.capability),
          medianFirstReleaseDay: median(player.firstReleaseDay),
          medianCash: median(player.cash),
          medianCorpus: median(player.corpus),
          medianBestParamsB: median(player.bestParamsB),
          medianBestCoverage: median(player.bestCoverage),
          medianBestDataQuality: median(player.bestDataQuality),
          medianBestOutcomeDelta: median(player.bestOutcomeDelta),
          medianBestTrainCompute: median(player.bestTrainCompute),
        },
        rivals: Object.fromEntries(
          [...byArchetype.entries()].map(([archetype, summary]) => [
            archetype,
            {
              releaseRate: summary.released / summary.runs,
              medianModels: median(summary.modelCount),
              medianCapability: median(summary.capability),
              medianFirstReleaseDay: median(summary.firstReleaseDay),
              medianCash: median(summary.cash),
              medianCorpus: median(summary.corpus),
              activeTrainingRate: summary.activeTraining / summary.runs,
              noModelNoTrainingRate: summary.noModelNoTraining / summary.runs,
              medianBestParamsB: median(summary.bestParamsB),
              medianBestCoverage: median(summary.bestCoverage),
              medianBestDataQuality: median(summary.bestDataQuality),
              medianBestOutcomeDelta: median(summary.bestOutcomeDelta),
              medianBestTrainCompute: median(summary.bestTrainCompute),
            },
          ]),
        ),
        example,
      }
      console.log(JSON.stringify(report))
    },
    30 * 60_000,
  )
})
