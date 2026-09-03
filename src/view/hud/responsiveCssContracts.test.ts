import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../../index.css', import.meta.url)),
  'utf8',
)

describe('responsive CSS contracts', () => {
  it('uses a vertical rail and a single-row command bar in short landscape', () => {
    expect(css).toContain(
      '@media (orientation: landscape) and (max-height: 600px) and (max-width: 1180px)',
    )
    expect(css).toContain('--mobile-nav-height: 0px')
    expect(css).toContain('grid-template-columns: var(--mobile-nav-width) minmax(0, 1fr)')
    expect(css).toContain('grid-template-rows: repeat(5, minmax(2.75rem, 1fr))')
  })

  it('keeps the desktop training strip spanning rail to intel above operations', () => {
    const start = css.indexOf('.training-activity-bar {')
    const end = start < 0 ? -1 : css.indexOf('}', start)
    const block = start < 0 || end < 0 ? '' : css.slice(start, end + 1)

    expect(block).toContain('left: var(--hud-rail)')
    expect(block).toContain('right: var(--intel-width)')
    expect(block).toContain('bottom: calc(var(--hud-ops) + var(--hud-space-2))')
    expect(block).toContain('max-width: calc(100vw - var(--hud-rail) - var(--intel-width))')
  })

  it('reserves distinct mobile layers for operations, training, and map tools', () => {
    expect(css).toContain(
      '--hud-bottom-telemetry-bottom: calc(var(--mobile-nav-height) + var(--hud-ops) + var(--hud-training-height) + 0.45rem)',
    )
    expect(css).toContain(".training-activity-bar[data-job-count='0']")
    expect(css).toContain(".game-shell:has(.operations-shell[data-expanded='true']) .training-activity-bar")
  })

  it('keeps dialog scrolling separate from horizontal swipe-safe rails', () => {
    expect(css).toContain("[data-swipe-ignore='true']")
    expect(css).toContain(".hud-dialog-content[data-swipe-ignore='true']")
    expect(css).toContain('touch-action: pan-x pan-y')
    expect(css).toContain('touch-action: pan-y')
  })

  it('keeps mobile controls touch-sized and mobile input text zoom-safe', () => {
    expect(css).toContain('.serve-model-load__toggle[data-mobile-disclosure]')
    expect(css).toContain('.research-queue-action')
    expect(css).toContain('min-height: max(2.75rem, 44px)')
    expect(css).toContain('font-size: 1rem')
  })

  it('contains narrow title setup content inside its one vertical scroll owner', () => {
    expect(css).toContain('.main-menu-logo-workbench')
    expect(css).toContain('.main-menu-setup-footer')
    expect(css).toContain('overflow-x: hidden')
    expect(css).toContain('min-width: 0 !important')
  })

  it('keeps short-landscape model and benchmark workbenches card-first', () => {
    expect(css).toContain("[data-models-workbench-layout='responsive']")
    expect(css).toContain("[data-models-view-tabs='true']")
    expect(css).toContain('[data-mobile-official-benchmarks]')
    expect(css).toContain('[data-desktop-official-benchmarks]')
  })

  it('keeps short-landscape model actions swipeable without trapping vertical scroll', () => {
    expect(css).toContain("[data-mobile-actions='sticky-grid']")
    expect(css).toContain('scroll-snap-type: inline proximity')
    expect(css).toContain(
      "[data-models-short-landscape='compact-runs'] [role='list']",
    )
    expect(css).toContain('overscroll-behavior-y: auto')
  })

  it('caps the portrait More sheet to its available layer with one scroll owner', () => {
    expect(css).toContain('.mobile-more-layer {')
    expect(css).toContain('.mobile-more-sheet > .mobile-more-gesture-zone')
    expect(css).toContain('max-height: 100%')
    expect(css).toContain('flex: 1 1 auto')
    expect(css).toContain('touch-action: pan-y')
  })

  it('keeps the dialog swipe grabber to one touch-sized row', () => {
    expect(css).toContain('.hud-dialog-shell > .hud-dialog-grabber')
    expect(css).toContain('flex: 0 0 max(2.75rem, 44px)')
  })
})
