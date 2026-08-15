import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  hasHardTrainingStartNotice,
  trainingDataGuidanceText,
  trainingStartFailureMessage,
} from './trainingStartUi'
import { TrainingStartFailureBanner } from './TrainingStartFailureBanner'

describe('training start UI feedback', () => {
  it('distinguishes a met raw target from reduced effective training signal', () => {
    expect(
      trainingDataGuidanceText({
        selectedMTok: 21_430,
        rawStrongTargetMTok: 19_920,
        rawStrongTargetMet: true,
        effectiveDataRatio: 4.91,
        qualityRetention: 0.8,
        diversityRetention: 0.95,
        holdoutRetention: 0.8,
      }),
    ).toEqual({
      headline: 'Raw strong target met · 21.43B / 19.92B · effective 4.91:1',
      reductions: 'Quality ×0.80 · diversity ×0.95 · verification holdout 20% (×0.80)',
    })
  })

  it('never treats advisory-only findings as a hard launch blocker', () => {
    expect(
      hasHardTrainingStartNotice([
        { tone: 'warning' },
        { tone: 'warning' },
      ]),
    ).toBe(false)
    expect(hasHardTrainingStartNotice([{ tone: 'danger' }])).toBe(true)
  })

  it('renders the authoritative backend rejection on the same screen', () => {
    const failure = trainingStartFailureMessage({
      beforeJobIds: [],
      beforeAlertId: 'older-alert',
      jobs: [],
      latestAlert: {
        id: 'new-alert',
        message: 'Host RAM placement cannot fit this training run.',
      },
    })
    const markup = renderToStaticMarkup(
      createElement(TrainingStartFailureBanner, { message: failure }),
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Training did not start')
    expect(markup).toContain('Host RAM placement cannot fit this training run.')
  })

  it('returns no failure when a new run was created', () => {
    expect(
      trainingStartFailureMessage({
        beforeJobIds: ['old'],
        jobs: [{ id: 'old' }, { id: 'new' }],
        latestAlert: { id: 'started', message: 'Training started.' },
      }),
    ).toBeNull()
  })

  it('keeps a repeated backend rejection visible when its deterministic id repeats', () => {
    expect(
      trainingStartFailureMessage({
        beforeJobIds: [],
        beforeAlertId: 'same-id',
        alertChanged: true,
        jobs: [],
        latestAlert: {
          id: 'same-id',
          message: 'Active params cannot exceed total MoE size.',
        },
      }),
    ).toBe('Active params cannot exceed total MoE size.')
  })
})
