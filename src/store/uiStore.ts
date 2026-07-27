import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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
  balanced: { pixelRatio: 1, decorativeTraffic: true, lodTransitionMs: 200 },
  quality: { pixelRatio: 1.5, decorativeTraffic: true, lodTransitionMs: 250 },
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
  setInterfaceScale: (scale: InterfaceScale) => void
  setRenderPreset: (preset: RenderPreset) => void
  setReducedMotion: (reduced: boolean) => void
  setObjectivesOpen: (open: boolean) => void
  setSelectedRivalId: (id: string | null) => void
  requestConfirm: (request: ConfirmRequest) => void
  clearConfirm: () => void
  pushToast: (message: string, tone?: HudToast['tone']) => void
  clearToast: () => void
  announceRelease: (event: { name: string; capability: number }) => void
  clearRelease: () => void
  rotateMapCamera: (quarterTurns: number) => void
  cycleMapCameraTilt: () => void
  resetMapCamera: () => void
  toggleClouds: () => void
  setAudioMuted: (muted: boolean) => void
  setMasterVolume: (volume: number) => void
  setMusicVolume: (volume: number) => void
  setEffectsVolume: (volume: number) => void
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
        set({ releaseEvent: { id: Date.now(), name: event.name, capability: event.capability } }),
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
