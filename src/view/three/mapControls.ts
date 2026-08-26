import * as THREE from 'three'

export const DRAG_START_DISTANCE_PX = 5

export interface MapPinchSample {
  centerX: number
  centerY: number
  distance: number
}

export type MapCameraHeading = 0 | 1 | 2 | 3
export type MapCameraTilt = 'low' | 'standard' | 'high'

export const DEFAULT_MAP_CAMERA_HEADING: MapCameraHeading = 0
export const DEFAULT_MAP_CAMERA_TILT: MapCameraTilt = 'standard'
export const MAP_CAMERA_ROTATION_DURATION_MS = 320

const CAMERA_TILT_DEGREES: Record<MapCameraTilt, number> = {
  low: 34,
  standard: 39,
  high: 47,
}

export interface MapCameraPose {
  offsetX: number
  offsetY: number
  offsetZ: number
  forwardX: number
  forwardZ: number
  rightX: number
  rightZ: number
}

export interface MapViewportBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface MapViewportPoint {
  x: number
  y: number
}

/**
 * Ground intersections in screen order: bottom-left, bottom-right,
 * top-right, top-left. The final two points form the camera heading edge.
 */
export type MapViewportFootprint = [
  MapViewportPoint,
  MapViewportPoint,
  MapViewportPoint,
  MapViewportPoint,
]

export interface MapCameraRotation {
  startHeading: number
  targetHeading: number
  startedAtMs: number
  durationMs: number
}

export interface MapCameraRotationSample {
  heading: number
  complete: boolean
}

/**
 * Project the complete orthographic view onto a stable horizontal envelope.
 *
 * Viewport streaming must not raycast the currently resident terrain: directly
 * after a camera rotation those meshes still describe the previous heading,
 * so a mixture of mesh hits and fallback hits can select a torn set of chunks.
 * Sampling the upper and lower planes also conservatively covers hills and
 * tall props without depending on which surface chunks happen to be loaded.
 */
export function mapViewportPlaneBounds(
  camera: THREE.Camera,
  groundHeight: number,
  tileSize: number,
  marginTiles: number,
  heightEnvelope = 0,
): MapViewportBounds {
  const safeTileSize = Number.isFinite(tileSize) && tileSize > 0 ? tileSize : 1
  const safeMargin = Number.isFinite(marginTiles) ? Math.max(0, marginTiles) : 0
  const safeGround = Number.isFinite(groundHeight) ? groundHeight : 0
  const safeEnvelope = Number.isFinite(heightEnvelope) ? Math.max(0, heightEnvelope) : 0
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0))
  const hit = new THREE.Vector3()
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  camera.updateMatrixWorld(true)
  for (const height of safeEnvelope > 0
    ? [safeGround - safeEnvelope, safeGround + safeEnvelope]
    : [safeGround]) {
    plane.constant = -height
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      pointer.set(x, y)
      raycaster.setFromCamera(pointer, camera)
      if (!raycaster.ray.intersectPlane(plane, hit)) continue
      minX = Math.min(minX, hit.x / safeTileSize)
      maxX = Math.max(maxX, hit.x / safeTileSize)
      minY = Math.min(minY, hit.z / safeTileSize)
      maxY = Math.max(maxY, hit.z / safeTileSize)
    }
  }

  if (!Number.isFinite(minX)) {
    const centerX = camera.position.x / safeTileSize
    const centerY = camera.position.z / safeTileSize
    return {
      minX: centerX - safeMargin,
      maxX: centerX + safeMargin,
      minY: centerY - safeMargin,
      maxY: centerY + safeMargin,
    }
  }
  return {
    minX: Math.floor(minX) - safeMargin,
    maxX: Math.ceil(maxX) + safeMargin,
    minY: Math.floor(minY) - safeMargin,
    maxY: Math.ceil(maxY) + safeMargin,
  }
}

