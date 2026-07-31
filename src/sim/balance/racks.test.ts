import { describe, expect, it } from 'vitest'
import { modelVramGb, servePrecisionBytes } from './racks'

describe('serving model VRAM', () => {
  it('keeps total MoE parameters resident for normal low-latency serving', () => {
    const moe = modelVramGb(70, 8, 'moe', 'fp16')
    const sameShapeDense = modelVramGb(70, 8, 'dense', 'fp16')
    const activeOnlyDense = modelVramGb(8, 8, 'dense', 'fp16')

    expect(moe).toBeCloseTo(sameShapeDense, 12)
    expect(moe).toBeGreaterThan(activeOnlyDense * 4)
  })

  it('uses physical bytes per weight for standard serving precisions', () => {
    expect(servePrecisionBytes('fp16')).toBe(2)
    expect(servePrecisionBytes('bf16')).toBe(2)
    expect(servePrecisionBytes('fp8')).toBe(1)
    expect(servePrecisionBytes('int8')).toBe(1)
    expect(servePrecisionBytes('int4')).toBe(0.5)
    expect(servePrecisionBytes('nvfp4')).toBe(0.5)

    const fp16 = modelVramGb(70, 8, 'moe', 'fp16')
    const int8 = modelVramGb(70, 8, 'moe', 'int8')
    const int4 = modelVramGb(70, 8, 'moe', 'int4')
    expect(fp16).toBeGreaterThan(int8)
    expect(int8).toBeGreaterThan(int4)
  })
})
