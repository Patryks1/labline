export interface ChartDatum {
  x: number
  y: number
  id?: string
}

export interface PreparedChartDatum extends ChartDatum {
  id: string
  sourceIndex: number
}

/**
 * Normalize chart points once for both rendering and interaction.
 *
 * `sourceIndex` deliberately remains the caller's index. Existing HUD
 * consumers use that index to look up their domain row, while the sorted
 * order keeps geometry and tooltips aligned on the x axis.
 */
export function prepareChartData<T extends ChartDatum>(
  points: readonly T[],
  seriesId: string,
): Array<PreparedChartDatum & T> {
  return points
    .map((point, sourceIndex) => ({
      ...point,
      id: point.id ?? `${seriesId}-${sourceIndex}`,
      sourceIndex,
    }))
    .sort((a, b) => a.x - b.x || a.sourceIndex - b.sourceIndex)
}

export interface ChartCoordinate {
  left: number
  top: number
}

export function nearestChartDatum<T>(
  data: readonly T[],
  coordinate: (datum: T) => ChartCoordinate,
  pointer: ChartCoordinate,
): { datum: T; distance: number } | null {
  let nearest: { datum: T; distance: number } | null = null
  for (const datum of data) {
    const position = coordinate(datum)
    const distance = Math.abs(position.left - pointer.left) * 2 + Math.abs(position.top - pointer.top)
    if (!nearest || distance < nearest.distance) nearest = { datum, distance }
  }
  return nearest
}
