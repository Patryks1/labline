# Large-map architecture (1,000 x 1,000 tiles)

## Outcome and constraints

The map is a one-million-cell simulation, but it is not a one-million-object Three.js scene. The simulation owns the complete world and advances it independent of the camera. The renderer owns only a read-only, disposable projection of the current viewport.

Target envelope:

- 1,000 x 1,000 tiles, including large cities and contiguous lakes.
- 60 FPS at 1,440 x 900 and device-pixel-ratio 1 on Apple M1 / Intel Iris Xe-class hardware.
- No missing surface cells, instance-capacity rejects, or low-detail placeholders at close zoom.
- Offscreen player and rival facilities, construction, expansion, and city growth continue to simulate.
- Player and rivals use the same `Facility`, occupancy, mutation, indexing, and economic formula paths.
- Existing small maps remain available; large maps are exposed through advanced new-game controls.
- Save format v2 starts new campaigns only. V1 saves are rejected rather than migrated.

## Patterns adopted from large tile/management engines

Large simulation games and tile engines consistently separate world truth from its visual cache. The implementation follows the same practical patterns:

1. **Chunk spatial work, not simulation truth.** A 32 x 32 chunk is the unit for visibility, prefetch, instance rebuilding, and eviction. It is not a gameplay boundary.
2. **Store dense static fields numerically.** Coordinates are implicit (`tileId = y * width + x`); terrain, region, feature, and variant data live in typed arrays instead of one JavaScript object per tile.
3. **Store dynamic state sparsely.** Facilities, ownership changes, terrain overrides, and city growth deltas are indexed records. Generated terrain is recreated from a versioned descriptor and seed.
4. **Draw the ground as a field.** A two-triangle plane samples one RGBA8 state texel per logical cell. Roads, shores, water, palette variation, ownership, selection, and grid edges are shader-derived.
5. **Batch repeated props.** Trees, houses, city towers, warehouses, and facilities use chunk-local `InstancedMesh` batches grouped by archetype and LOD.
6. **Cull hierarchically.** Only visible chunks have GPU instance batches. A one-chunk prefetch ring prepares likely camera destinations, while an LRU cap bounds retained CPU chunk data.
7. **Use screen-space LOD with hysteresis.** Orthographic zoom selects a global visible tier, avoiding radial seams. Enter/leave thresholds differ, and a tier cannot become active until all visible chunks are ready.
8. **Use opaque transitions.** Complementary screen-door dithering crossfades LODs without transparent sorting. At close zoom, stale mid/far geometry is hidden until near geometry is ready.
9. **Process changes, not the world.** Atomic simulation batches append tile/chunk/facility IDs to a bounded journal. The renderer patches affected texture rows and rebuilds only affected visible chunks.
10. **Schedule by need.** Camera interaction and visual transitions run at 60 FPS; animated idle water can run at 30 FPS; a fully static paused view does not need unrelated React renders to rebuild the scene.

