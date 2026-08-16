import { describe, expect, it } from 'vitest'
import { nearestChartDatum, prepareChartData } from './chartGeometry'

describe('chart data geometry', () => {
  it('sorts render points once while retaining source indexes for domain lookups', () => {
    const prepared = prepareChartData(
      [
        { x: 30, y: 3, id: 'late' },
        { x: 10, y: 1, id: 'early' },
        { x: 20, y: 2 },
      ],
      'series',
    )

    expect(prepared.map((point) => point.x)).toEqual([10, 20, 30])
    expect(prepared.map((point) => point.sourceIndex)).toEqual([1, 2, 0])
    expect(prepared.map((point) => point.id)).toEqual(['early', 'series-2', 'late'])
  })

  it('finds the nearest point using weighted chart coordinates', () => {
    const points = [
      { id: 'left', x: 0 },
      { id: 'right', x: 100 },
    ]
    const nearest = nearestChartDatum(
      points,
      (point) => ({ left: point.x, top: 0 }),
      { left: 90, top: 0 },
    )

    expect(nearest?.datum.id).toBe('right')
  })
})
