import { trainingDataDomainCapMTok } from '../../../sim/systems/training'
import type { DataDomain, DomainStock } from '../../../sim/types'
import { normalizeDomainStock } from '../../../sim/balance/data'

export { trainingDataDomainCapMTok }

export function rebalanceTrainingDataDomain(
  allocationsMTok: Record<DataDomain, number>,
  domain: DataDomain,
  valueMTok: number,
  capMTok = Number.POSITIVE_INFINITY,
) {
  return {
    ...allocationsMTok,
    [domain]: Math.max(0, Math.min(Math.max(0, capMTok), valueMTok)),
  }
}

/** Total selected volume across domains (MTok). */
export function totalAllocationMTok(
  allocations: Partial<Record<DataDomain, number>>,
): number {
  return Object.values(allocations).reduce(
    (sum, value) => sum + Math.max(0, value ?? 0),
    0,
  )
}

/** Display-only percentage: selected domain MTok / selected total MTok. */
export function domainSharePct(
  allocations: Partial<Record<DataDomain, number>>,
  domain: DataDomain,
): number {
  const total = totalAllocationMTok(allocations)
  const selected = Math.max(0, allocations[domain] ?? 0)
  return total > 1e-9 ? (selected / total) * 100 : 0
}

/** Why the hard cap is where it is — shown when the domain is at/over max. */
export function domainCapReason(
  availability: TrainingDataDomainAvailability,
  syntheticMultiplier = 0,
): string | null {
  const selected = availability.selectedMTok
  const cap = availability.capMTok
  if (selected + 1e-9 < cap) return null
  if (!(syntheticMultiplier > 0)) {
    if (availability.rawMTok > 0.05 && availability.usableMTok < 0.05) {
      return 'Capped: corpus is still raw — process it before training.'
    }
    if (availability.reservedMTok > 0.05) {
      return 'Capped at usable stock after active job reservations.'
    }
    return 'Capped at available real (+ enabled synthetic) stock.'
  }
  const base = availability.usableMTok + availability.syntheticHeadroomMTok
  if (base > 0 && Math.abs(cap - base * 8) < 1e-6) {
    return 'Capped at 8× synthetic expansion limit.'
  }
  return 'Capped at synthetic expansion headroom.'
}

/** Tooltip lines for a domain control: real / synth / selected / max (+ cap reason). */
export function domainAvailabilityTooltip(
  availability: TrainingDataDomainAvailability,
  syntheticMultiplier = 0,
): string {
  const synthStock =
    availability.usableSynthHQMTok + availability.usableSynthLQMTok
  const synthExpansion = Math.max(
    0,
    availability.capMTok - availability.usableMTok,
  )
  const lines = [
    `Available real: ${availability.usableRealMTok.toFixed(0)} MTok`,
    `Available synthetic: ${(synthStock + synthExpansion).toFixed(0)} MTok`,
    `Selected: ${availability.selectedMTok.toFixed(0)} MTok`,
    `Max: ${availability.capMTok.toFixed(0)} MTok`,
  ]
  const reason = domainCapReason(availability, syntheticMultiplier)
  if (reason) lines.push(reason)
  return lines.join('\n')
}

export interface TrainingDataDomainAvailability {
  /** Unprocessed logs/crawls still waiting on the cleaning pipeline. */
  rawMTok: number
  /** Owned real corpus (web crawl + user traffic + purchased lots), train-ready. */
  processedRealMTok: number
  /** Processed high-quality synthetic stock on hand. */
  processedSynthHQMTok: number
  /** Processed low-quality synthetic stock on hand. */
  processedSynthLQMTok: number
  /** Corpus already claimed by active training jobs. */
  reservedMTok: number
  /** Currently selected recipe volume for this domain. */
  selectedMTok: number
  /** Real stock after reservations. */
  usableRealMTok: number
  /** Enabled HQ synthetic stock after reservations (0 when excluded). */
  usableSynthHQMTok: number
  /** Enabled LQ synthetic stock after reservations (0 when excluded). */
  usableSynthLQMTok: number
  /**
   * Authoritative usable stock: processed owned real data + enabled processed
   * synthetic stock − data reserved by active jobs.
   */
  usableMTok: number
  /** Hard drag cap: usable stock plus bounded synthetic expansion headroom. */
  capMTok: number
  /** Future generated-token headroom (distill teacher corpus). */
  syntheticHeadroomMTok: number
}

/**
 * The one authoritative availability calculation for a radar domain. Every
 * consumer — drag cap, coverage waterfall, numeric input, tooltip — reads
 * this instead of deriving stock from the current allocation. Purchased
 * processed lots are already part of `stock.processed`, so they are usable
 * immediately; raw inventory is reported separately so an unprocessed corpus
 * reads as a processing gate rather than a broken control.
 */
