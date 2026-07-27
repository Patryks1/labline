import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  DRAG_START_DISTANCE_PX,
  cameraRelativePanVector,
  createMapCameraRotation,
  grabbedWorldPanDelta,
  hasPointerDragged,
  mapCameraPose,
  mapCameraDistanceScale,
  mapViewportPlaneBounds,
  mapViewportPlaneFootprint,
  nextMapCameraTilt,
  retargetMapCameraRotation,
  rotateMapCameraHeading,
  sampleMapCameraRotation,
  shortestMapCameraHeadingDelta,
} from './mapControls'

describe('map drag controls', () => {
  it('moves the camera by the inverse world-space delta so grabbed terrain follows the pointer', () => {
    expect(grabbedWorldPanDelta(12, 20, 15, 16)).toEqual({ x: -3, z: 4 })
  })

  it('resolves four stable orthographic headings without changing distance', () => {
    const poses = ([0, 1, 2, 3] as const).map((heading) => mapCameraPose(heading, 'standard'))
    expect(poses[0]!.offsetX).toBeCloseTo(14)
    expect(poses[0]!.offsetZ).toBeCloseTo(14)
    expect(poses[1]!.offsetX).toBeCloseTo(14)
    expect(poses[1]!.offsetZ).toBeCloseTo(-14)
    expect(poses[2]!.offsetX).toBeCloseTo(-14)
    expect(poses[2]!.offsetZ).toBeCloseTo(-14)
    expect(poses[3]!.offsetX).toBeCloseTo(-14)
    expect(poses[3]!.offsetZ).toBeCloseTo(14)
    for (const pose of poses) expect(Math.hypot(pose.offsetX, pose.offsetZ)).toBeCloseTo(Math.hypot(14, 14))
  })

  it('cycles headings and tilt presets with safe wraparound', () => {
    expect(rotateMapCameraHeading(0, -1)).toBe(3)
    expect(rotateMapCameraHeading(3, 1)).toBe(0)
    expect(nextMapCameraTilt('low')).toBe('standard')
    expect(nextMapCameraTilt('standard')).toBe('high')
    expect(nextMapCameraTilt('high')).toBe('low')
  })

  it('uses the shortest signed quarter turn across heading wraparound', () => {
    expect(shortestMapCameraHeadingDelta(3, 0)).toBe(1)
    expect(shortestMapCameraHeadingDelta(0, 3)).toBe(-1)
    expect(shortestMapCameraHeadingDelta(1, 2)).toBe(1)
    expect(shortestMapCameraHeadingDelta(2, 1)).toBe(-1)
  })

  it('eases a camera rotation to its exact discrete target', () => {
    const rotation = retargetMapCameraRotation(createMapCameraRotation(0), 0, 1, 100, 320)
    expect(sampleMapCameraRotation(rotation, 100)).toEqual({ heading: 0, complete: false })
    const halfway = sampleMapCameraRotation(rotation, 260)
    expect(halfway.heading).toBeGreaterThan(0.5)
    expect(halfway.heading).toBeLessThan(1)
    expect(halfway.complete).toBe(false)
    expect(sampleMapCameraRotation(rotation, 420)).toEqual({ heading: 1, complete: true })
  })

  it('retargets repeated and reversed input from the in-flight pose without snapping', () => {
    const first = retargetMapCameraRotation(createMapCameraRotation(3), 3, 0, 0, 320)
    const firstSample = sampleMapCameraRotation(first, 80).heading
    const repeated = retargetMapCameraRotation(first, 0, 1, 80, 320)
    expect(repeated.startHeading).toBeCloseTo(firstSample)
    expect(repeated.targetHeading).toBe(5)

    const repeatedSample = sampleMapCameraRotation(repeated, 120).heading
    const reversed = retargetMapCameraRotation(repeated, 1, 0, 120, 320)
    expect(reversed.startHeading).toBeCloseTo(repeatedSample)
    expect(reversed.targetHeading).toBe(4)
  })

  it('snaps immediately when rotation duration is zero', () => {
    const snapped = retargetMapCameraRotation(createMapCameraRotation(0), 0, 3, 25, 0)
    expect(sampleMapCameraRotation(snapped, 25)).toEqual({ heading: -1, complete: true })
  })

  it('keeps keyboard movement relative to the current screen axes', () => {
    const north = cameraRelativePanVector(0, 1, 0)
    expect(north.x).toBeCloseTo(-Math.SQRT1_2)
    expect(north.z).toBeCloseTo(-Math.SQRT1_2)
    const northAtRotatedHeading = cameraRelativePanVector(1, 1, 0)
    expect(northAtRotatedHeading.x).toBeCloseTo(-Math.SQRT1_2)
    expect(northAtRotatedHeading.z).toBeCloseTo(Math.SQRT1_2)
    const right = cameraRelativePanVector(1, 0, 1)
    expect(right.x).toBeCloseTo(-Math.SQRT1_2)
    expect(right.z).toBeCloseTo(-Math.SQRT1_2)
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

  it('derives conservative viewport bounds symmetrically for all four headings', () => {
    const target = new THREE.Vector3(120, 3, 90)
    const bounds = ([0, 1, 2, 3] as const).map((heading) => {
      const pose = mapCameraPose(heading, 'standard')
      const camera = new THREE.OrthographicCamera(-18, 18, 11, -11, 0.1, 320)
      camera.position.set(
        target.x + pose.offsetX,
        target.y + pose.offsetY,
        target.z + pose.offsetZ,
      )
      camera.lookAt(target)
      camera.updateProjectionMatrix()
      return mapViewportPlaneBounds(camera, target.y, 1, 3, 12)
    })

    for (const value of bounds) {
      expect(value.minX).toBeLessThanOrEqual(target.x - 18)
      expect(value.maxX).toBeGreaterThanOrEqual(target.x + 18)
      expect(value.minY).toBeLessThanOrEqual(target.z - 18)
      expect(value.maxY).toBeGreaterThanOrEqual(target.z + 18)
    }
    expect(bounds[0]!.maxX - bounds[0]!.minX).toBe(bounds[2]!.maxX - bounds[2]!.minX)
    expect(bounds[0]!.maxY - bounds[0]!.minY).toBe(bounds[2]!.maxY - bounds[2]!.minY)
    expect(bounds[1]!.maxX - bounds[1]!.minX).toBe(bounds[3]!.maxX - bounds[3]!.minX)
    expect(bounds[1]!.maxY - bounds[1]!.minY).toBe(bounds[3]!.maxY - bounds[3]!.minY)
  })

  it('derives valid viewport bounds at in-between animated headings', () => {
    const target = new THREE.Vector3(80, 4, 96)
    for (const heading of [0.2, 0.5, 0.8, 3.5]) {
      const pose = mapCameraPose(heading, 'standard')
      const camera = new THREE.OrthographicCamera(-18, 18, 11, -11, 0.1, 320)
      camera.position.set(
        target.x + pose.offsetX,
        target.y + pose.offsetY,
        target.z + pose.offsetZ,
      )
      camera.lookAt(target)
      camera.updateProjectionMatrix()
      const bounds = mapViewportPlaneBounds(camera, target.y, 1, 3, 12)
      expect(bounds.minX).toBeLessThan(target.x)
      expect(bounds.maxX).toBeGreaterThan(target.x)
      expect(bounds.minY).toBeLessThan(target.z)
      expect(bounds.maxY).toBeGreaterThan(target.z)
    }
  })

  it('projects ordered camera corners into an exact ground footprint', () => {
    const target = new THREE.Vector3(80, 4, 96)
    const pose = mapCameraPose(0.37, 'standard')
    const camera = new THREE.OrthographicCamera(-18, 18, 11, -11, 0.1, 320)
    camera.position.set(
      target.x + pose.offsetX,
      target.y + pose.offsetY,
      target.z + pose.offsetZ,
    )
    camera.lookAt(target)
    camera.updateProjectionMatrix()

    const footprint = mapViewportPlaneFootprint(camera, target.y, 1)
    const expectedNdc = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const
    footprint.forEach((point, index) => {
      const projected = new THREE.Vector3(point.x, target.y, point.y).project(camera)
      expect(projected.x).toBeCloseTo(expectedNdc[index]![0], 5)
      expect(projected.y).toBeCloseTo(expectedNdc[index]![1], 5)
    })
  })

  it('tracks zoom, tilt, and continuous rotation in the ground footprint', () => {
    const target = new THREE.Vector3(32, 2, 48)
    const footprintAt = (heading: number, tilt: 'low' | 'high', halfWidth: number) => {
      const pose = mapCameraPose(heading, tilt)
      const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, 10, -10, 0.1, 320)
      camera.position.set(
        target.x + pose.offsetX,
        target.y + pose.offsetY,
        target.z + pose.offsetZ,
      )
      camera.lookAt(target)
      camera.updateProjectionMatrix()
      return mapViewportPlaneFootprint(camera, target.y, 1)
    }
    const width = (points: ReturnType<typeof footprintAt>) =>
      Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
    const depth = (points: ReturnType<typeof footprintAt>) =>
      Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y)

    expect(width(footprintAt(0, 'low', 20))).toBeCloseTo(40)
    expect(width(footprintAt(0, 'low', 10))).toBeCloseTo(20)
    expect(depth(footprintAt(0, 'low', 20))).toBeGreaterThan(depth(footprintAt(0, 'high', 20)))
    const start = footprintAt(0, 'low', 20)
    const midway = footprintAt(0.5, 'low', 20)
    const end = footprintAt(1, 'low', 20)
    expect(midway[0].x).not.toBeCloseTo(start[0].x)
    expect(midway[0].x).not.toBeCloseTo(end[0].x)
  })
})
