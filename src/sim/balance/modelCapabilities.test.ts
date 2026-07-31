import { describe, expect, it } from 'vitest'
import type { ModelCapabilityInputs } from './modelCapabilities'
import {
  CAPABILITY_DOMAINS,
  deriveModelCapabilities,
  estimateSyntheticQuality,
} from './modelCapabilities'
import { scaleIntelligence } from './modelScaling'

const base: ModelCapabilityInputs = {
  finalCapability: 60,
  trainComputePfDays: 80,
  effectiveDataRatio: 6,
  dataQuality: 75,
  domainWeights: { chat: 0.45, code: 0.2, math: 0.1, science: 0.1, image: 0.05, audio: 0.05, video: 0.05 },
  io: { inputs: { text: 60 }, outputs: { text: 60 }, tools: 0 },
  family: 'dense',
  postTrain: 'rlhf',
  quality: { reasoning: 65, coding: 64, chat: 70, image: 30, video: 20, safety: 72, reliability: 68 },
}

describe('domain-first model capabilities', () => {
  it('is deterministic, complete, finite, and bounded', () => {
    const a = deriveModelCapabilities(base)
    expect(a).toEqual(deriveModelCapabilities(base))
    expect(Object.keys(a.domains).sort()).toEqual([...CAPABILITY_DOMAINS].sort())
    for (const score of [...Object.values(a.domains), a.factuality, a.steerability, a.robustness, a.safety, a.reliability]) {
      expect(Number.isFinite(score)).toBe(true)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    }
  })

  it('responds independently to first-class math and science data', () => {
    const math = deriveModelCapabilities({ ...base, domainWeights: { math: 1 } })
    const science = deriveModelCapabilities({ ...base, domainWeights: { science: 1 } })
    const healthCode = deriveModelCapabilities({ ...base, domainWeights: { health: 0.5, code: 0.5 } })
    expect(math.domains.math).toBeGreaterThan(science.domains.math)
    expect(science.domains.science).toBeGreaterThan(math.domains.science)
    expect(math.domains.math).toBeGreaterThan(healthCode.domains.math)
  })

  it('boosts the dominant skill while narrowing unrelated capability', () => {
    const multimodal = { ...base, io: { ...base.io, inputs: { ...base.io.inputs, image: 60 } } }
    const scaleBase = { paramsB: 20, dataCoverage: 6, dataQuality: 1 }
    const broadWeights = multimodal.domainWeights
    const narrowWeights = { math: 0.92, code: 0.08 }
    const broad = deriveModelCapabilities({
      ...multimodal,
      finalCapability: scaleIntelligence({ ...scaleBase, mixWeights: broadWeights }).capability,
    })
    const narrow = deriveModelCapabilities({
      ...multimodal,
      finalCapability: scaleIntelligence({ ...scaleBase, mixWeights: narrowWeights }).capability,
      domainWeights: narrowWeights,
    })

    expect(narrow.domains.math).toBeGreaterThan(broad.domains.math)
    expect(narrow.domains.language).toBeLessThan(broad.domains.language)
    expect(narrow.domains.vision).toBeLessThan(broad.domains.vision)
  })

  it('improves with compute and data but saturates', () => {
    const low = deriveModelCapabilities({ ...base, trainComputePfDays: 5, effectiveDataRatio: 1 })
    const high = deriveModelCapabilities({ ...base, trainComputePfDays: 100, effectiveDataRatio: 8 })
    const extreme = deriveModelCapabilities({ ...base, trainComputePfDays: 10_000, effectiveDataRatio: 80 })
    expect(high.domains.reasoning).toBeGreaterThan(low.domains.reasoning)
    expect(extreme.domains.reasoning - high.domains.reasoning).toBeLessThan(high.domains.reasoning - low.domains.reasoning)
  })

  it('gates unsupported modalities and tools', () => {
    const result = deriveModelCapabilities(base)
    expect(result.domains.vision).toBeLessThanOrEqual(12)
    expect(result.domains.video).toBeLessThanOrEqual(8)
    expect(result.domains.audio).toBeLessThanOrEqual(10)
    expect(result.domains.tools).toBeLessThanOrEqual(15)
  })
})

describe('synthetic data quality', () => {
  const provenance = {
    teacherModelIds: ['teacher'],
    generationDepth: 1,
    promptDiversity: 1,
    verifierStrength: 0,
    candidatesPerAccepted: 1,
    humanAnchorShare: 0,
  }

  it('keeps unverified imitation below its teacher', () => {
    expect(estimateSyntheticQuality({ domain: 'chat', teacherDomainCapability: 70, provenance }).quality).toBeLessThanOrEqual(70)
  })

  it('allows verifier-backed math/code—but not science—to exceed the teacher', () => {
    const verified = { ...provenance, verifierStrength: 1, candidatesPerAccepted: 16, humanAnchorShare: 0.5 }
    expect(estimateSyntheticQuality({ domain: 'math', teacherDomainCapability: 70, provenance: verified }).quality).toBeGreaterThan(70)
    expect(estimateSyntheticQuality({ domain: 'code', teacherDomainCapability: 70, provenance: verified }).quality).toBeGreaterThan(70)
    expect(estimateSyntheticQuality({ domain: 'science', teacherDomainCapability: 70, provenance: verified }).quality).toBeLessThanOrEqual(70)
  })

  it('penalizes recursive lineages while anchors reduce the loss', () => {
    const deep = estimateSyntheticQuality({ domain: 'chat', teacherDomainCapability: 80, provenance: { ...provenance, generationDepth: 5, promptDiversity: 0.5 } })
    const anchored = estimateSyntheticQuality({ domain: 'chat', teacherDomainCapability: 80, provenance: { ...provenance, generationDepth: 5, promptDiversity: 0.5, humanAnchorShare: 0.8 } })
    expect(deep.quality).toBeLessThan(anchored.quality)
    expect(deep.lineagePenalty).toBeGreaterThan(anchored.lineagePenalty)
  })
})