export function trainingDataDomainAvailability(opts: {
  rawMTok?: number
  processedRealMTok: number
  processedSynthHQMTok?: number
  processedSynthLQMTok?: number
  reservedMTok?: number
  includeSynthHQ: boolean
  includeSynthLQ: boolean
  syntheticHeadroomMTok?: number
  syntheticMultiplier?: number
  selectedMTok?: number
}): TrainingDataDomainAvailability {
  const processedRealMTok = Math.max(0, opts.processedRealMTok)
  const processedSynthHQMTok = Math.max(0, opts.processedSynthHQMTok ?? 0)
  const processedSynthLQMTok = Math.max(0, opts.processedSynthLQMTok ?? 0)
  const reservedMTok = Math.max(0, opts.reservedMTok ?? 0)
  // Reservations drain real stock first, then synthetic, matching the
  // consumption waterfall used when jobs attribute corpus.
  let reservationLeft = reservedMTok
  const afterReservation = (volume: number) => {
    const taken = Math.min(volume, reservationLeft)
    reservationLeft -= taken
    return volume - taken
  }
  const usableRealMTok = afterReservation(processedRealMTok)
  const reservedSynthHQMTok = afterReservation(processedSynthHQMTok)
  const reservedSynthLQMTok = afterReservation(processedSynthLQMTok)
  const usableSynthHQMTok = opts.includeSynthHQ ? reservedSynthHQMTok : 0
  const usableSynthLQMTok = opts.includeSynthLQ ? reservedSynthLQMTok : 0
  const usableMTok = usableRealMTok + usableSynthHQMTok + usableSynthLQMTok
  const syntheticHeadroomMTok = Math.max(0, opts.syntheticHeadroomMTok ?? 0)
  const capMTok = trainingDataDomainCapMTok(
    usableMTok,
    syntheticHeadroomMTok,
    opts.syntheticMultiplier ?? 0,
  )
  return {
    rawMTok: Math.max(0, opts.rawMTok ?? 0),
    processedRealMTok,
    processedSynthHQMTok,
    processedSynthLQMTok,
    reservedMTok,
    selectedMTok: Math.max(0, opts.selectedMTok ?? 0),
    usableRealMTok,
    usableSynthHQMTok,
    usableSynthLQMTok,
    usableMTok,
    capMTok,
    syntheticHeadroomMTok,
  }
}

/** Availability straight from a domain stock record (radar/panel helper). */
export function domainStockAvailability(
  stock: DomainStock,
  opts: {
    reservedMTok?: number
    includeSynthHQ: boolean
    includeSynthLQ: boolean
    syntheticHeadroomMTok?: number
    syntheticMultiplier?: number
    selectedMTok?: number
  },
): TrainingDataDomainAvailability {
  const normalized = normalizeDomainStock(stock)
  return trainingDataDomainAvailability({
    rawMTok: normalized.raw,
    processedRealMTok: Math.max(
      0,
      normalized.processed - normalized.fromSynthHQ - normalized.fromSynthLQ,
    ),
    processedSynthHQMTok: normalized.fromSynthHQ,
    processedSynthLQMTok: normalized.fromSynthLQ,
    ...opts,
  })
}

export interface TrainingDataDomainFill {
  /** Hard drag cap for this domain (usable stock unless expansion is active). */
  capMTok: number
  realTake: number
  hqTake: number
  lqTake: number
  /** Tokens past the owned corpus covered by generated (teacher) synthetic data. */
  synthTake: number
  shortfall: number
}

/**
 * Coverage waterfall for one radar domain: usable real data first, then
 * stocked HQ/LQ synthetic, then freshly generated synthetic expansion past
 * the owned corpus — bounded by the authoritative availability cap so the
 * drag is blocked at usable stock when expansion is unavailable.
 */
export function trainingDataDomainFill(opts: {
  needMTok: number
  realAvailableMTok: number
  synthHQStockMTok: number
  synthLQStockMTok: number
  includeSynthHQ: boolean
  includeSynthLQ: boolean
  reservedMTok?: number
  syntheticMultiplier?: number
  syntheticHeadroomMTok?: number
}): TrainingDataDomainFill {
  const availability = trainingDataDomainAvailability({
    processedRealMTok: opts.realAvailableMTok,
    processedSynthHQMTok: opts.synthHQStockMTok,
    processedSynthLQMTok: opts.synthLQStockMTok,
    reservedMTok: opts.reservedMTok,
    includeSynthHQ: opts.includeSynthHQ,
    includeSynthLQ: opts.includeSynthLQ,
    syntheticHeadroomMTok: opts.syntheticHeadroomMTok,
    syntheticMultiplier: opts.syntheticMultiplier,
    selectedMTok: opts.needMTok,
  })
  const need = Math.max(0, opts.needMTok)
  const realTake = Math.min(need, availability.usableRealMTok)
  const hqTake = opts.includeSynthHQ
    ? Math.min(Math.max(0, need - realTake), availability.usableSynthHQMTok)
    : 0
  const lqTake = opts.includeSynthLQ
    ? Math.min(
        Math.max(0, need - realTake - hqTake),
        availability.usableSynthLQMTok,
      )
    : 0
  const capMTok = availability.capMTok
  const synthTake = Math.min(
    Math.max(0, need - realTake - hqTake - lqTake),
    Math.max(0, capMTok - realTake - hqTake - lqTake),
  )
  const shortfall = Math.max(0, need - realTake - hqTake - lqTake - synthTake)
  return { capMTok, realTake, hqTake, lqTake, synthTake, shortfall }
}
