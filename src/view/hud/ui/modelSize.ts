export type SizeUnit = 'M' | 'B' | 'T'

/** Accept plain values in the selected unit or pasted values such as 400M, 7B, and 1.8T. */
export function parseParamsBox(raw: string, selectedUnit: SizeUnit = 'B'): number | null {
  const value = raw.trim().toUpperCase().replace(/\s/g, '')
  if (!value) return null
  const match = value.match(/^([0-9]*\.?[0-9]+)([MBT])?$/)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unit = (match[2] as SizeUnit | undefined) ?? selectedUnit
  if (unit === 'T') return amount * 1000
  if (unit === 'M') return amount / 1000
  return amount
}
