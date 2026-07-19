import { describe, expect, it } from 'vitest'
import { collectQuarterlyLabSnapshots } from '../systems/progression'
import { runPlayBot } from './bot'
import { modelOfferApiPrice } from '../systems/market'

const env = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }
).process?.env ?? {}

describe('abundance strategy balance', () => {
  it.runIf(env.LABLINE_ABUNDANCE_DIAGNOSTIC === '1')(
    'prints comparable end-state abundance metrics',
    () => {
      const report = runPlayBot({
        seed: Number(env.LABLINE_ABUNDANCE_SEED ?? 1),
        maxDays: 4_017,
        difficulty: 'normal',
      })
      const rows = collectQuarterlyLabSnapshots(report.final).map((row) => {
        const rival = report.final.rivals.find((candidate) => candidate.id === row.labId)
        const models =
          row.labId === report.final.playerLabId
            ? report.final.player.models
            : (rival?.models ?? [])
        const flagship = models.toSorted(
          (a, b) => b.capability - a.capability || a.id.localeCompare(b.id),
        )[0]
        return {
          labId: row.labId,
          strategy: rival?.archetype ?? 'balanced_cloud',
          capability: row.capability,
          price: flagship
            ? modelOfferApiPrice(
                rival?.pricing ?? report.final.player.pricing,
                flagship,
              )
            : null,
          costPerUsefulTask: row.costPerUsefulTask,
          servedDemandShare: row.servedDemandShare,
          grossMargin: row.grossMargin,
          reliability: row.reliability,
          paramsB: flagship?.paramsB,
          activeParamsB: flagship?.activeParamsB,
          family: flagship?.family,
          modelCount: models.length,
          defaultApiPrice:
            rival?.pricing.apiPricePerMTok ?? report.final.player.pricing.apiPricePerMTok,
          dayRevenue:
            rival?.finance?.dayRevenue ?? report.final.player.finance.dayRevenue,
          dayCogs: rival?.finance?.dayCogs ?? report.final.player.finance.dayCogs,
          dayEnergy:
            rival?.finance?.dayEnergyCost ?? report.final.player.finance.dayEnergyCost,
          dayChipAmort:
            rival?.finance?.dayChipAmort ?? report.final.player.finance.dayChipAmort,
          rackCapital: (
            rival?.rackFleet ?? report.final.player.rackFleet
          ).reduce(
            (sum, rack) =>
              sum + (rack.status === 'live' ? rack.paidEach * rack.count : 0),
            0,
          ),
          leaseOut:
            rival?.computeLeaseCostToday ?? report.final.player.computeLeaseCostToday,
        }
      })
      console.log(JSON.stringify(rows))
      expect(report.final.progression.decadeReport).not.toBeNull()
    },
    120_000,
  )
})
