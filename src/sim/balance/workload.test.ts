import { describe, expect, it } from 'vitest'
import {
  addNativeWorkUnits,
  computeWorkKindForProduct,
  nativeWorkFromEquivalentMTok,
  nativeWorkIsBounded,
  scaleNativeWorkUnits,
} from './workload'

describe('canonical native workloads', () => {
  it('keeps text, hidden reasoning, and tool work explicit', () => {
    const reasoning = nativeWorkFromEquivalentMTok('reasoning', 10)
    expect(reasoning.inputMTok).toBeCloseTo(6.5)
    expect(reasoning.outputMTok).toBeCloseTo(1.2)
    expect(reasoning.reasoningMTok).toBeCloseTo(2.3)

    const coding = nativeWorkFromEquivalentMTok('coding', 1)
    expect(coding.toolCalls).toBeCloseTo(50)
    expect((coding.inputMTok ?? 0) + (coding.outputMTok ?? 0)).toBeCloseTo(1)

    const omni = nativeWorkFromEquivalentMTok('omni', 10)
    expect(
      (omni.inputMTok ?? 0) +
        (omni.outputMTok ?? 0) +
        (omni.reasoningMTok ?? 0),
    ).toBeCloseTo(10)
    expect(omni.outputMTok).toBeCloseTo(4.725)
    expect(omni.outputMTok ?? 0).toBeGreaterThan(reasoning.outputMTok ?? 0)
  })

  it('never reports generated media as text tokens', () => {
    const image = nativeWorkFromEquivalentMTok('image', 0.004)
    expect(image).toEqual({ images: 1, megapixelSteps: 30 })
    expect(image.inputMTok).toBeUndefined()

    const video = nativeWorkFromEquivalentMTok('video', 0.024)
    expect(video).toEqual({ videoSeconds: 8 })
    expect(video.outputMTok).toBeUndefined()

    const audio = nativeWorkFromEquivalentMTok('audio', 0.003)
    expect(audio).toEqual({ audioSeconds: 30 })
  })

  it('scales and conserves every dimension independently', () => {
    const requested = nativeWorkFromEquivalentMTok('omni', 12)
    const admitted = scaleNativeWorkUnits(requested, 0.7)
    const served = scaleNativeWorkUnits(admitted, 0.9)
    expect(nativeWorkIsBounded(admitted, requested)).toBe(true)
    expect(nativeWorkIsBounded(served, admitted)).toBe(true)
    expect(nativeWorkIsBounded(requested, served)).toBe(false)
    expect(addNativeWorkUnits(served, scaleNativeWorkUnits(served, 1))).toEqual(
      scaleNativeWorkUnits(served, 2),
    )
  })

  it('maps native products without losing their channel-independent kind', () => {
    expect(computeWorkKindForProduct('api', 'image')).toBe('image_generation')
    expect(computeWorkKindForProduct('subscription', 'video')).toBe(
      'video_generation',
    )
    expect(computeWorkKindForProduct('api', 'coding')).toBe('api_text')
    expect(computeWorkKindForProduct('subscription', 'omni')).toBe(
      'subscription_text',
    )
  })
})
