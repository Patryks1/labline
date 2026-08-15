import { describe, expect, it } from 'vitest'
import { BIOME_KIND, TERRAIN_KIND, generateStaticWorldV3, generateStaticWorldV4, generateStaticWorldV5 } from './index'

const OPTIONS = { seed: 0x51ab, width: 160, height: 144, cityCount: 3, waterCoverage: 0.12 }

describe('V5 regional biomes', () => {
  it('is deterministic while retaining frozen V3 and V4 fingerprints', () => {
    const a = generateStaticWorldV5(OPTIONS)
    const b = generateStaticWorldV5(OPTIONS)

    expect(a.biome).toEqual(b.biome)
    expect(a.staticHash).toBe(b.staticHash)
    expect(generateStaticWorldV3({ seed: 417, width: 128, height: 128, cityCount: 3 }).staticHash)
      .toBe('8f6a2ba2')
    expect(generateStaticWorldV4({ seed: 417, width: 128, height: 128, cityCount: 3 }).staticHash)
      .toBe('fac6a2a2')
  })

  it('forms contiguous regions instead of checkerboard threshold noise', () => {
    const world = generateStaticWorldV5(OPTIONS)
    const biomes = world.biome!
    const { width, height } = world.descriptor
    let comparableEdges = 0
    let matchingEdges = 0
    let isolatedLand = 0
    let land = 0

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = y * width + x
        const biome = biomes[id]!
        if (x + 1 < width && biome !== BIOME_KIND.coast && biomes[id + 1] !== BIOME_KIND.coast) {
          comparableEdges++
          if (biome === biomes[id + 1]) matchingEdges++
        }
        if (y + 1 < height && biome !== BIOME_KIND.coast && biomes[id + width] !== BIOME_KIND.coast) {
          comparableEdges++
          if (biome === biomes[id + width]) matchingEdges++
        }
        if (biome === BIOME_KIND.coast) continue
        land++
        let sameNeighbor = false
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if ((ox === 0 && oy === 0) || x + ox < 0 || x + ox >= width || y + oy < 0 || y + oy >= height) continue
            if (biomes[(y + oy) * width + x + ox] === biome) sameNeighbor = true
          }
        }
        if (!sameNeighbor) isolatedLand++
      }
    }

    // Broad warped-Perlin climate fronts should cross far fewer tile edges
    // than the older, more frequent value-noise patches.
    expect(matchingEdges / comparableEdges).toBeGreaterThan(0.945)
    expect(isolatedLand / land).toBeLessThan(0.001)
  })

  it('aligns coast, highland and cold-region labels with geography and keeps settlements buildable', () => {
    const world = generateStaticWorldV5(OPTIONS)
    const { width, height } = world.descriptor
    const biomes = world.biome!
    const elevation = world.elevation!
    const stride = width + 1
    const averageElevation = (id: number) => {
      const x = id % width
      const y = Math.floor(id / width)
      const nw = y * stride + x
      return (elevation[nw]! + elevation[nw + 1]! + elevation[nw + stride]! + elevation[nw + stride + 1]!) * 0.25
    }
    const elevations = (biome: number) => Array.from(biomes.entries())
      .filter(([, value]) => value === biome)
      .map(([id]) => averageElevation(id))
    const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

    const alpine = elevations(BIOME_KIND.alpine)
    const wetland = elevations(BIOME_KIND.wetland)
    const plains = elevations(BIOME_KIND.plains)
    expect(alpine.length).toBeGreaterThan(0)
    expect(wetland.length).toBeGreaterThan(0)
    expect(mean(alpine)).toBeGreaterThan(mean(plains))
    expect(mean(wetland)).toBeLessThan(mean(plains))

    for (let id = 0; id < biomes.length; id++) {
      if (biomes[id] !== BIOME_KIND.coast) continue
      const x = id % width
      const y = Math.floor(id / width)
      const touchesWater = world.kind[id] === TERRAIN_KIND.lake ||
        (x > 0 && world.kind[id - 1] === TERRAIN_KIND.lake) ||
        (x + 1 < width && world.kind[id + 1] === TERRAIN_KIND.lake) ||
        (y > 0 && world.kind[id - width] === TERRAIN_KIND.lake) ||
        (y + 1 < height && world.kind[id + width] === TERRAIN_KIND.lake)
      expect(touchesWater).toBe(true)
    }

    let borealPolar = 0
    let borealTemperate = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (biomes[y * width + x] !== BIOME_KIND.boreal) continue
        if (y < height * 0.25 || y >= height * 0.75) borealPolar++
        else borealTemperate++
      }
    }
    expect(borealPolar).toBeGreaterThan(borealTemperate)

    for (const city of world.cities) {
      const biome = biomes[city.cy * width + city.cx]
      expect(biome).not.toBe(BIOME_KIND.alpine)
      expect(biome).not.toBe(BIOME_KIND.wetland)
    }
  })
})
