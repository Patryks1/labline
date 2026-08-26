import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LeftRail } from './LeftRail'

describe('LeftRail mobile sheet gestures', () => {
  it('keeps touch gestures on an explicit handle with an accessible close alternative', () => {
    const markup = renderToStaticMarkup(createElement(LeftRail))

    expect(markup).toMatch(/aria-label="[^"]+ workspace"/)
    expect(markup).toContain('aria-describedby="workspace-mobile-gesture-hint"')
    expect(markup).toContain('class="workspace-drawer__gesture-zone"')
    expect(markup).toContain('data-shell-gesture-surface="true"')
    expect(markup).toContain('class="workspace-drawer__mobile-close"')
    expect(markup).toContain('>Close</button>')
    expect(markup).toContain('swipe down from the top handle to close')
  })
})
