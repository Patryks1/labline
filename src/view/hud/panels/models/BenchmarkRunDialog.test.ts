import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TrainingJob } from '../../../../sim/types'
import { BenchmarkRunDialog } from './BenchmarkRunDialog'

describe('BenchmarkRunDialog', () => {
  it('renders an accessible, product-tailored multi-select order', () => {
    const imageJob = {
      id: 'image-job',
      name: 'Canvas v2',
      family: 'diffusion',
      productPreset: 'image_generation',
      io: { inputs: { text: 60 }, outputs: { image: 60 }, tools: 0 },
    } as TrainingJob
    const markup = renderToStaticMarkup(createElement(BenchmarkRunDialog, {
      open: true,
      job: imageJob,
      cash: 500_000,
      onClose: vi.fn(),
      onSubmit: vi.fn(),
    }))

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('Image generation')
    expect(markup).not.toContain('Language &amp; reasoning')
    expect(markup).toContain('Benchmark spend per suite')
    expect(markup).toContain('class="hud-range mt-2')
    expect(markup).toContain('Est. accuracy')
  })

  it('disables submission when the live total exceeds cash', () => {
    const languageJob = {
      id: 'language-job',
      name: 'Quill',
      family: 'dense',
      productPreset: 'language',
      io: { inputs: { text: 50 }, outputs: { text: 50 }, tools: 20 },
    } as TrainingJob
    const markup = renderToStaticMarkup(createElement(BenchmarkRunDialog, {
      open: true,
      job: languageJob,
      cash: 40_000,
      onClose: vi.fn(),
      onSubmit: vi.fn(),
    }))

    expect(markup).toContain('Insufficient cash')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Run 1 suite/)
  })
})
