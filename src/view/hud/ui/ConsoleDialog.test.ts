import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConsoleDialog } from './ConsoleDialog'
import { shouldDismissConsoleDialogSwipe } from './consoleDialogGesture'

describe('ConsoleDialog responsive frame', () => {
  it('uses a full-height phone surface with safe-area actions', () => {
    const markup = renderToStaticMarkup(createElement(
      ConsoleDialog,
      {
        open: true,
        titleId: 'mobile-dialog-title',
        title: 'Decision',
        description: 'Choose a bounded option.',
        mobileDescription: 'Choose an option.',
        onClose: () => undefined,
        footer: createElement('button', null, 'Confirm'),
      },
      createElement('p', null, 'Details'),
    ))

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('h-[100dvh]')
    expect(markup).toContain('safe-area-inset-top')
    expect(markup).toContain('safe-area-inset-bottom')
    expect(markup).toContain('h-11 shrink-0')
    expect(markup).toContain('>Done</button>')
    expect(markup).toContain('hud-button')
    expect(markup).toContain('hud-dialog-backdrop')
    expect(markup).toContain('hud-dialog-shell')
    expect(markup).toContain('hud-dialog-grabber')
    expect(markup).toContain('data-swipe-dismiss="true"')
    expect(markup).toContain('data-swipe-ignore="true"')
    expect(markup).toContain('aria-describedby="mobile-dialog-title-description mobile-dialog-title-mobile-description"')
    expect(markup).toContain('hud-mobile-detail')
    expect(markup).toContain('hud-mobile-summary')
  })

  it('supports terminal outcomes that require an explicit footer action', () => {
    const markup = renderToStaticMarkup(createElement(
      ConsoleDialog,
      {
        open: true,
        titleId: 'terminal-dialog-title',
        title: 'Run complete',
        onClose: () => undefined,
        canClose: false,
        footer: createElement('button', null, 'New run'),
      },
      createElement('p', null, 'Final score'),
    ))

    expect(markup).toContain('New run')
    expect(markup).not.toContain('aria-label="Close dialog"')
    expect(markup).not.toContain('hud-dialog-grabber')
    expect(markup).toContain('data-swipe-dismiss="false"')
  })

  it('requires a deliberate, downward, mostly vertical swipe to dismiss', () => {
    expect(shouldDismissConsoleDialogSwipe({ deltaX: 4, deltaY: 74, elapsedMs: 500 })).toBe(true)
    expect(shouldDismissConsoleDialogSwipe({ deltaX: 3, deltaY: 36, elapsedMs: 50 })).toBe(true)
    expect(shouldDismissConsoleDialogSwipe({ deltaX: 70, deltaY: 42, elapsedMs: 50 })).toBe(false)
    expect(shouldDismissConsoleDialogSwipe({ deltaX: 0, deltaY: -90, elapsedMs: 80 })).toBe(false)
    expect(shouldDismissConsoleDialogSwipe({ deltaX: 2, deltaY: 28, elapsedMs: 30 })).toBe(false)
    expect(shouldDismissConsoleDialogSwipe({ deltaX: 2, deltaY: 100, elapsedMs: 1_200 })).toBe(false)
  })
})
