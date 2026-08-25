import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  BenchmarkSuiteId,
  ModelFamily,
  ModelProductPreset,
  TrainingBenchmarkSnapshot,
  TrainingJob,
} from '../sim/types'
import {
  DEFAULT_MAP_CAMERA_HEADING,
  DEFAULT_MAP_CAMERA_TILT,
  isMapCameraHeading,
  isMapCameraTilt,
  nextMapCameraTilt,
  rotateMapCameraHeading,
  type MapCameraHeading,
  type MapCameraTilt,
} from '../view/three/mapControls'

export type { MapCameraHeading, MapCameraTilt } from '../view/three/mapControls'

export type InterfaceScale = 'auto' | 0.8 | 0.9 | 1 | 1.1 | 1.25 | 1.5

export type RenderPreset = 'performance' | 'balanced' | 'quality'

export interface AudioPreferences {
  audioMuted: boolean
  masterVolume: number
  musicVolume: number
  effectsVolume: number
}

export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  audioMuted: false,
  masterVolume: 1,
  musicVolume: 0.7,
  effectsVolume: 0.8,
}

export interface RenderSettings {
  pixelRatio: number
  decorativeTraffic: boolean
  lodTransitionMs: number
}

export const RENDER_PRESETS: Record<RenderPreset, RenderSettings> = {
  performance: { pixelRatio: 0.75, decorativeTraffic: false, lodTransitionMs: 0 },
  balanced: { pixelRatio: 1, decorativeTraffic: true, lodTransitionMs: 0 },
  quality: { pixelRatio: 1.5, decorativeTraffic: true, lodTransitionMs: 0 },
}

export interface ConfirmRequest {
  title: string
  body: string
  actionLabel: string
  tone?: 'danger' | 'warning' | 'neutral'
  onConfirm: () => void
}

export interface HudToast {
  id: number
  message: string
  tone: 'positive' | 'warning' | 'danger'
}

export interface ReleaseEvent {
  id: number
  name: string
  capability: number
  modelId?: string
  family?: ModelFamily
  productPreset?: ModelProductPreset
  benchmarkSuiteIds?: BenchmarkSuiteId[]
  /** Captured before release finalization removes the source training job. */
  lossHistory?: NonNullable<TrainingJob['lossHistory']>
  benchmarkSnapshots?: TrainingBenchmarkSnapshot[]
  energyMWh?: number
  energyMwDays?: number
}

export type NegotiationOutcome = 'idle' | 'countered' | 'declined' | 'agreed' | 'signed'

export interface NegotiationTranscriptLine {
  side: 'provider' | 'player'
  text: string
  status?: NegotiationOutcome
  day?: number
  /** Monotonic position in the retained conversation, not a wall-clock minute. */
  sequence?: number
  /** Legacy sequence field retained for conversations created before sequence was named. */
  minute?: number
}

export interface PersistedNegotiation {
  status: NegotiationOutcome
  message?: string
  transcript: NegotiationTranscriptLine[]
  failures: number
  contactAgainDay: number
  contractId?: string
  proposal?: { capacity: number; termDays: number; offer: number }
}

export const EMPTY_NEGOTIATION: PersistedNegotiation = {
  status: 'idle',
  transcript: [],
  failures: 0,
  contactAgainDay: 0,
}

export function createEmptyNegotiation(): PersistedNegotiation {
  return { ...EMPTY_NEGOTIATION, transcript: [] }
}

export function formatNegotiationTimestamp(
  line: Pick<NegotiationTranscriptLine, 'day' | 'sequence' | 'minute'>,
  fallbackDay: number,
  fallbackSequence: number,
): string {
  const sequence = line.sequence ?? line.minute ?? fallbackSequence
  return `Day ${line.day ?? fallbackDay} · message ${sequence + 1}`
}

/** Reopens a completed desk without discarding the audit trail from prior deals. */
export function reopenEndedNegotiation(
  current: PersistedNegotiation,
  hasActiveContract: boolean,
): PersistedNegotiation {
  if (current.status !== 'signed' || hasActiveContract) return current
  return {
    ...current,
    status: 'idle',
    message: undefined,
    proposal: undefined,
    contractId: undefined,
    failures: 0,
    contactAgainDay: 0,
  }
}

