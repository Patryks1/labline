import { describe, expect, it } from 'vitest'
import {
  RADAR_CENTER,
  RADAR_LABEL_BOX,
  RADAR_RADIUS,
  polygonPoints,
  radarGeometry,
  scaledPoint,
} from './radarGeometry'

function labelBoxClosestToCenter(axis: { labelX: number; labelY: number }) {
  const halfW = RADAR_LABEL_BOX.width / 2
  const halfH = RADAR_LABEL_BOX.height / 2
  const qx = Math.min(axis.labelX + halfW, Math.max(axis.labelX - halfW, RADAR_CENTER.x))
  const qy = Math.min(axis.labelY + halfH, Math.max(axis.labelY - halfH, RADAR_CENTER.y))
  return Math.hypot(qx - RADAR_CENTER.x, qy - RADAR_CENTER.y)
}

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

  it('places the first axis at the top and keeps labels on their spokes', () => {
    const { axes, center } = radarGeometry(11)
    expect(axes[0]!.ux).toBeCloseTo(0, 8)
    expect(axes[0]!.uy).toBeCloseTo(-1, 8)

    for (const axis of axes) {
      const dx = axis.labelX - center.x
      const dy = axis.labelY - center.y
      const len = Math.hypot(dx, dy)
      expect(dx / len).toBeCloseTo(axis.ux, 8)
      expect(dy / len).toBeCloseTo(axis.uy, 8)
      expect(labelBoxClosestToCenter(axis)).toBeGreaterThanOrEqual(RADAR_RADIUS)
    }
  })

  it('mirrors left and right label offsets for even axis counts', () => {
    const { axes, center } = radarGeometry(6)
    expect(axes[1]!.labelX - center.x).toBeCloseTo(center.x - axes[5]!.labelX, 8)
    expect(axes[1]!.labelY).toBeCloseTo(axes[5]!.labelY, 8)
    expect(axes[2]!.labelX - center.x).toBeCloseTo(center.x - axes[4]!.labelX, 8)
    expect(axes[2]!.labelY).toBeCloseTo(axes[4]!.labelY, 8)
  })
})
