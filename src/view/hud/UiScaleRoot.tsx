import type { CSSProperties, ReactNode } from 'react'
import { useResolvedUiScale, useUiStore } from '../../store/uiStore'

export function UiScaleRoot({ children }: { children: ReactNode }) {
  const scale = useResolvedUiScale()
  const reducedMotion = useUiStore((s) => s.reducedMotion)
  const style = { '--ui-scale': scale } as CSSProperties

  return (
    <div
      className="ui-scale-root h-full w-full"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      style={style}
    >
      {children}
    </div>
  )
}
