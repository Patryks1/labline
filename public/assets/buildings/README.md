# Labline map building kits

**Runtime:** all map buildings are **procedural multi-mesh 3D kits** in
`src/view/three/buildingKits.ts` (offline, no network, seeded per tile).

| Kind | Model highlights |
|------|------------------|
| `dc` | Hall, roof chillers, cooling stacks, dock, fence, generator |
| `lake` | Multi-lobe water, shore, reeds, dock, lily pads, rocks |
| `forest` | Pine / broadleaf / birch, leaf litter, logs, mushrooms |
| `house` | 1–3 homes, pitched roofs, windows, cars, mailboxes, hedges |
| `road` | Asphalt, dashes, edge lines, lamps, manholes (oriented) |
| `park` | Path, bench, shade trees, fountain, flowers, picnic table |
| `warehouse` | Bay doors, office annex, containers, forklift |
| `city` | Skyscraper cluster, window lights, street lamp |
| Power / fab | Substation poles, solar arrays, tanks, SMR towers, cleanroom |

Optional: drop glTF files here later; the game always has procedural fallbacks.
