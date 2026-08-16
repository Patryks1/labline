import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConsoleDialog } from './ConsoleDialog'

describe('ConsoleDialog responsive frame', () => {
  it('uses a full-height phone surface with safe-area actions', () => {
    const markup = renderToStaticMarkup(createElement(
      ConsoleDialog,
      {
        open: true,
        titleId: 'mobile-dialog-title',
        title: 'Decision',
        description: 'Choose a bounded option.',
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
  })
})
