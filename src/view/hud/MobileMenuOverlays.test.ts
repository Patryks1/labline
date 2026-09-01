import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  isMenuDismissSwipe,
  isOfficeTapGesture,
  isSheetDismissSwipe,
} from './menu/mobileOverlayGestures'

async function source(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

describe('mobile menu and overlay contracts', () => {
  it('recognizes deliberate dismiss gestures without stealing ordinary scrolls', () => {
    expect(isMenuDismissSwipe({ x: 12, y: 160 }, { x: 112, y: 172 })).toBe(true)
    expect(isMenuDismissSwipe({ x: 80, y: 160 }, { x: 190, y: 165 })).toBe(false)
    expect(isMenuDismissSwipe({ x: 12, y: 160 }, { x: 48, y: 300 })).toBe(false)

    expect(isSheetDismissSwipe({ x: 120, y: 18 }, { x: 130, y: 110 })).toBe(true)
    expect(isSheetDismissSwipe({ x: 120, y: 18 }, { x: 240, y: 65 })).toBe(false)
  })

  it('keeps setup actions visible and drops nonessential news at mobile bounds', async () => {
    const [menu, shell] = await Promise.all([
      source('./NewGameMenu.tsx'),
      source('./menu/LablineMenuShell.tsx'),
    ])

    expect(menu).toContain('main-menu-console--setup flex max-w-[64rem] flex-col !overflow-hidden')
    expect(menu).toContain('max-sm:!animate-none [@media(max-height:600px)]:!animate-none')
    expect(menu).toContain('main-menu-setup-scroll panel-scroll')
    expect(menu).toContain('main-menu-setup-footer relative isolate z-30')
    expect(menu).toContain('flex shrink-0 items-center justify-between')
    expect(menu).toContain('Difficulty choices. Swipe horizontally for more.')
    expect(menu).toContain('snap-x snap-mandatory')
    expect(menu).toContain("inline: 'center'")
    expect(menu).toContain('difficultyRefs.current[scenario]?.scrollIntoView')
    expect(menu).toContain('[@media(max-height:540px)]:!max-h-')
    // Fieldsets use a min-content inline size by default. The logo rail must
    // scroll inside the card instead of widening the entire 320px console.
    expect(menu).toContain('main-menu-logo-maker min-w-0 max-w-full')
    expect(menu).toContain('main-menu-setup flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden')
    expect(shell).toContain('max-sm:hidden [@media(max-height:540px)]:hidden')
    expect(shell).toContain('overflow-x-hidden overflow-y-auto overscroll-contain touch-pan-y')
  })

  it('uses compact, non-crushing settings and a compact release GTM on phones', async () => {
    const [settings, release] = await Promise.all([
      source('./menu/SettingsPanel.tsx'),
      source('./ReleaseCelebration.tsx'),
    ])

    expect(settings).toContain('grid-cols-2 gap-1.5 min-[420px]:grid-cols-4')
    expect(settings).toContain('overflow-x-auto overscroll-x-contain')
    expect(release).not.toContain('data-testid="release-evidence-mobile"')
    expect(release).not.toContain('Measured evidence')
    expect(release).toContain('data-testid="release-comparable-peers"')
    expect(release).toContain('data-testid="release-thinking-heads"')
    expect(release).not.toContain('sm:max-h-36')
    expect(release).toContain('sm:h-[92dvh]')
  })

  it('separates the mobile HQ floor from its controls and never places during orbit drag', async () => {
    const office = await source('./panels/HqOfficeEditorOverlay.tsx')

    expect(isOfficeTapGesture({ x: 10, y: 10 }, { x: 15, y: 14 })).toBe(true)
    expect(isOfficeTapGesture({ x: 10, y: 10 }, { x: 28, y: 18 })).toBe(false)
    expect(office).toContain('data-mobile-workspace={mobileFloorView}')
    expect(office).toContain('aria-label="Floor editor view"')
    expect(office).toContain('role="dialog"')
    expect(office).toContain('aria-modal="true"')
    expect(office).toContain('window.addEventListener("keydown", closeOnEscape, true)')
    expect(office).toContain('max(1rem,env(safe-area-inset-right))')
    expect(office).toContain('max-width:1180px)_and_(orientation:landscape)_and_(max-height:600px)]:!sticky')
    expect(office).toContain('canvas.addEventListener("pointerup", up)')
    expect(office).not.toContain('className="h-full min-h-[20rem]')
  })

  it('gives objectives and inspectors one bounded scroll owner with swipe affordances', async () => {
    const [objectives, inspector] = await Promise.all([
      source('./ObjectivesDock.tsx'),
      source('./TileInspector.tsx'),
    ])

    expect(objectives).toContain('data-swipe-dismiss="down"')
    expect(objectives).toContain('min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain')
    expect(inspector).toContain('data-swipe-dismiss="down"')
    expect(inspector).toContain('index >= 5')
  })
})
