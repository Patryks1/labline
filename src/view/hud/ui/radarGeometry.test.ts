import { describe, expect, it } from 'vitest'
import { polygonPoints, radarGeometry, scaledPoint } from './radarGeometry'

describe('radar geometry', () => {
  it('creates one evenly distributed axis and polygon point per metric', () => {
    const geometry = radarGeometry(6)
    expect(geometry.axes).toHaveLength(6)
    expect(polygonPoints([20, 30, 40, 50, 60, 70], geometry.axes).split(' ')).toHaveLength(6)
  })

  it('clamps values and places a full score on the axis boundary', () => {
    const axis = radarGeometry(1).axes[0]!
    expect(scaledPoint(axis, 100)).toEqual({ x: axis.x, y: axis.y })
    expect(scaledPoint(axis, 140)).toEqual({ x: axis.x, y: axis.y })
  })
})
