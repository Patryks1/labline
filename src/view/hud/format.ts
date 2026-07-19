/** Currency — humanized K/M/B/T */
export function money(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000_000_000) return `${sign}$${(abs / 1_000_000_000_000).toFixed(2)}T`
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`
  if (abs > 0) return `${sign}$${abs.toFixed(3)}`
  return `${sign}$0`
}

export function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`
}

/** General numbers — K/M/B/T for scale */
export function num(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a >= 1_000_000_000_000) return `${sign}${(a / 1_000_000_000_000).toFixed(digits)}T`
  if (a >= 1_000_000_000) return `${sign}${(a / 1_000_000_000).toFixed(digits)}B`
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(digits)}M`
  if (a >= 10_000) return `${sign}${(a / 1_000).toFixed(digits)}K`
  if (a >= 1000) return `${sign}${(a / 1_000).toFixed(digits)}K`
  if (a >= 100) return `${sign}${a.toFixed(0)}`
  if (a >= 1) return `${sign}${a.toFixed(digits)}`
  if (a > 0) return `${sign}${a.toFixed(Math.max(digits, 2))}`
  return '0'
}

/** People / subscribers */
export function people(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (a >= 1_000_000_000) return `${sign}${(a / 1_000_000_000).toFixed(2)}B users`
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(2)}M users`
  if (a >= 1_000) return `${sign}${(a / 1_000).toFixed(1)}K users`
  return `${sign}${Math.round(a)} users`
}

/** Addressable audience / market population. */
export function audience(n: number): string {
  return people(n).replace(' users', ' people')
}

/** Memory */
export function gb(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1024) return `${(n / 1024).toFixed(1)} TB`
  if (n >= 10) return `${n.toFixed(0)} GB`
  return `${n.toFixed(1)} GB`
}

export function mw(n: number): string {
  if (n >= 1) return `${n.toFixed(1)} MW`
  return `${(n * 1000).toFixed(0)} kW`
}

/** PF / FLOPS display */
export function pf(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)} EF`
  if (n >= 10) return `${n.toFixed(1)} PF`
  return `${n.toFixed(2)} PF`
}
