import { describe, expect, it } from 'vitest'
import { MODULE_CATALOG } from './racks'
import { getRackSku } from './rackSkus'

describe('authoritative accelerator profiles', () => {
  it('keeps H100 and H200 compute equal while H200 adds HBM and bandwidth', () => {
    const h100 = getRackSku('rack_h100')
    const h200 = getRackSku('rack_h200')

    expect(h100.flopsPf).toBeCloseTo(7.912, 12)
    expect(h200.flopsPf).toBeCloseTo(h100.flopsPf, 12)
    expect(h100.accelerator?.fp16Bf16TfPerDevice).toBe(989)
    expect(h200.accelerator?.fp16Bf16TfPerDevice).toBe(989)
    expect(h200.vramGb).toBe(1_128)
    expect(h200.vramGb).toBeGreaterThan(h100.vramGb)
    expect(h200.accelerator!.hbmBandwidthTbPerSecPerDevice)
      .toBeGreaterThan(h100.accelerator!.hbmBandwidthTbPerSecPerDevice)
    expect(h100.mw).toBeCloseTo(0.0102, 12)
    expect(h200.mw).toBeCloseTo(0.0102, 12)
  })

  it('matches the B200 system memory and power envelope', () => {
    const b200 = getRackSku('rack_b200')

    expect(b200.accelerator?.deviceCount).toBe(8)
    expect(b200.accelerator?.hbmGbPerDevice).toBe(180)
    expect(b200.vramGb).toBe(1_440)
    expect(b200.systemRamGb).toBe(2_048)
    expect(b200.flopsPf).toBeCloseTo(18, 12)
    expect(b200.mw).toBeCloseTo(0.0143, 12)
  })

  it('keeps custom modules aligned with complete-system device throughput', () => {
    const h100 = MODULE_CATALOG.find((module) => module.id === 'gpu_h100')!
    const h200 = MODULE_CATALOG.find((module) => module.id === 'gpu_h200')!
    const b200 = MODULE_CATALOG.find((module) => module.id === 'gpu_b200')!

    expect(h100.flopsPf).toBeCloseTo(0.989, 12)
    expect(h200.flopsPf).toBeCloseTo(h100.flopsPf!, 12)
    expect(b200.flopsPf).toBeCloseTo(2.25, 12)
    expect(b200.vramGb).toBe(180)
  })

  it('does not disguise host/CXL trays as accelerator HBM', () => {
    for (const id of ['ram_64', 'ram_128', 'ram_256']) {
      const module = MODULE_CATALOG.find((candidate) => candidate.id === id)!
      expect(module.vramGb).toBeUndefined()
      expect(module.systemRamGb).toBeGreaterThan(0)
    }
  })
})
