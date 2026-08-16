/** Keep body selection separate from rename/dispose/caret controls. */
export function shouldSelectBuildingRowFromClick(targetIsControl: boolean): boolean {
  return !targetIsControl
}

export function activateBuildingRowFromClick(targetIsControl: boolean, select: () => void): boolean {
  if (!shouldSelectBuildingRowFromClick(targetIsControl)) return false
  select()
  return true
}

/** The row is focusable without becoming a nested button around its controls. */
export function shouldSelectBuildingRowFromKey(key: string, targetIsRow: boolean): boolean {
  return targetIsRow && (key === 'Enter' || key === ' ' || key === 'Spacebar')
}

export function activateBuildingRowFromKey(
  key: string,
  targetIsRow: boolean,
  select: () => void,
): boolean {
  if (!shouldSelectBuildingRowFromKey(key, targetIsRow)) return false
  select()
  return true
}
