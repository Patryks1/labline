import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  EmptyState,
  HudButton,
  HudInput,
  HudRange,
  HudSelect,
  HudState,
  MetricTile,
  PanelScaffold,
  ProgressBar,
} from './HudPrimitives'
import { BlockerList, GameCard, MeterBar, SegmentedTabs } from './kit'

describe('HUD streamline primitives', () => {
  it('keeps button actions explicit and exposes disabled reasons', () => {
    const markup = renderToStaticMarkup(
      createElement(HudButton, { disabled: true, disabledReason: 'Requires a trained model' }, 'Start'),
    )

    expect(markup).toContain('type="button"')
    expect(markup).toContain('title="Requires a trained model"')
    expect(markup).toContain('disabled=""')
  })

  it('marks irreversible actions with the shared danger semantics', () => {
    const markup = renderToStaticMarkup(
      createElement(HudButton, { variant: 'danger', onClick: vi.fn() }, 'Sell building'),
    )

    expect(markup).toContain('data-hud-variant="danger"')
    expect(markup).toContain('data-destructive="true"')
    expect(markup).toMatch(/class="hud-button hud-button--danger ?"/)
  })

  it('renders ProgressBar and MeterBar through semantic progress output', () => {
    const progress = renderToStaticMarkup(createElement(ProgressBar, { value: 1.4, label: 'Readiness' }))
    const meter = renderToStaticMarkup(
      createElement(MeterBar, { value: 0.42, label: 'Training', detail: '42%', live: true }),
    )

    expect(progress).toContain('role="progressbar"')
    expect(progress).toContain('aria-label="Readiness"')
    expect(progress).toContain('aria-valuemin="0"')
    expect(progress).toContain('aria-valuemax="100"')
    expect(progress).toContain('aria-valuenow="100"')
    expect(meter).toContain('aria-label="Training"')
    expect(meter).toContain('aria-valuenow="42"')
    expect(meter).toContain('meter-live')
  })

  it('links card headings and exposes opt-in interactive selection state', () => {
    const markup = renderToStaticMarkup(
      <GameCard title="Spark-2" interactive selected onActivate={vi.fn()}>
        Training activity
      </GameCard>,
    )

    expect(markup).toMatch(/aria-labelledby="[^"]+"/)
    expect(markup).toMatch(/<h3 id="[^"]+"[^>]*>Spark-2<\/h3>/)
    expect(markup).toContain('role="button"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('data-interactive="true"')
    expect(markup).toContain('data-selected="true"')
    expect(markup).toContain('data-mobile-card="true"')
    expect(markup).toContain('data-mobile-priority="primary"')
  })

  it('keeps single-level tabs keyboard-addressable and optionally linked to panels', () => {
    const markup = renderToStaticMarkup(
      createElement(SegmentedTabs, {
        ariaLabel: 'Model views',
        active: 'activity',
        idPrefix: 'model-tabs',
        items: [
          { id: 'activity', label: 'Activity', panelId: 'activity-panel' },
          { id: 'history', label: 'History' },
          { id: 'fleet', label: 'Fleet', disabled: true },
        ],
        onChange: vi.fn(),
      }),
    )

    expect(markup).toContain('role="tablist"')
    expect(markup).toContain('aria-label="Model views"')
    expect(markup).toContain('aria-controls="activity-panel"')
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('tabindex="-1"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('aria-orientation="horizontal"')
    expect(markup).toContain('class="seg-tabs hud-tab-row"')
    expect(markup).toContain('data-mobile-scroll="true"')
    expect(markup).toContain('data-swipe-ignore="true"')
  })

  it('exposes concise mobile copy without replacing desktop detail semantics', () => {
    const markup = renderToStaticMarkup(
      createElement(
        'div',
        null,
        <PanelScaffold
          title="Models"
          description="A longer desktop explanation of the model workspace."
          mobileDescription="Train and ship models."
        >
          <span>Workspace</span>
        </PanelScaffold>,
        createElement(MetricTile, {
          label: 'Revenue',
          value: '$2.4m',
          detail: 'Trailing seven-day token revenue',
          mobileSummary: '7-day tokens',
          mobilePriority: 'secondary',
        }),
        createElement(EmptyState, {
          title: 'No jobs',
          description: 'Start training to create the first checkpoint in this lab.',
          mobileDescription: 'Start a training job.',
        }),
      ),
    )

    expect(markup).toContain('hud-section__header hud-section-header')
    expect(markup).toContain('data-mobile-section="true"')
    expect(markup).toContain('hud-description hud-mobile-detail')
    expect(markup).toContain('hud-description hud-mobile-summary')
    expect(markup).toContain('data-mobile-priority="secondary"')
    expect((markup.match(/hud-mobile-summary/g) ?? []).length).toBe(3)
  })

  it('announces dynamic blockers only when live mode is requested', () => {
    const quiet = renderToStaticMarkup(createElement(BlockerList, { items: [{ text: 'Needs more cash' }] }))
    const live = renderToStaticMarkup(
      createElement(BlockerList, { items: [{ text: 'Needs more cash' }], live: true }),
    )

    expect(quiet).not.toContain('aria-live=')
    expect(live).toContain('role="status"')
    expect(live).toContain('aria-live="polite"')
    expect(live).toContain('aria-atomic="true"')
  })

  it('provides additive shared form and state primitives', () => {
    const markup = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(HudInput, { invalid: true, placeholder: 'Model name' }),
        createElement(HudSelect, { 'aria-label': 'Mode' }, createElement('option', null, 'Train')),
        createElement(HudRange, { 'aria-label': 'Allocation', min: 0, max: 100, value: 40, readOnly: true }),
        createElement(HudState, { kind: 'error', title: 'Unavailable', description: 'Try again later.' }),
      ),
    )

    expect(markup).toMatch(/class="hud-input ?"/)
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toMatch(/class="hud-select ?"/)
    expect(markup).toMatch(/class="hud-range ?"/)
    expect(markup).toContain('type="range"')
    expect(markup).toContain('class="hud-state hud-state--error"')
    expect(markup).toContain('role="alert"')
  })
})