interface UiPreferences extends AudioPreferences {
  interfaceScale: InterfaceScale
  renderPreset: RenderPreset
  reducedMotion: boolean
  objectivesOpen: boolean
  selectedRivalId: string | null
  confirmRequest: ConfirmRequest | null
  toast: HudToast | null
  releaseEvent: ReleaseEvent | null
  mapCameraHeading: MapCameraHeading
  mapCameraTilt: MapCameraTilt
  cloudsVisible: boolean
  computeNegotiations: Record<string, PersistedNegotiation>
  powerNegotiations: Record<string, PersistedNegotiation>
  campaignDecisionJobId: string | null
  campaignEpoch: number
  setInterfaceScale: (scale: InterfaceScale) => void
  setRenderPreset: (preset: RenderPreset) => void
  setReducedMotion: (reduced: boolean) => void
  setObjectivesOpen: (open: boolean) => void
  setSelectedRivalId: (id: string | null) => void
  requestConfirm: (request: ConfirmRequest) => void
  clearConfirm: () => void
  pushToast: (message: string, tone?: HudToast['tone']) => void
  clearToast: () => void
  announceRelease: (event: Omit<ReleaseEvent, 'id'>) => void
  clearRelease: () => void
  rotateMapCamera: (quarterTurns: number) => void
  cycleMapCameraTilt: () => void
  resetMapCamera: () => void
  toggleClouds: () => void
  setAudioMuted: (muted: boolean) => void
  setMasterVolume: (volume: number) => void
  setMusicVolume: (volume: number) => void
  setEffectsVolume: (volume: number) => void
  updateComputeNegotiation: (providerId: string, update: (current: PersistedNegotiation) => PersistedNegotiation) => void
  updatePowerNegotiation: (counterpartyKey: string, update: (current: PersistedNegotiation) => PersistedNegotiation) => void
  resetComputeNegotiations: () => void
  clearNegotiations: () => void
  openCampaignDecision: (jobId: string) => void
  closeCampaignDecision: () => void
  beginCampaign: () => void
}

export function powerNegotiationKey(cityId: string, mode: 'import' | 'export'): string {
  return `${cityId}:${mode}`
}

export function resolveAutoScale(viewportHeight: number): number {
  if (viewportHeight <= 850) return 0.9
  if (viewportHeight < 1250) return 1
  if (viewportHeight < 1800) return 1.15
  return 1.35
}

export function resolveRenderSettings(preset: RenderPreset): RenderSettings {
  return RENDER_PRESETS[preset]
}

function validVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
}

export function migrateUiPreferences(persisted: unknown) {
  const state = (persisted && typeof persisted === 'object')
    ? persisted as Record<string, unknown>
    : {}
  return {
    ...state,
    mapCameraHeading: isMapCameraHeading(state.mapCameraHeading)
      ? state.mapCameraHeading
      : DEFAULT_MAP_CAMERA_HEADING,
    mapCameraTilt: isMapCameraTilt(state.mapCameraTilt)
      ? state.mapCameraTilt
      : DEFAULT_MAP_CAMERA_TILT,
    cloudsVisible: typeof state.cloudsVisible === 'boolean' ? state.cloudsVisible : true,
    audioMuted: typeof state.audioMuted === 'boolean'
      ? state.audioMuted
      : DEFAULT_AUDIO_PREFERENCES.audioMuted,
    masterVolume: validVolume(state.masterVolume, DEFAULT_AUDIO_PREFERENCES.masterVolume),
    musicVolume: validVolume(state.musicVolume, DEFAULT_AUDIO_PREFERENCES.musicVolume),
    effectsVolume: validVolume(state.effectsVolume, DEFAULT_AUDIO_PREFERENCES.effectsVolume),
  }
}

export function partializeUiPreferences(state: UiPreferences) {
  return {
    interfaceScale: state.interfaceScale,
    renderPreset: state.renderPreset,
    reducedMotion: state.reducedMotion,
    mapCameraHeading: state.mapCameraHeading,
    mapCameraTilt: state.mapCameraTilt,
    cloudsVisible: state.cloudsVisible,
    audioMuted: state.audioMuted,
    masterVolume: state.masterVolume,
    musicVolume: state.musicVolume,
    effectsVolume: state.effectsVolume,
  }
}

