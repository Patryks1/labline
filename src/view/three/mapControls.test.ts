import { describe, expect, it } from 'vitest'
import {
  DRAG_START_DISTANCE_PX,
  grabbedWorldPanDelta,
  hasPointerDragged,
  mapCameraDistanceScale,
} from './mapControls'

describe('map drag controls', () => {
  it('moves the camera by the inverse world-space delta so grabbed terrain follows the pointer', () => {
    expect(grabbedWorldPanDelta(12, 20, 15, 16)).toEqual({ x: -3, z: 4 })
  })

  it('keeps small pointer jitter as a click and starts dragging at the threshold', () => {
    expect(hasPointerDragged(100, 100, 102, 102)).toBe(false)
    expect(hasPointerDragged(100, 100, 100 + DRAG_START_DISTANCE_PX, 100)).toBe(true)
  })

  it('pulls the camera back with wide orthographic zoom without moving it closer at normal zoom', () => {
    expect(mapCameraDistanceScale(5, 11)).toBe(1)
    expect(mapCameraDistanceScale(11, 11)).toBe(1)
    expect(mapCameraDistanceScale(30, 11)).toBeCloseTo(30 / 11)
  })
})