/** Project the visible camera corners onto the target-height ground plane. */
export function mapViewportPlaneFootprint(
  camera: THREE.Camera,
  groundHeight: number,
  tileSize: number,
): MapViewportFootprint {
  const safeTileSize = Number.isFinite(tileSize) && tileSize > 0 ? tileSize : 1
  const safeGround = Number.isFinite(groundHeight) ? groundHeight : 0
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -safeGround)
  const hit = new THREE.Vector3()
  const fallback = {
    x: camera.position.x / safeTileSize,
    y: camera.position.z / safeTileSize,
  }

  camera.updateMatrixWorld(true)
  return ([
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const).map(([x, y]) => {
    pointer.set(x, y)
    raycaster.setFromCamera(pointer, camera)
    if (!raycaster.ray.intersectPlane(plane, hit)) return { ...fallback }
    return { x: hit.x / safeTileSize, y: hit.z / safeTileSize }
  }) as MapViewportFootprint
}

export function isMapCameraHeading(value: unknown): value is MapCameraHeading {
  return value === 0 || value === 1 || value === 2 || value === 3
}

export function isMapCameraTilt(value: unknown): value is MapCameraTilt {
  return value === 'low' || value === 'standard' || value === 'high'
}

export function rotateMapCameraHeading(
  heading: MapCameraHeading,
  quarterTurns: number,
): MapCameraHeading {
  const turns = Number.isFinite(quarterTurns) ? Math.trunc(quarterTurns) : 0
  return (((heading + turns) % 4 + 4) % 4) as MapCameraHeading
}

/** Return the signed, shortest distance between two discrete headings. */
export function shortestMapCameraHeadingDelta(
  from: MapCameraHeading,
  to: MapCameraHeading,
): number {
  const clockwise = ((to - from) % 4 + 4) % 4
  return clockwise > 2 ? clockwise - 4 : clockwise
}

export function createMapCameraRotation(heading: MapCameraHeading): MapCameraRotation {
  return {
    startHeading: heading,
    targetHeading: heading,
    startedAtMs: 0,
    durationMs: 0,
  }
}

/** Sample a polished ease-out without exposing transient values to UI state. */
export function sampleMapCameraRotation(
  rotation: MapCameraRotation,
  nowMs: number,
): MapCameraRotationSample {
  if (rotation.durationMs <= 0) {
    return { heading: rotation.targetHeading, complete: true }
  }
  const elapsed = Number.isFinite(nowMs) ? nowMs - rotation.startedAtMs : rotation.durationMs
  const progress = Math.max(0, Math.min(1, elapsed / rotation.durationMs))
  const eased = 1 - Math.pow(1 - progress, 3)
  return {
    heading: THREE.MathUtils.lerp(rotation.startHeading, rotation.targetHeading, eased),
    complete: progress >= 1,
  }
}

/**
 * Retarget from the exact in-flight pose. The unwrapped target is advanced by
 * the discrete store delta so repeated E presses keep moving clockwise across
 * 3 -> 0, while repeated Q presses keep moving anticlockwise across 0 -> 3.
 */
export function retargetMapCameraRotation(
  rotation: MapCameraRotation,
  previousHeading: MapCameraHeading,
  nextHeading: MapCameraHeading,
  nowMs: number,
  durationMs = MAP_CAMERA_ROTATION_DURATION_MS,
): MapCameraRotation {
  const current = sampleMapCameraRotation(rotation, nowMs).heading
  const delta = shortestMapCameraHeadingDelta(previousHeading, nextHeading)
  const targetHeading = rotation.targetHeading + delta
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
  return {
    startHeading: current,
    targetHeading,
    startedAtMs: Number.isFinite(nowMs) ? nowMs : 0,
    durationMs: safeDuration,
  }
}

export function nextMapCameraTilt(tilt: MapCameraTilt): MapCameraTilt {
  if (tilt === 'low') return 'standard'
  if (tilt === 'standard') return 'high'
  return 'low'
}

/**
 * Resolve the orthographic camera offset and screen-relative ground axes.
 * Heading zero preserves the established south-east camera position.
 */