export const useUiStore = create<UiPreferences>()(
  persist(
    (set) => ({
      interfaceScale: 'auto',
      renderPreset: 'balanced',
      reducedMotion: false,
      objectivesOpen: false,
      selectedRivalId: null,
      confirmRequest: null,
      toast: null,
      releaseEvent: null,
      mapCameraHeading: DEFAULT_MAP_CAMERA_HEADING,
      mapCameraTilt: DEFAULT_MAP_CAMERA_TILT,
      cloudsVisible: true,
      computeNegotiations: {},
      powerNegotiations: {},
      campaignDecisionJobId: null,
      campaignEpoch: 0,
      ...DEFAULT_AUDIO_PREFERENCES,
      setInterfaceScale: (interfaceScale) => set({ interfaceScale }),
      setRenderPreset: (renderPreset) => set({ renderPreset }),
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
      setObjectivesOpen: (objectivesOpen) => set({ objectivesOpen }),
      setSelectedRivalId: (selectedRivalId) => set({ selectedRivalId }),
      requestConfirm: (confirmRequest) => set({ confirmRequest }),
      clearConfirm: () => set({ confirmRequest: null }),
      pushToast: (message, tone = 'positive') =>
        set({ toast: { id: Date.now(), message, tone } }),
      clearToast: () => set({ toast: null }),
      announceRelease: (event) =>
        set({
          releaseEvent: {
            ...event,
            // Snapshot all nested telemetry: the source job is finalized in
            // the same interaction and must not be referenced by identity.
            lossHistory: event.lossHistory?.map((point) => ({ ...point })),
            benchmarkSnapshots: event.benchmarkSnapshots?.map((snapshot) => ({
              ...snapshot,
              suiteIds: snapshot.suiteIds ? [...snapshot.suiteIds] : undefined,
              suiteResults: snapshot.suiteResults
                ? Object.fromEntries(
                    Object.entries(snapshot.suiteResults).map(([id, result]) => [
                      id,
                      result ? { ...result } : result,
                    ]),
                  ) as TrainingBenchmarkSnapshot['suiteResults']
                : undefined,
            })),
            benchmarkSuiteIds: event.benchmarkSuiteIds
              ? [...event.benchmarkSuiteIds]
              : undefined,
            id: Date.now(),
          },
        }),
      clearRelease: () => set({ releaseEvent: null }),
      rotateMapCamera: (quarterTurns) => set((state) => ({
        mapCameraHeading: rotateMapCameraHeading(state.mapCameraHeading, quarterTurns),
      })),
      cycleMapCameraTilt: () => set((state) => ({
        mapCameraTilt: nextMapCameraTilt(state.mapCameraTilt),
      })),
      resetMapCamera: () => set({
        mapCameraHeading: DEFAULT_MAP_CAMERA_HEADING,
        mapCameraTilt: DEFAULT_MAP_CAMERA_TILT,
      }),
      toggleClouds: () => set((state) => ({ cloudsVisible: !state.cloudsVisible })),
      setAudioMuted: (audioMuted) => set({ audioMuted }),
      setMasterVolume: (masterVolume) => set({ masterVolume: validVolume(masterVolume, 1) }),
      setMusicVolume: (musicVolume) => set({ musicVolume: validVolume(musicVolume, 0.7) }),
      setEffectsVolume: (effectsVolume) => set({ effectsVolume: validVolume(effectsVolume, 0.8) }),
      updateComputeNegotiation: (providerId, update) => set((state) => ({
        computeNegotiations: { ...state.computeNegotiations, [providerId]: update(state.computeNegotiations[providerId] ?? createEmptyNegotiation()) },
      })),
      updatePowerNegotiation: (counterpartyKey, update) => set((state) => ({
        powerNegotiations: { ...state.powerNegotiations, [counterpartyKey]: update(state.powerNegotiations[counterpartyKey] ?? createEmptyNegotiation()) },
      })),
      resetComputeNegotiations: () => set({ computeNegotiations: {} }),
      clearNegotiations: () => set({ computeNegotiations: {}, powerNegotiations: {} }),
      openCampaignDecision: (campaignDecisionJobId) => set({ campaignDecisionJobId }),
      closeCampaignDecision: () => set({ campaignDecisionJobId: null }),
      beginCampaign: () => set((state) => ({ campaignEpoch: state.campaignEpoch + 1 })),
    }),
    {
      name: 'labline-ui-v1',
      version: 4,
      migrate: migrateUiPreferences,
      partialize: partializeUiPreferences,
    },
  ),
)

export function useResolvedUiScale(): number {
  const scale = useUiStore((s) => s.interfaceScale)
  const [height, setHeight] = useState(() =>
    typeof window === 'undefined' ? 1080 : window.innerHeight,
  )

  useEffect(() => {
    if (scale !== 'auto') return
    const onResize = () => setHeight(window.innerHeight)
    window.addEventListener('resize', onResize, { passive: true })
    return () => window.removeEventListener('resize', onResize)
  }, [scale])

  return scale === 'auto' ? resolveAutoScale(height) : scale
}
