import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../sim/createGame'
import { useGameStore } from '../../store/gameStore'
import { BottomBar } from './BottomBar'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')

describe('BottomBar operations overflow', () => {
  it('keeps glass on a sibling surface so pool flyouts are not clipped', () => {
    useGameStore.setState({ state: createGame(9_511) })
    const markup = renderToStaticMarkup(createElement(BottomBar))

    expect(markup).toContain('operations-panel__surface hud-surface')
    expect(markup).toContain('class="operations-panel pointer-events-auto')
    expect(markup).not.toContain('operations-panel hud-surface')
    expect(markup).toContain('data-pool-flyout="false"')
    expect(markup).toContain('operations-telemetry')
    expect(markup).toContain('operations-telemetry__served')
    expect(markup).toContain('operations-telemetry__actions')
    expect(markup).toContain('data-mobile-priority="primary"')
    expect(markup).toContain('data-mobile-priority="secondary"')
    expect(markup).toContain('data-mobile-priority="tertiary"')
    expect(markup).toContain('data-mobile-disclosure="true"')
    expect(markup).toContain('title="Open Train breakdown"')
    expect(markup).not.toContain('role="tooltip"')
    expect(css).not.toContain('operations-zero-note')
    expect(markup).not.toContain('Zero allocation pauses')
  })

  it('renders live pool load bars under allocation sliders', () => {
    useGameStore.setState({ state: createGame(9_512) })
    const markup = renderToStaticMarkup(createElement(BottomBar))
    expect(markup).toContain('data-testid="pool-load-train"')
    expect(markup).toContain('data-testid="pool-load-serve"')
    expect(markup).toContain('data-testid="pool-load-research"')
    expect(markup).toContain('role="progressbar"')
  })

  it('does not show a serve outage banner on a new game', () => {
    const markup = renderToStaticMarkup(createElement(BottomBar))
    expect(markup).not.toContain('data-testid="serve-outage-banner"')
    expect(markup).not.toContain('Coverage outage')
    expect(markup).not.toContain('Inference outage')
  })

  it('does not clip the telemetry row as a single nowrap overflow box', () => {
    const markup = renderToStaticMarkup(createElement(BottomBar))
    const telemetry = markup.match(/class="operations-telemetry[^"]*"/)?.[0] ?? ''

    expect(telemetry).toContain('operations-telemetry')
    expect(telemetry).not.toContain('overflow-hidden')
    expect(telemetry).not.toContain('whitespace-nowrap')
    expect(markup).toContain('operations-telemetry__facts')
  })

  it('parks pool flyouts above the training strip, outside the glass panel', () => {
    const flyoutStart = css.indexOf('.operations-pool-flyout {')
    const flyoutEnd = flyoutStart < 0 ? -1 : css.indexOf('}', flyoutStart)
    const shellStart = css.indexOf('.operations-shell {')
    const shellEnd = shellStart < 0 ? -1 : css.indexOf('}', shellStart)

    expect(flyoutStart).toBeGreaterThanOrEqual(0)
    expect(shellStart).toBeGreaterThanOrEqual(0)
    expect(css.slice(shellStart, shellEnd + 1)).toContain('overflow: visible')
    expect(css.slice(flyoutStart, flyoutEnd + 1)).toContain('var(--hud-training-height)')
    expect(css).toContain('.operations-panel__surface')
    expect(css).toContain("backdrop-filter cannot clip the pool flyout")
    expect(css).toContain(
      '.operations-telemetry__facts > .operations-stat:not(.operations-telemetry__served)',
    )
  })

  it('stacks left chrome and the mini-map above pool flyouts and the compute strip', () => {
    const workspaceStart = css.indexOf('.workspace-shell {')
    const workspaceEnd = workspaceStart < 0 ? -1 : css.indexOf('}', workspaceStart)
    const operationsStart = css.indexOf('.operations-shell {')
    const operationsEnd = operationsStart < 0 ? -1 : css.indexOf('}', operationsStart)
    const navigatorStart = css.indexOf('.map-navigator,\n.map-navigator-launcher {')
    const navigatorEnd = navigatorStart < 0 ? -1 : css.indexOf('}', navigatorStart)

    expect(css.slice(workspaceStart, workspaceEnd + 1)).toContain('z-index: 22')
    expect(css.slice(operationsStart, operationsEnd + 1)).toContain('z-index: 17')
    expect(css.slice(navigatorStart, navigatorEnd + 1)).toContain('z-index: 19')
    expect(css).toContain('--operations-flyout-clearance: calc(var(--workspace-width)')
    expect(css).toContain('clamp(21.5rem, 23vw, 23rem)')
  })
})