The closest engine precedents reinforce these choices. Unity's [Tilemap Renderer](https://docs.unity3d.com/Manual/tilemaps/work-with-tilemaps/tilemap-renderer-reference.html) uses chunk mode to batch tiles and exposes chunk culling bounds. Godot's [MultiMesh guidance](https://docs.godotengine.org/en/stable/tutorials/performance/using_multimesh.html) batches thousands of repeated meshes but warns that one large aggregate is culled as one object; splitting batches spatially avoids rendering distant instances. Unity's [BatchRendererGroup](https://docs.unity3d.com/Manual/batch-renderer-group.html) similarly makes culling and draw-command generation explicit. The Three.js implementation applies those ideas with chunk-local `InstancedMesh` objects rather than one world-sized instance pool.

## World model

### Static layers

Generator v2 uses five bytes per tile. Generator v3 adds an independent packed
transport overlay and uses seven bytes per tile:

| Layer | Type | Bytes/tile | Purpose |
| --- | --- | ---: | --- |
| `kind` | `Uint8Array` | 1 | Terrain/surface category |
| `region` | `Uint8Array` | 1 | Region/palette/economy index |
| `feature` | `Uint16Array` | 2 | City/lake feature identity |
| `variantMask` | `Uint8Array` | 1 | Deterministic variant plus NESW connectivity |
| `transport` (v3) | `Uint16Array` | 2 | Explicit eight-way road topology, class, and bridge/regional flags |

A 1,000 x 1,000 v3 base layer is therefore 7,000,000 bytes, excluding small descriptor/settlement/region metadata. V2 worlds remain 5,000,000 bytes and hash-identical. No `MapTile[1_000_000]` is created.

### Dynamic layers

- `Map<TileId, TerrainOverride>` for changed generated terrain.
- `Map<string, Facility>` for every player and rival facility.
- `Map<TileId, facilityId>` for O(1) occupancy.
- Secondary indexes by owner, kind, region, and chunk.
- Cached aggregates for facility counts, power, racks, capex, and opex.
- Per-city runtime population/growth state.
- A bounded 4,096-entry change journal.

All writes happen through an atomic `WorldMutationBatch`. Collision validation completes before a batch changes indexes. Player and rival ownership is data on the same facility type; there is no rival-only renderer or placement store.

### Deterministic city growth

V2 worlds retain their seven-day deterministic frontier updates. V3 evaluates
growth monthly and applies tiered, staggered projects: metros and satellites
quarterly, towns twice yearly, and villages yearly. Each project is capped at
24 cells, extends connected transport before claiming road-served parcels,
supports infill/upzoning, refuses protected land, and commits atomically. The
algorithm never reads camera visibility.

## Renderer pipeline

```text
DynamicWorld change batch
        |
        v
bounded journal -----> dirty tile IDs ------> RGBA8 row update ranges
        |                                      |
        +------------> dirty chunk IDs         v
                             |             two-triangle ground shader
                             v
camera bounds -> visible 32x32 chunks -> per-archetype InstancedMesh batches
                             |
                             +-> one-ring prefetch / bounded LRU retention
```

### Surface

The base surface is four vertices and two triangles. A nearest-filtered, non-mipmapped RGBA8 `DataTexture` contains one categorical texel per tile:

- R: surface kind, plus a v3 transport-mode marker
- G: cardinal surface mask or explicit eight-way transport topology
- B: region/palette or v3 road class/flags
- A: player/rival ownership, selected, construction, buildable, powered flags

Categorical texture values use `texelFetch`; procedural edges use `fwidth` for pixel-stable antialiasing. This avoids texture-atlas gutters and a mesh/draw call per tile. Changed cells are coalesced into contiguous ranges per row.

The same shader supplies continuous eight-way road distance fields, animated
lake ripples and soft shores, low-frequency hill lighting, contours, and sparse
soil variation while leaving the physical picking plane flat. Visible lake
chunks add bounded, static-buffer instances for ducks and boats; motion stays
shader-side and does not write instance buffers per frame.

### Props and facilities

- Registry-owned archetype geometry/materials are shared across all chunks.
- Each visible chunk builds exact-capacity instance arrays; no global fixed pool can silently overflow.
- Instance matrices/colors are uploaded once with static usage unless their chunk revision changes.
- Bounds encompass transformed instances so Three.js frustum culling cannot clip tall props.
- Far tiers omit minor vegetation/houses; important facilities remain represented at every tier.
- Shadows are disabled for bulk map props; lighting/material complexity is tiered.

### LOD policy

| Transition | Threshold (pixels/tile) |
| --- | ---: |
| Enter near | 28 |
| Leave near | 24 |
| Enter far | 12 |
| Leave far | 14 |

The asymmetric thresholds prevent zoom oscillation. During a 200 ms dither transition both tiers may exist briefly. Readiness gates prevent a half-populated tier from replacing a complete one. At unequivocal close-up, a non-near prop layer is never left visible as a placeholder.

### Three.js API choices

The design intentionally follows current Three.js APIs:

- [`InstancedMesh`](https://threejs.org/docs/#api/en/objects/InstancedMesh) reduces draw calls for repeated geometry; instance matrices/colors are marked for upload after batch population, and instance bounds are maintained for culling.
- [`Texture.addUpdateRange`](https://threejs.org/docs/#api/en/textures/Texture.addUpdateRange) / texture updates limit dynamic surface traffic to changed spans.
- [`WebGLRenderer.compileAsync`](https://threejs.org/docs/#api/en/renderers/WebGLRenderer.compileAsync) warms the finite shader/material set before first interaction.
- [`WebGLRenderer.info`](https://threejs.org/docs/#api/en/renderers/WebGLRenderer.info) supplies draw-call, triangle, geometry, texture, and program evidence for regression gates.
- [`BufferAttribute.setUsage`](https://threejs.org/docs/#api/en/core/BufferAttribute.setUsage) distinguishes static chunk buffers from genuinely dynamic data.

## Simulation integration rules

These are correctness requirements, not optional optimizations:

- The tick loop, rival expansion, construction, power, racks, compute, market, research, and victory systems may query indexed facilities or materialize individual compatibility tiles; they must not scan or clone an absent million-entry tile array.
- Player and rivals retain the existing shared compute/economy formulas.
- Rival expansion and player construction commit through the same world mutation/index layer.
- Rendering code receives a read-only `ViewportRenderSource`; it cannot advance or mutate simulation state.
- Camera position, visible bounds, loaded chunks, and render LOD never affect simulation decisions or RNG.
- Re-entering an area must derive visuals from current world state/revision, not from an old retained scene object.

## Save/load plan

Save format v2 stores simulation truth, not caches:

- Versioned generation descriptor and seed.
- Ordinary compact simulation state.
- Facilities for all owners.
- Sparse terrain overrides.
- City runtime state.

It does not store generated typed layers, derived indexes, occupancy maps, journals, chunk caches, instance buffers, textures, or LOD state. Load regenerates the immutable world, verifies its static hash, restores sparse dynamics, and rebuilds indexes. Large payloads use asynchronous IndexedDB slots. Autosave is debounced to at most once per five real seconds, forced after five unsaved game days, and flushed on manual save, pause, and visibility loss.

## Performance budgets and evidence

The deterministic structural budgets are:

| Metric | Near | Mid | Far |
| --- | ---: | ---: | ---: |
| Maximum draw calls | 250 | 180 | 100 |
| Maximum triangles | 1,500,000 | 900,000 | 400,000 |

Global gates:

- Idle p95 <= 16.7 ms; interaction p95 <= 20 ms; overall p99 <= 33.3 ms.
- Frames above 33.3 ms <= 1% of a deterministic camera replay.
- Chunk preparation/rebuild work <= 2 ms per measured frame.
- Retained CPU chunks <= 96.
- Missing tiles, instance-capacity rejects, and close-up LOD placeholders: zero.
- A v3 1,000 x 1,000 world has a seven-byte-per-cell base; preserved v2 worlds remain five bytes per cell. Neither path creates a million-object allocation.

Tests cover a 64-square baseline, dense 256-square metro, contiguous 256-square lake, mixed 1,000-square world, developed 1,000-square world with 10,000 facilities, and deterministic camera pan/zoom/teleport/idle replays. Shared-simulation differential tests compare player/rival calculations and prove rival expansion is deterministic, visibility-independent, and unable to overwrite player sites.

## Delivery phases

1. **Foundation:** compact typed world, sparse dynamics, atomic mutations, indexes, journal, deterministic generator/growth.
2. **Simulation migration:** replace dense scans/clones in production tick and player/rival facility paths while retaining legacy small-map compatibility.
3. **Renderer:** procedural surface, chunk manager, exact-capacity instancing, screen-space LOD/readiness/dither, metrics.
4. **Production adapter:** connect Zustand/world journal to an imperative map lifecycle; retain picking, selection, previews, labels, pan, and zoom.
5. **Persistence/UI:** async v2 save/load, loading progress, autosave policy, advanced dimensions/city controls, clean v1 rejection.
6. **Verification:** typecheck, lint, full and heavy tests, production build, 1,000-square timing/memory capture, deterministic camera replay, and live browser interaction/console/visual QA.
