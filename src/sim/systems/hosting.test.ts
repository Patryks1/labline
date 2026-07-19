import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { dcBayUsage } from './dcRacks'
import {
  deployRackBatchAcrossHalls,
  fillAllAvailableRackBays,
  quoteRackDeployment,
} from './hosting'
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

  it('caps a multi-hall deployment by aggregate market supply', () => {
    const created = createGame(73_112)
    const sites = created.map.tiles.filter(
      (tile) => tile.kind === 'empty' && tile.owner === 'neutral' && tile.regionId !== 'void',
    ).slice(0, 2)
    const state = {
      ...created,
      map: {
        ...created.map,
        tiles: created.map.tiles.map((tile) =>
          sites.some((site) => site.x === tile.x && site.y === tile.y)
            ? {
                ...tile,
                kind: 'dc' as const,
                owner: 'player' as const,
                campusRole: 'anchor' as const,
                rackCapacity: 6,
                buildingProgress: 30,
                buildingTarget: 30,
              }
            : tile,
        ),
      },
      player: { ...created.player, cash: 10_000_000_000, rackFleet: [], deployedRacks: [] },
      worldMarkets: {
        ...created.worldMarkets,
        accelerators: {
          ...created.worldMarkets.accelerators,
          rack_h100: {
            ...created.worldMarkets.accelerators.rack_h100!,
            available: 2,
          },
        },
      },
    }
    const targets = sites.map((site) => ({ x: site.x, y: site.y }))
    const quote = quoteRackDeployment(state, 'rack_h100', targets)

    expect(quote.fillAllRacks).toBe(12)
    expect(quote.maxRacks).toBe(2)
    expect(quote.canFillAll).toBe(false)

    const deployed = deployRackBatchAcrossHalls(state, 'rack_h100', targets, 99)
    const reserved = deployed.worldMarkets.orders
      .filter((order) => order.kind === 'accelerator' && order.resourceId === 'rack_h100')
      .reduce((sum, order) => sum + order.quantity, 0)
    expect(reserved).toBe(2)
  })
})
