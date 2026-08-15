# Labline map building kits

**Runtime:** authored GLBs in `../world-v4/` are the production-facing asset
path. The procedural multi-mesh kits in `src/view/three/buildingKits.ts` remain
available while assets stream or if a bundle fails.

The authored pack contains 128 stable, visibly distinct taxonomy entries and
named near, mid, and far nodes across ten hashed family bundles. Rebuild its deterministic
artifacts with `npm run assets:world`; the source exporter is
`scripts/generate-world-models.mjs`.

| Kind | Model highlights |
|------|------------------|
| `dc` | Hall, roof chillers, cooling stacks, dock, fence, generator |
| `lake` | Deep animated water, soft shores, reeds, rocks, shader-drifting ducks and boats |
| `forest` | Pine, conifer, aspen, oak, scrub, deadwood and rocky-grove biome clusters |
| Ground detail | Sparse hill mounds, scrub, rock outcrops, fallen logs, dirt and relief shading |
| `house` | Detached, courtyard, garden, townhome, stilt, row and corner-home families |
| `road` | Curved/diagonal local roads, collectors, arterials, highways, ramps and bridge markings |
| `park` | Path, bench, shade trees, fountain, flowers, picnic table |
| `warehouse` | Standard, sawtooth, cold-store, depot, silo and freight-yard families |
| `city` | Towers plus podium, arcade, civic hall, library, market, hotel and transit-hub families |
| Power / fab | Substation poles, solar arrays, tanks, SMR towers, cleanroom |

Do not add loose glTF files here. Add source models to the exporter and rebuild
the manifest so node names, hashes, pivots, and LODs remain validated.
