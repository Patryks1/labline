import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type InterfaceScale = 'auto' | 0.8 | 0.9 | 1 | 1.1 | 1.25 | 1.5

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
  reducedMotion: boolean
  objectivesOpen: boolean
  confirmRequest: ConfirmRequest | null
  toast: HudToast | null
  releaseEvent: ReleaseEvent | null
  setInterfaceScale: (scale: InterfaceScale) => void
  setReducedMotion: (reduced: boolean) => void
  setObjectivesOpen: (open: boolean) => void
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

export const useUiStore = create<UiPreferences>()(
  persist(
    (set) => ({
      interfaceScale: 'auto',
      reducedMotion: false,
      objectivesOpen: false,
      confirmRequest: null,
      toast: null,
      releaseEvent: null,
      setInterfaceScale: (interfaceScale) => set({ interfaceScale }),
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
      setObjectivesOpen: (objectivesOpen) => set({ objectivesOpen }),
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
