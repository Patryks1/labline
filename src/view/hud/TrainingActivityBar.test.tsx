import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  desktopTrainingActivityRect,
  modelsRunTargetForActivityAction,
  mobileTrainingActivityRect,
  shouldSuppressTrainingSummary,
  TrainingActivityBar,
} from './TrainingActivityBar'
import type { TrainingActivityAction } from './trainingJobViewModel'

describe('TrainingActivityBar', () => {
  it('keeps a live, navigable activity surface mounted when the queue is empty', () => {
    const markup = renderToStaticMarkup(createElement(TrainingActivityBar))

    expect(markup).toContain('aria-label="Training activity"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('data-job-count="0"')
    expect(markup).toContain('>Idle</span>')
    expect(markup).not.toContain('Training idle')
    expect(markup).toContain('>Models</button>')
    expect(markup).toContain('data-open-models="true"')
    expect(markup).toContain('data-mobile-summary="training"')
    expect(markup).not.toContain('training-activity-bar__surface hud-surface pointer-events-auto')
  })

  it('keeps the mobile strip inside the viewport above the bottom nav', () => {
    const rect = mobileTrainingActivityRect({
      viewportWidth: 390,
      viewportHeight: 844,
      mobileNavHeight: 64,
      stripHeight: 63,
    })

    expect(rect).toEqual({ left: 0, right: 390, top: 717, bottom: 780, width: 390, height: 63 })
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.right).toBeLessThanOrEqual(390)
    expect(rect.bottom).toBe(844 - 64)
  })

  it('spans the desktop operational shell between rail and intel', () => {
    const rect = desktopTrainingActivityRect({
      viewportWidth: 1440,
      railWidth: 200,
      intelWidth: 300,
    })

    expect(rect.left).toBe(200)
    expect(rect.right).toBe(1140)
    expect(rect.width).toBe(940)
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.right).toBeLessThanOrEqual(1440)
  })

  it('spans only the map column between workspace and intel on wide desktops', () => {
    const rect = desktopTrainingActivityRect({
      viewportWidth: 1920,
      railWidth: 200,
      workspaceWidth: 1134,
      intelWidth: 48,
    })

    expect(rect.left).toBe(1334)
    expect(rect.right).toBe(1872)
    expect(rect.width).toBe(538)
    expect(rect.width).not.toBe(1672)
    expect(rect.left).toBeGreaterThanOrEqual(200 + 1134)
    expect(rect.right).toBeLessThanOrEqual(1920 - 48)
  })

  it('suppresses only the duplicate summary while the Models workspace is open', () => {
    expect(shouldSuppressTrainingSummary(true, 'models')).toBe(true)
    expect(shouldSuppressTrainingSummary(false, 'models')).toBe(false)
    expect(shouldSuppressTrainingSummary(true, 'plans')).toBe(false)
  })

  it('keeps every navigational action targeted to its exact concurrent run', () => {
    const actions: TrainingActivityAction[] = [
      { kind: 'open-run', label: 'View run', jobId: 'run-view' },
      { kind: 'open-run', label: 'Review run', jobId: 'run-review' },
      { kind: 'decide', label: 'Decide', jobId: 'run-decision' },
      { kind: 'resume', label: 'Resume', jobId: 'run-paused' },
      {
        kind: 'recover',
        label: 'Recover',
        jobId: 'run-failed',
        checkpointId: 'checkpoint-failed',
      },
    ]

    expect(actions.map(modelsRunTargetForActivityAction)).toEqual([
      'run-view',
      'run-review',
      null,
      null,
      null,
    ])
  })
})