export function mapCameraPose(
  heading: number,
  tilt: MapCameraTilt,
  horizontalDistance = Math.hypot(14, 14),
): MapCameraPose {
  const angle = (Math.PI / 4) + heading * (Math.PI / 2)
  const offsetX = Math.sin(angle) * horizontalDistance
  const offsetZ = Math.cos(angle) * horizontalDistance
  const offsetY = Math.tan((CAMERA_TILT_DEGREES[tilt] * Math.PI) / 180) * horizontalDistance
  const forwardX = -offsetX / horizontalDistance
  const forwardZ = -offsetZ / horizontalDistance
  return {
    offsetX,
    offsetY,
    offsetZ,
    forwardX,
    forwardZ,
    rightX: -forwardZ,
    rightZ: forwardX,
  }
}

export function cameraRelativePanVector(
  heading: number,
  forwardInput: number,
  rightInput: number,
): { x: number; z: number } {
  const pose = mapCameraPose(heading, DEFAULT_MAP_CAMERA_TILT, 1)
  const x = pose.forwardX * forwardInput + pose.rightX * rightInput
  const z = pose.forwardZ * forwardInput + pose.rightZ * rightInput
  const length = Math.hypot(x, z)
  return length > 0 ? { x: x / length, z: z / length } : { x: 0, z: 0 }
}

export function rotateMapWorldOffset(
  heading: number,
  x: number,
  z: number,
): { x: number; z: number } {
  const angle = heading * Math.PI / 2
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return {
    x: x * cosine + z * sine,
    z: -x * sine + z * cosine,
  }
}

/**
 * Pull an orthographic camera back as its visible frustum grows. Distance does
 * not change orthographic scale, but it keeps every screen ray above the map's
 * ground plane at wide zoom levels.
 */
export function mapCameraDistanceScale(
  frustum: number,
  defaultFrustum: number,
): number {
  if (!Number.isFinite(frustum) || !Number.isFinite(defaultFrustum) || defaultFrustum <= 0) {
    return 1
  }
  return Math.max(1, frustum / defaultFrustum)
}

export function grabbedWorldPanDelta(
  anchorX: number,
  anchorZ: number,
  pointerWorldX: number,
  pointerWorldZ: number,
): { x: number; z: number } {
  return {
    x: anchorX - pointerWorldX,
    z: anchorZ - pointerWorldZ,
  }
}

/**
 * Sanitize a camera target component after pointer pans, keyboard movement, or
 * replay frames. A single non-finite value (for example from a bad elevation
 * sample or a coalesced wheel packet) otherwise poisons the camera matrix and
 * every projected ray, leaving the map permanently white until reload.
 */
export function sanitizeMapTargetComponent(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

export function hasPointerDragged(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): boolean {
  return Math.hypot(currentX - startX, currentY - startY) >= DRAG_START_DISTANCE_PX
}

/**
 * Resolve the midpoint and span for a two-finger gesture. Keeping this math
 * outside the renderer makes touch zoom deterministic and easy to regression
 * test without a WebGL surface.
 */
export function mapPinchSample(
  firstX: number,
  firstY: number,
  secondX: number,
  secondY: number,
): MapPinchSample {
  return {
    centerX: (firstX + secondX) / 2,
    centerY: (firstY + secondY) / 2,
    distance: Math.hypot(secondX - firstX, secondY - firstY),
  }
}

/**
 * Convert a pinch span change into an orthographic frustum change. Fingers
 * moving apart zoom in (a smaller frustum); moving together zooms out. Invalid
 * or zero-distance packets retain the current scale instead of poisoning the
 * camera projection.
 */
export function mapFrustumAfterPinch(
  currentFrustum: number,
  previousDistance: number,
  nextDistance: number,
  minFrustum: number,
  maxFrustum: number,
): number {
  const safeMin = Number.isFinite(minFrustum) ? minFrustum : 1
  const safeMax = Number.isFinite(maxFrustum) ? Math.max(safeMin, maxFrustum) : safeMin
  const safeCurrent = Number.isFinite(currentFrustum)
    ? Math.max(safeMin, Math.min(safeMax, currentFrustum))
    : safeMin
  if (
    !Number.isFinite(previousDistance) ||
    !Number.isFinite(nextDistance) ||
    previousDistance <= 0 ||
    nextDistance <= 0
  ) {
    return safeCurrent
  }
  return Math.max(safeMin, Math.min(safeMax, safeCurrent * previousDistance / nextDistance))
}
