import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { dcBayUsage } from './dcRacks'
import { fillAllAvailableRackBays } from './hosting'
import { isDcAnchor, isDcKind } from './map'
import { facilityAnchorTiles } from './worldAccess'

describe('fillAllAvailableRackBays', () => {
  it('reserves every free bay in completed halls and ignores construction', () => {
    const created = createGame(82_441)
    const sites = created.map.tiles.filter(
      (tile) => tile.kind === 'empty' && tile.owner === 'neutral' && tile.regionId !== 'void',
    ).slice(0, 3)
    const [firstHall, secondHall, constructionSite] = sites
    const state = {
      ...created,
      map: {
        ...created.map,
        tiles: created.map.tiles.map((tile) =>
          tile.x === firstHall.x && tile.y === firstHall.y
            ? {
                ...tile,
                kind: 'dc' as const,
                owner: 'player' as const,
                campusRole: 'anchor' as const,
                rackCapacity: 4,
                buildingProgress: 30,
                buildingTarget: 30,
              }
            : tile.x === secondHall.x && tile.y === secondHall.y
              ? {
                  ...tile,
                  kind: 'dc' as const,
                  owner: 'player' as const,
                  campusRole: 'anchor' as const,
                  rackCapacity: 3,
                  buildingProgress: 30,
                  buildingTarget: 30,
                }
              : tile.x === constructionSite.x && tile.y === constructionSite.y
            ? {
                ...tile,
                kind: 'dc' as const,
                owner: 'player' as const,
                campusRole: 'anchor' as const,
                rackCapacity: 11,
                buildingProgress: 3,
                buildingTarget: 30,
              }
            : tile,
        ),
      },
      player: {
        ...created.player,
        cash: 1_000_000_000_000_000,
        chips: [],
        deployedRacks: [],
        rackFleet: [],
      },
    }
    const completed = facilityAnchorTiles(state, { ownerId: 'player' }).filter(
      (tile) =>
        isDcKind(tile.kind) &&
        isDcAnchor(tile) &&
        tile.buildingProgress >= tile.buildingTarget,
    )
    const freeBefore = completed.reduce(
      (sum, hall) => sum + dcBayUsage(state, hall.x, hall.y).free,
      0,
    )

    expect(freeBefore).toBeGreaterThan(0)
    const filled = fillAllAvailableRackBays(state)

    expect(
      completed.reduce((sum, hall) => sum + dcBayUsage(filled, hall.x, hall.y).free, 0),
    ).toBe(0)
    expect(
      filled.worldMarkets.orders.some(
        (order) =>
          order.kind === 'accelerator' &&
          order.destination?.x === constructionSite.x &&
          order.destination?.y === constructionSite.y,
      ),
    ).toBe(false)

    const orderCount = filled.worldMarkets.orders.length
    const filledAgain = fillAllAvailableRackBays(filled)
    expect(filledAgain.worldMarkets.orders).toHaveLength(orderCount)
  })
})
