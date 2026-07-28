import { describe, expect, it } from 'vitest'
import {
  ROAD_CLASS_PROFILES,
  type RoadNetworkSnapshot,
  type RoadSegment,
  tileId,
} from '../../../sim/world'
import { RoadPropArchetype, SceneryArchetype } from './artDirectedRegistry'
import { MAP_TILE_SIZE, roadPropInstancesForChunk } from './simRenderSource'

function segment(
  id: string,
  roadClass: 2 | 4,
  points: Array<{ x: number; y: number }>,
): RoadSegment {
  return {
    index: 0,
    id,
    fromJunctionId: 'junction:0',
    toJunctionId: null,
    tileIds: points.map((_, index) => tileId(index, 0, 32)),
    points: points.map((point, index) => ({ ...point, tileId: tileId(index, 0, 32), elevation: 0.2 })),
    roadClass,
    flags: 0,
    bridge: false,
    length: points.length - 1,
    profile: ROAD_CLASS_PROFILES[roadClass],
  }
}

function network(drivingSide: 'left' | 'right'): RoadNetworkSnapshot {
  const collector = segment('collector', 2, [{ x: 8.5, y: 8.5 }, { x: 10.5, y: 8.5 }])
  const highway = segment('highway', 4, Array.from({ length: 8 }, (_, index) => ({ x: 9.5 + index, y: 12.5 })))
  return {
    revision: 1,
    width: 32,
    height: 32,
    chunkSize: 32,
    chunksWide: 1,
    drivingSide,
    profiles: ROAD_CLASS_PROFILES,
    segments: [collector, highway],
    junctions: [{
      index: 0,
      id: 'junction:0',
      tileId: tileId(8, 8, 32),
      x: 8.5,
      y: 8.5,
      elevation: 0.2,
      segmentIds: ['collector'],
      ports: [
        { segmentId: 'collector', tileId: tileId(0, 0, 32), headingX: 1, headingY: 0 },
        { segmentId: 'collector', tileId: tileId(0, 0, 32), headingX: 0, headingY: 1 },
        { segmentId: 'collector', tileId: tileId(0, 0, 32), headingX: -1, headingY: 0 },
        { segmentId: 'collector', tileId: tileId(0, 0, 32), headingX: 0, headingY: -1 },
      ],
      signalized: true,
      hasCrosswalks: true,
      hasStopLines: true,
    }],
    lanes: [],
    connectors: [],
    terminals: [],
    chunks: new Map([[0, {
      segmentIds: ['collector', 'highway'],
      junctionIds: ['junction:0'],
      terminalIds: [],
    }]]),
    nearestSegmentByTile: new Int32Array(32 * 32),
    accessDistanceByTile: new Uint16Array(32 * 32),
  }
}

describe('compiled road prop projection', () => {
  it('uses signal/crosswalk metadata and highway class without scanning other chunks', () => {
    const props = roadPropInstancesForChunk(network('left'), 0, () => 0.4)
    const count = (archetypeId: number) => props.filter(prop => prop.archetypeId === archetypeId).length

    expect(count(RoadPropArchetype.trafficLight)).toBe(4)
    expect(count(RoadPropArchetype.pedestrianSignal)).toBe(0)
    expect(count(RoadPropArchetype.roadSign)).toBe(2)
    expect(count(RoadPropArchetype.highwayGuardrail)).toBeGreaterThanOrEqual(2)
    expect(count(SceneryArchetype.roadLamp)).toBeLessThanOrEqual(1)
    expect(props.every(prop => prop.y === 0.44)).toBe(true)
    const junctionWorld = 8 * MAP_TILE_SIZE
    const signals = props.filter(prop => prop.archetypeId === RoadPropArchetype.trafficLight)
    expect(signals.every(prop => Math.hypot(prop.x - junctionWorld, prop.z - junctionWorld) > 0.4)).toBe(true)
    expect(roadPropInstancesForChunk(network('left'), 1)).toEqual([])
  })

  it('is stable for a snapshot and mirrors roadside placement by driving side', () => {
    const leftNetwork = network('left')
    const first = roadPropInstancesForChunk(leftNetwork, 0)
    const second = roadPropInstancesForChunk(leftNetwork, 0)
    expect(second).toEqual(first)

    const leftSignal = first.find(prop => prop.archetypeId === RoadPropArchetype.trafficLight)!
    const rightSignal = roadPropInstancesForChunk(network('right'), 0)
      .find(prop => prop.archetypeId === RoadPropArchetype.trafficLight)!
    expect(rightSignal.entityId).toBe(leftSignal.entityId)
    expect(rightSignal.z).not.toBe(leftSignal.z)
  })
})
