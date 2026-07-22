import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type InterfaceScale = 'auto' | 0.8 | 0.9 | 1 | 1.1 | 1.25 | 1.5

export type RenderPreset = 'performance' | 'balanced' | 'quality'

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

interface UiPreferences {
  interfaceScale: InterfaceScale
  renderPreset: RenderPreset
  reducedMotion: boolean
  objectivesOpen: boolean
  selectedRivalId: string | null
  confirmRequest: ConfirmRequest | null
  toast: HudToast | null
  releaseEvent: ReleaseEvent | null
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
    }),
    {
      name: 'labline-ui-v1',
      partialize: (state) => ({
        interfaceScale: state.interfaceScale,
        renderPreset: state.renderPreset,
        reducedMotion: state.reducedMotion,
      }),
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
