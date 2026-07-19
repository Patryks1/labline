import {
  createPerfController,
  createStandardCameraReplay,
  exposePerfController,
  type CameraInteraction,
  type CameraReplayFrame,
  type FrameMetricSample,
  type LablinePerfController,
} from '../../../testing/cameraReplay'

export interface MapPerfSession {
  readonly controller: LablinePerfController
  nextFrame(): CameraReplayFrame | undefined
  record(sample: FrameMetricSample): void
  dispose(): void
}

/** `?perf=1` installs the shared deterministic replay/collector contract. */
export function createMapPerfSession(width: number, height: number): MapPerfSession | null {
  if (typeof window === 'undefined') return null
  const enabled = new URLSearchParams(window.location.search).get('perf') === '1'
  if (!enabled) return null
  const controller = createPerfController(createStandardCameraReplay(width, height))
  const remove = exposePerfController(
    controller,
    window as unknown as Record<string, unknown>,
  )
  return {
    controller,
    nextFrame: () => controller.nextFrame(),
    record: (sample) => controller.record(sample),
    dispose: remove,
  }
}

export function currentInteraction(
  replayFrame: CameraReplayFrame | undefined,
  interactive: boolean,
): CameraInteraction {
  if (replayFrame) return replayFrame.interaction
  return interactive ? 'pan' : 'idle'
}
