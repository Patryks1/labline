import type { CSSProperties } from 'react'

/**
 * HUD drawers use grid tracks for positioning, but the world must span every
 * track so expanding a drawer never changes the Three.js canvas dimensions.
 */
export const FULL_BLEED_MAP_STYLE = {
  gridColumn: '1 / -1',
  gridRow: '1 / -1',
  zIndex: 0,
} satisfies CSSProperties
