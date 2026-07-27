/// <reference types="node" />
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createArtDirectedArchetypeRegistry } from '../integration/artDirectedRegistry'
import { applyWorldAssetSnapshot, WorldAssetCache } from './worldAssetCache'
import { parseWorldAssetManifest } from './worldAssetManifest'

const assetRoot = path.resolve('public')

describe('authored world asset pipeline', () => {
  it('ships a validated vertical slice with every required visual family', async () => {
    const raw = JSON.parse(await readFile(path.join(assetRoot, 'assets/world-v4/manifest.json'), 'utf8'))
    const manifest = parseWorldAssetManifest(raw)
    expect(manifest.bundles).toHaveLength(11)
    expect(manifest.models).toHaveLength(132)
    expect(new Set(manifest.models.map(model => model.family))).toEqual(new Set([
      'terrain', 'vegetation', 'residential', 'urban', 'industrial',
      'facilities', 'vehicles', 'boats', 'ducks', 'props', 'municipal',
    ]))
    expect(manifest.models.filter(model => model.family === 'props').map(model => model.key)).toEqual([
      'road-lamp', 'park-details', 'park-bench', 'traffic-light',
      'pedestrian-signal', 'road-sign', 'street-bollards', 'fire-hydrant',
      'utility-box', 'wood-fence', 'highway-guardrail', 'construction-barrier',
    ])
    for (const model of manifest.models) {
      expect(model.nodes.near).toBe(`${model.key}__near`)
      expect(model.nodes.mid).toBe(`${model.key}__mid`)
      expect(model.nodes.far).toBe(`${model.key}__far`)
    }
  })

  it('deduplicates requests, extracts named LOD geometry, and swaps known archetypes', async () => {
    const requests = new Map<string, number>()
    const fetcher: typeof fetch = async input => {
      const url = String(input)
      requests.set(url, (requests.get(url) ?? 0) + 1)
      const relative = url === '/assets/world-v4/manifest.json'
        ? 'assets/world-v4/manifest.json'
        : url.replace(/^\//, '')
      try {
        const body = await readFile(path.join(assetRoot, relative))
        return new Response(body, { status: 200 })
      } catch {
        return new Response(null, { status: 404 })
      }
    }
    const cache = new WorldAssetCache(fetcher)
    const [a, b] = await Promise.all([cache.loadAll(), cache.loadAll()])

    expect(a.failedFamilies.size).toBe(0)
    expect(a.geometryByArchetype.size).toBe(132)
    expect(b.revision).toBe(11)
    expect([...requests.values()].every(count => count === 1)).toBe(true)
    for (const tiers of a.geometryByArchetype.values()) {
      for (const geometry of Object.values(tiers)) {
        expect(geometry.getAttribute('position').count).toBeGreaterThan(0)
        expect(geometry.getAttribute('normal').count).toBe(geometry.getAttribute('position').count)
        expect(geometry.getAttribute('color').count).toBe(geometry.getAttribute('position').count)
        expect(geometry.getAttribute('ownerMix').count).toBe(geometry.getAttribute('position').count)
        expect(geometry.boundingBox?.min.y).toBeCloseTo(0, 4)
      }
    }
    const manifest = parseWorldAssetManifest(JSON.parse(
      await readFile(path.join(assetRoot, 'assets/world-v4/manifest.json'), 'utf8'),
    ))
    for (const family of new Set(manifest.models.map(model => model.family))) {
      const familyModels = manifest.models.filter(model => model.family === family)
      const authoredShapes = familyModels.map(model => {
        const geometry = a.geometryByArchetype.get(model.archetypeId)!.near
        const positions = geometry.getAttribute('position').array
        let sum = 0
        let weighted = 0
        for (let index = 0; index < positions.length; index++) {
          const value = positions[index]!
          sum += value
          weighted += value * ((index % 97) + 1)
        }
        return `${geometry.getAttribute('position').count}:${sum.toFixed(5)}:${weighted.toFixed(5)}`
      })
      expect(new Set(authoredShapes).size, `${family} authored shapes`).toBe(familyModels.length)
    }

    const registry = createArtDirectedArchetypeRegistry()
    const previous = registry.get(2).geometry.near
    expect(applyWorldAssetSnapshot(registry, a)).toBe(132)
    expect(registry.get(2).geometry.near).not.toBe(previous)
    expect(registry.get(2).geometry.near?.name).toBe('house-single__near')
    registry.dispose()
    // Registry disposal must not invalidate the cache used by a replacement
    // map projection.
    const replacement = createArtDirectedArchetypeRegistry()
    expect(applyWorldAssetSnapshot(replacement, cache.snapshot())).toBe(132)
    expect(replacement.get(2).geometry.near?.getAttribute('position').count).toBeGreaterThan(0)
    replacement.dispose()
    cache.dispose()
  })

  it('streams validated families with bounded publication metadata', async () => {
    const fetcher: typeof fetch = async input => {
      const body = await readFile(path.join(assetRoot, String(input).replace(/^\//, '')))
      return new Response(body, { status: 200 })
    }
    const cache = new WorldAssetCache(fetcher)
    const publications = []
    for await (const publication of cache.streamAll()) publications.push(publication)

    expect(publications).toHaveLength(11)
    expect(publications.map(item => item.snapshot.revision)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1),
    )
    expect(publications.flatMap(item => item.archetypeIds)).toHaveLength(
      publications.at(-1)!.snapshot.geometryByArchetype.size,
    )
    for (const publication of publications) {
      expect(publication.metrics).toMatchObject({
        bytes: expect.any(Number),
        models: publication.archetypeIds.length,
        totalMs: expect.any(Number),
      })
    }
    cache.dispose()
  })

  it('keeps failed optional families observable without rejecting the usable fallback world', async () => {
    const fetcher: typeof fetch = async input => {
      const url = String(input)
      if (url.includes('boats.')) return new Response(null, { status: 503 })
      const body = await readFile(path.join(assetRoot, url.replace(/^\//, '')))
      return new Response(body, { status: 200 })
    }
    const cache = new WorldAssetCache(fetcher)
    const snapshot = await cache.loadLife()
    expect(snapshot.failedFamilies).toEqual(new Set(['boats']))
    expect(snapshot.geometryByArchetype.has(300)).toBe(true)
    expect(snapshot.geometryByArchetype.has(302)).toBe(true)
    expect(snapshot.geometryByArchetype.has(301)).toBe(false)
    cache.dispose()
  })

  it('rejects a corrupted family bundle before parsing geometry', async () => {
    const fetcher: typeof fetch = async input => {
      const url = String(input)
      const body = await readFile(path.join(assetRoot, url.replace(/^\//, '')))
      if (url.includes('urban.')) body[body.length - 1] ^= 0xff
      return new Response(body, { status: 200 })
    }
    const cache = new WorldAssetCache(fetcher)
    const snapshot = await cache.loadCritical()
    expect(snapshot.failedFamilies.has('urban')).toBe(true)
    expect(snapshot.geometryByArchetype.has(3)).toBe(false)
    expect(snapshot.geometryByArchetype.has(5)).toBe(true)
    cache.dispose()
  })
})
