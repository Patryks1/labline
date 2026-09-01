import type {
  DataHallDoorPlacement,
  DataHallEditPlan,
  DataHallLayout,
  DataHallLayoutAnalysis,
  DataHallObjectKind,
  DataHallObjectPlacement,
  DataHallShellId,
  DataHallWallSegment,
  HallAutoLayoutStrategy,
  HallRotation,
  LabId,
  MapTile,
  RackInstall,
  RackSku,
  SimState,
} from "../types";
import { quoteRackOrder } from "../balance/rackSkus";
import { resolveRackSku } from "./racks";
import { aggregateEffects } from "./research";
import { seededId } from "../rng";
import { facilityAnchorTiles } from "./worldAccess";
import { isDcAnchor, isDcKind } from "./map";
import {
  advanceHallConstructionProject,
  createHallConstructionProject,
  normalizeHallConstructionProject,
} from "./dataHallConstruction";

export const HALL_GRID_METERS = 0.25;

export interface DataHallShellTemplate {
  id: DataHallShellId;
  width: number;
  depth: number;
  exteriorDoor: { x: number; z: number; width: number; clearance: number };
}

export const DATA_HALL_SHELLS: Record<DataHallShellId, DataHallShellTemplate> =
  {
    "hall-small-v1": {
      id: "hall-small-v1",
      width: 72,
      depth: 52,
      exteriorDoor: { x: 34, z: 0, width: 4, clearance: 6 },
    },
    "hall-medium-v1": {
      id: "hall-medium-v1",
      width: 120,
      depth: 84,
      exteriorDoor: { x: 58, z: 0, width: 4, clearance: 6 },
    },
    "hall-large-v1": {
      id: "hall-large-v1",
      width: 192,
      depth: 128,
      exteriorDoor: { x: 94, z: 0, width: 4, clearance: 6 },
    },
    // Existing saves may contain deliberate placements outside the denser
    // shells above. These templates are migration-only: new halls never select
    // them, but grandfathered geometry remains valid and is never clamped,
    // overlapped, or silently discarded.
    "hall-small-v1-legacy": {
      id: "hall-small-v1-legacy",
      width: 96,
      depth: 72,
      exteriorDoor: { x: 46, z: 0, width: 4, clearance: 6 },
    },
    "hall-medium-v1-legacy": {
      id: "hall-medium-v1-legacy",
      width: 168,
      depth: 120,
      exteriorDoor: { x: 82, z: 0, width: 4, clearance: 6 },
    },
    "hall-large-v1-legacy": {
      id: "hall-large-v1-legacy",
      width: 288,
      depth: 192,
      exteriorDoor: { x: 142, z: 0, width: 4, clearance: 6 },
    },
  };

const LEGACY_SHELL_FOR_COMPACT: Partial<
  Record<DataHallShellId, DataHallShellId>
> = {
  "hall-small-v1": "hall-small-v1-legacy",
  "hall-medium-v1": "hall-medium-v1-legacy",
  "hall-large-v1": "hall-large-v1-legacy",
};

export interface HallEquipmentDef {
  id: string;
  kind: Exclude<DataHallObjectKind, "rack">;
  name: string;
  width: number;
  depth: number;
  price: number;
  powerMw?: number;
  coolingMw?: number;
  networkGbps?: number;
  /** Maximum walkable-grid route length this unit can serve. Cooling is local. */
  maxServiceDistanceCells?: number;
}

export const HALL_EQUIPMENT_CATALOG: readonly HallEquipmentDef[] = [
  {
    id: "crac-2mw",
    kind: "cooling",
    name: "CRAC 2 MW",
    width: 8,
    depth: 12,
    price: 3_200_000,
    coolingMw: 2,
    maxServiceDistanceCells: 192,
  },
  {
    id: "inrow-350kw",
    kind: "cooling",
    name: "In-row cooler",
    width: 3,
    depth: 5,
    price: 720_000,
    coolingMw: 0.35,
    maxServiceDistanceCells: 56,
  },
  {
    id: "pdu-2mw",
    kind: "power",
    name: "PDU 2 MW",
    width: 4,
    depth: 4,
    price: 1_150_000,
    powerMw: 2,
  },
  {
    id: "ups-5mw",
    kind: "power",
    name: "UPS 5 MW",
    width: 6,
    depth: 8,
    price: 5_800_000,
    powerMw: 5,
  },
  {
    id: "core-6t",
    kind: "network",
    name: "Core fabric 6.4T",
    width: 3,
    depth: 4,
    price: 980_000,
    networkGbps: 6_400,
  },
  {
    id: "core-25t",
    kind: "network",
    name: "Core fabric 25T",
    width: 4,
    depth: 5,
    price: 3_600_000,
    networkGbps: 25_600,
  },
] as const;

export interface HallRackUnit {
  unitId: string;
  skuId: string;
  mw: number;
  networkGbps: number;
  delivered: boolean;
  /** Optional SKU stats so auto-layout strategies can rank units. */
  flopsPf?: number;
  rackUnits?: number;
  price?: number;
  generation?: number;
}

export function shellIdForSize(size?: string): DataHallShellId {
  return size === "large"
    ? "hall-large-v1"
    : size === "medium"
      ? "hall-medium-v1"
      : "hall-small-v1";
}

export function ensureRackUnitIds(install: RackInstall): RackInstall {
  const existing = install.unitIds ?? [];
  const unitIds = Array.from(
    { length: Math.max(0, Math.floor(install.count)) },
    (_, index) =>
      existing[index]?.trim() ||
      `${install.id}:unit:${String(index + 1).padStart(4, "0")}`,
  );
  return { ...install, unitIds };
}

function ownerFleet(state: SimState, ownerId: LabId): RackInstall[] {
  if (ownerId === state.playerLabId) return state.player.rackFleet ?? [];
  return (
    state.rivals.find((rival) => rival.id === ownerId)?.rackFleet ??
    state.labs[ownerId]?.rackFleet ??
    []
  );
}

function ownerDesigns(state: SimState, ownerId: LabId) {
  if (ownerId === state.playerLabId) return state.player.rackDesigns ?? [];
  return (
    state.rivals.find((rival) => rival.id === ownerId)?.rackDesigns ??
    state.labs[ownerId]?.rackDesigns ??
    []
  );
}

export function rackUnitsForFacility(
  state: SimState,
  facilityId: string,
  ownerId: LabId,
  hallHint?: Pick<MapTile, "x" | "y">,
): HallRackUnit[] {
  const designs = ownerDesigns(state, ownerId);
  const hall =
    hallHint ??
    facilityAnchorTiles(state, { ownerId }).find(
      (candidate) =>
        (candidate.campusId ?? `facility:${candidate.x},${candidate.y}`) ===
        facilityId,
    );
  return ownerFleet(state, ownerId)
    .filter(
      (install) =>
        install.facilityId === facilityId ||
        (!install.facilityId && hall?.x === install.x && hall.y === install.y),
    )
    .flatMap((raw) => {
      const install = ensureRackUnitIds(raw);
      let mw = 0.0075;
      let networkGbps = 400;
      let flopsPf: number | undefined;
      let rackUnits: number | undefined;
      let price: number | undefined;
      let generation: number | undefined;
      try {
        const sku = resolveRackSku(install.skuId, designs);
        mw = sku.mw;
        networkGbps = sku.networkGbps ?? 400;
        flopsPf = sku.flopsPf;
        rackUnits = sku.rackUnits;
        price = sku.price;
        generation = sku.generation;
      } catch {
        /* legacy unknown rack */
      }
      return install.unitIds!.map((unitId) => ({
        unitId,
        skuId: install.skuId,
        mw,
        networkGbps,
        delivered: install.status === "live",
        flopsPf,
        rackUnits,
        price,
        generation,
      }));
    });
}

function dims(object: DataHallObjectPlacement): {
  width: number;
  depth: number;
} {
  const base =
    object.kind === "rack"
      ? {
          // Multi-cabinet systems consume their real floor width. The old
          // shell bay rating used to account for this numerically while the
          // editor still drew a single cabinet, which allowed impossible
          // overlaps once the abstract limit was removed.
          width: 3 * staticRackBayDemand(object.catalogId),
          depth: 5,
        }
      : (HALL_EQUIPMENT_CATALOG.find(
          (entry) => entry.id === object.catalogId,
        ) ?? { width: 1, depth: 1 });
  return object.rotation === 90 || object.rotation === 270
    ? { width: base.depth, depth: base.width }
    : { width: base.width, depth: base.depth };
}

function rectCells(
  shell: DataHallShellTemplate,
  object: DataHallObjectPlacement,
): number[] {
  const { width, depth } = dims(object);
  const cells: number[] = [];
  for (let z = object.z; z < object.z + depth; z += 1) {
    for (let x = object.x; x < object.x + width; x += 1)
      cells.push(z * shell.width + x);
  }
  return cells;
}

function rectsOverlap(
  a: DataHallObjectPlacement,
  b: DataHallObjectPlacement,
): boolean {
  const ad = dims(a);
  const bd = dims(b);
  return (
    a.x < b.x + bd.width &&
    a.x + ad.width > b.x &&
    a.z < b.z + bd.depth &&
    a.z + ad.depth > b.z
  );
}

function staticRackBayDemand(catalogId: string): number {
  try {
    return Math.max(
      1,
      Math.floor(resolveRackSku(catalogId, []).rackUnits || 1),
    );
  } catch {
    return 1;
  }
}

/** Cheap pointer-preview validation that deliberately avoids utility routing. */
export function previewHallObjectPlacement(
  layout: Pick<DataHallLayout, "shellId" | "objects" | "walls" | "doors">,
  candidate: DataHallObjectPlacement,
  _legacyRackCapacity?: number,
): "valid" | "warning" | "invalid" {
  const shell = DATA_HALL_SHELLS[layout.shellId];
  const size = dims(candidate);
  if (
    !Number.isInteger(candidate.x) ||
    !Number.isInteger(candidate.z) ||
    candidate.x < 0 ||
    candidate.z < 0 ||
    candidate.x + size.width > shell.width ||
    candidate.z + size.depth > shell.depth
  )
    return "invalid";
  const exterior = shell.exteriorDoor;
  if (
    candidate.x < exterior.x + exterior.width &&
    candidate.x + size.width > exterior.x &&
    candidate.z < exterior.clearance
  )
    return "invalid";
  if (
    layout.objects.some(
      (object) => object.id !== candidate.id && rectsOverlap(object, candidate),
    )
  )
    return "invalid";
  if (layout.walls.some((wall) => wallIntersectsObject(wall, candidate)))
    return "invalid";
  for (const door of layout.doors) {
    const wall = layout.walls.find((entry) => entry.id === door.wallId);
    if (!wall) continue;
    const horizontal = wall.z1 === wall.z2;
    const length = Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1);
    const start = Math.max(
      0,
      Math.min(
        Math.max(0, length - door.width),
        Math.round(door.offset * Math.max(0, length - door.width)),
      ),
    );
    const doorX = horizontal ? Math.min(wall.x1, wall.x2) + start : wall.x1;
    const doorZ = horizontal ? wall.z1 : Math.min(wall.z1, wall.z2) + start;
    const overlaps = horizontal
      ? candidate.x < doorX + door.width &&
        candidate.x + size.width > doorX &&
        candidate.z < doorZ + 6 &&
        candidate.z + size.depth > doorZ - 6
      : candidate.z < doorZ + door.width &&
        candidate.z + size.depth > doorZ &&
        candidate.x < doorX + 6 &&
        candidate.x + size.width > doorX - 6;
    if (overlaps) return "invalid";
  }
  if (candidate.kind !== "rack") return "valid";
  const clearance = 5;
  const nearObject = layout.objects.some((object) => {
    if (object.id === candidate.id) return false;
    const d = dims(object);
    return (
      candidate.x - clearance < object.x + d.width &&
      candidate.x + size.width + clearance > object.x &&
      candidate.z - clearance < object.z + d.depth &&
      candidate.z + size.depth + clearance > object.z
    );
  });
  return nearObject ? "warning" : "valid";
}

function wallIntersectsObject(
  wall: DataHallWallSegment,
  object: DataHallObjectPlacement,
): boolean {
  const { width, depth } = dims(object);
  const minX = object.x;
  const maxX = object.x + width;
  const minZ = object.z;
  const maxZ = object.z + depth;
  if (wall.x1 === wall.x2)
    return (
      wall.x1 > minX &&
      wall.x1 < maxX &&
      Math.max(wall.z1, wall.z2) > minZ &&
      Math.min(wall.z1, wall.z2) < maxZ
    );
  if (wall.z1 === wall.z2)
    return (
      wall.z1 > minZ &&
      wall.z1 < maxZ &&
      Math.max(wall.x1, wall.x2) > minX &&
      Math.min(wall.x1, wall.x2) < maxX
    );
  return true;
}

interface HallTopology {
  shell: DataHallShellTemplate;
  occupancy: Int32Array;
  blockedEdges: Set<number>;
}

interface HallTraversal {
  distance: Int32Array;
  /** Parent points one step back toward the nearest source; -2 marks a source. */
  parent: Int32Array;
}

function edgeKey(cellA: number, cellB: number, cellCount: number): number {
  const low = Math.min(cellA, cellB);
  return low * cellCount + Math.max(cellA, cellB);
}

function wallEdge(
  shell: DataHallShellTemplate,
  horizontal: boolean,
  fixed: number,
  along: number,
): [number, number] | undefined {
  if (horizontal) {
    if (fixed <= 0 || fixed >= shell.depth || along < 0 || along >= shell.width)
      return undefined;
    return [(fixed - 1) * shell.width + along, fixed * shell.width + along];
  }
  if (fixed <= 0 || fixed >= shell.width || along < 0 || along >= shell.depth)
    return undefined;
  return [along * shell.width + fixed - 1, along * shell.width + fixed];
}

function buildBlockedEdges(
  shell: DataHallShellTemplate,
  walls: readonly DataHallWallSegment[],
  doors: readonly DataHallDoorPlacement[],
): Set<number> {
  const cellCount = shell.width * shell.depth;
  const blocked = new Set<number>();
  const validWalls = walls.filter(
    (wall) => wall.x1 === wall.x2 || wall.z1 === wall.z2,
  );
  for (const wall of validWalls) {
    const horizontal = wall.z1 === wall.z2;
    const fixed = horizontal ? wall.z1 : wall.x1;
    const start = horizontal
      ? Math.min(wall.x1, wall.x2)
      : Math.min(wall.z1, wall.z2);
    const end = horizontal
      ? Math.max(wall.x1, wall.x2)
      : Math.max(wall.z1, wall.z2);
    for (let along = start; along < end; along += 1) {
      const edge = wallEdge(shell, horizontal, fixed, along);
      if (edge) blocked.add(edgeKey(edge[0], edge[1], cellCount));
    }
  }
  // Doors cut traversable openings into their supporting wall.
  for (const door of doors) {
    const wall = validWalls.find((candidate) => candidate.id === door.wallId);
    if (!wall) continue;
    const horizontal = wall.z1 === wall.z2;
    const fixed = horizontal ? wall.z1 : wall.x1;
    const wallStart = horizontal
      ? Math.min(wall.x1, wall.x2)
      : Math.min(wall.z1, wall.z2);
    const wallLength =
      Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1);
    const width = Math.max(0, Math.min(wallLength, Math.floor(door.width)));
    const offset = Math.max(
      0,
      Math.min(
        Math.max(0, wallLength - width),
        Math.round(door.offset * Math.max(0, wallLength - width)),
      ),
    );
    for (let step = 0; step < width; step += 1) {
      const edge = wallEdge(
        shell,
        horizontal,
        fixed,
        wallStart + offset + step,
      );
      if (edge) blocked.delete(edgeKey(edge[0], edge[1], cellCount));
    }
  }
  return blocked;
}

function forEachWalkableNeighbor(
  topology: HallTopology,
  cell: number,
  visit: (neighbor: number) => void,
): void {
  const { shell, occupancy, blockedEdges } = topology;
  const x = cell % shell.width;
  const z = Math.floor(cell / shell.width);
  const count = occupancy.length;
  const maybeVisit = (neighbor: number) => {
    if (
      occupancy[neighbor] === 0 &&
      !blockedEdges.has(edgeKey(cell, neighbor, count))
    )
      visit(neighbor);
  };
  if (x > 0) maybeVisit(cell - 1);
  if (x + 1 < shell.width) maybeVisit(cell + 1);
  if (z > 0) maybeVisit(cell - shell.width);
  if (z + 1 < shell.depth) maybeVisit(cell + shell.width);
}

function traverseHall(
  topology: HallTopology,
  rawSources: readonly number[],
): HallTraversal {
  const distance = new Int32Array(topology.occupancy.length);
  const parent = new Int32Array(topology.occupancy.length);
  distance.fill(-1);
  parent.fill(-1);
  const queue = new Int32Array(topology.occupancy.length);
  let head = 0;
  let tail = 0;
  const sources = [...new Set(rawSources)].sort((a, b) => a - b);
  for (const source of sources) {
    if (
      source < 0 ||
      source >= topology.occupancy.length ||
      topology.occupancy[source] !== 0 ||
      distance[source] >= 0
    )
      continue;
    distance[source] = 0;
    parent[source] = -2;
    queue[tail++] = source;
  }
  while (head < tail) {
    const current = queue[head++]!;
    forEachWalkableNeighbor(topology, current, (neighbor) => {
      if (distance[neighbor] >= 0) return;
      distance[neighbor] = distance[current]! + 1;
      parent[neighbor] = current;
      queue[tail++] = neighbor;
    });
  }
  return { distance, parent };
}

function objectServiceCells(
  topology: HallTopology,
  object: DataHallObjectPlacement,
): number[] {
  const { shell, occupancy, blockedEdges } = topology;
  const { width, depth } = dims(object);
  const count = occupancy.length;
  const cells = new Set<number>();
  const add = (
    outsideX: number,
    outsideZ: number,
    insideX: number,
    insideZ: number,
  ) => {
    if (
      outsideX < 0 ||
      outsideZ < 0 ||
      outsideX >= shell.width ||
      outsideZ >= shell.depth
    )
      return;
    const outside = outsideZ * shell.width + outsideX;
    const inside = insideZ * shell.width + insideX;
    if (
      occupancy[outside] !== 0 ||
      blockedEdges.has(edgeKey(outside, inside, count))
    )
      return;
    cells.add(outside);
  };
  for (let x = object.x; x < object.x + width; x += 1) {
    add(x, object.z - 1, x, object.z);
    add(x, object.z + depth, x, object.z + depth - 1);
  }
  for (let z = object.z; z < object.z + depth; z += 1) {
    add(object.x - 1, z, object.x, z);
    add(object.x + width, z, object.x + width - 1, z);
  }
  return [...cells].sort((a, b) => a - b);
}

function nearestReachableCell(
  cells: readonly number[],
  traversal: HallTraversal,
): number | undefined {
  let best: number | undefined;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const cell of cells) {
    const distance = traversal.distance[cell] ?? -1;
    if (distance < 0) continue;
    if (
      distance < bestDistance ||
      (distance === bestDistance && (best === undefined || cell < best))
    ) {
      best = cell;
      bestDistance = distance;
    }
  }
  return best;
}

function routeToSource(
  cell: number | undefined,
  traversal: HallTraversal,
): number[] {
  if (cell === undefined || traversal.distance[cell] < 0) return [];
  const route: number[] = [];
  let current = cell;
  let guard = traversal.parent.length + 1;
  while (current >= 0 && guard-- > 0) {
    route.push(current);
    const parent = traversal.parent[current]!;
    if (parent === -2) break;
    if (parent < 0) return [];
    current = parent;
  }
  return route;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function emptyAnalysis(revision: number): DataHallLayoutAnalysis {
  return {
    revision,
    valid: true,
    hardErrors: [],
    warnings: [],
    operationalRackUnitIds: [],
    offlineRackUnitIds: [],
    environmentScore: 1,
    coolingScore: 1,
    airflowScore: 1,
    aisleScore: 1,
    accessScore: 1,
    maintenanceScore: 1,
    redundancyScore: 1,
    powerUtilization: 0,
    coolingUtilization: 0,
    networkUtilization: 0,
    powerHeadroomMw: 0,
    coolingHeadroomMw: 0,
    networkHeadroomGbps: 0,
    throughputMultiplier: 1,
    pueMultiplier: 1,
    incidentRiskMultiplier: 1,
    powerRoutes: [],
    coolingRoutes: [],
    networkRoutes: [],
    serviceRoutes: [],
    inaccessibleObjectIds: [],
    redundantRackUnitIds: [],
    bottlenecks: [],
  };
}

export function analyzeHallLayout(
  layout: Pick<
    DataHallLayout,
    "revision" | "shellId" | "objects" | "walls" | "doors"
  >,
  inventory: readonly HallRackUnit[],
  _legacyRackCapacity = Number.MAX_SAFE_INTEGER,
): DataHallLayoutAnalysis {
  const shell = DATA_HALL_SHELLS[layout.shellId];
  const analysis = emptyAnalysis(layout.revision);
  const occupancy = new Int32Array(shell.width * shell.depth);
  const inventoryById = new Map(inventory.map((unit) => [unit.unitId, unit]));
  const racks = layout.objects
    .filter((object) => object.kind === "rack")
    .sort((a, b) => a.id.localeCompare(b.id));
  const placementIds = new Set<string>();
  for (const entry of [...layout.objects, ...layout.walls, ...layout.doors]) {
    if (placementIds.has(entry.id))
      analysis.hardErrors.push(
        `Placement ID ${entry.id} is used more than once.`,
      );
    else placementIds.add(entry.id);
  }
  const seenRackUnits = new Set<string>();
  const validObjectIds = new Set<string>();
  for (
    let objectIndex = 0;
    objectIndex < layout.objects.length;
    objectIndex += 1
  ) {
    const object = layout.objects[objectIndex]!;
    if (object.kind !== "rack") {
      const equipment = HALL_EQUIPMENT_CATALOG.find(
        (entry) => entry.id === object.catalogId,
      );
      if (!equipment || equipment.kind !== object.kind)
        analysis.hardErrors.push(
          `${object.id} references unknown ${object.kind} equipment ${object.catalogId}.`,
        );
    }
    const { width, depth } = dims(object);
    if (
      !Number.isInteger(object.x) ||
      !Number.isInteger(object.z) ||
      object.x < 0 ||
      object.z < 0 ||
      object.x + width > shell.width ||
      object.z + depth > shell.depth
    ) {
      analysis.hardErrors.push(`${object.id} is outside the hall shell.`);
      continue;
    }
    validObjectIds.add(object.id);
    const door = shell.exteriorDoor;
    if (
      object.x < door.x + door.width &&
      object.x + width > door.x &&
      object.z < door.clearance
    ) {
      analysis.hardErrors.push(
        `${object.id} blocks the exterior door clearance.`,
      );
    }
    for (const wall of layout.walls)
      if (wallIntersectsObject(wall, object))
        analysis.hardErrors.push(`${object.id} intersects wall ${wall.id}.`);
    for (const cell of rectCells(shell, object)) {
      if (occupancy[cell] !== 0)
        analysis.hardErrors.push(
          `${object.id} overlaps ${layout.objects[occupancy[cell]! - 1]!.id}.`,
        );
      else occupancy[cell] = objectIndex + 1;
    }
    if (object.kind === "rack") {
      if (object.reserved) {
        if (object.rackUnitId)
          analysis.hardErrors.push(
            `${object.id} cannot be both reserved and assigned to rack unit ${object.rackUnitId}.`,
          );
        continue;
      }
      if (!object.rackUnitId) {
        // Purchase draft — bought and commissioned when the plan is applied.
        continue;
      }
      if (!inventoryById.has(object.rackUnitId))
        analysis.hardErrors.push(
          `${object.id} does not reference an owned rack unit.`,
        );
      else if (seenRackUnits.has(object.rackUnitId))
        analysis.hardErrors.push(
          `${object.rackUnitId} is placed more than once.`,
        );
      else seenRackUnits.add(object.rackUnitId);
    }
  }
  for (const wall of layout.walls) {
    if (
      (wall.x1 !== wall.x2 && wall.z1 !== wall.z2) ||
      wall.x1 < 0 ||
      wall.x2 < 0 ||
      wall.z1 < 0 ||
      wall.z2 < 0 ||
      wall.x1 > shell.width ||
      wall.x2 > shell.width ||
      wall.z1 > shell.depth ||
      wall.z2 > shell.depth
    ) {
      analysis.hardErrors.push(
        `Wall ${wall.id} must be an axis-aligned segment inside the shell.`,
      );
    }
  }
  for (const door of layout.doors) {
    const wall = layout.walls.find((candidate) => candidate.id === door.wallId);
    if (!wall) {
      analysis.hardErrors.push(`Door ${door.id} has no supporting wall.`);
      continue;
    }
    const horizontal = wall.z1 === wall.z2;
    const length = Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1);
    if (
      !Number.isFinite(door.offset) ||
      door.offset < 0 ||
      door.offset > 1 ||
      !Number.isInteger(door.width) ||
      door.width <= 0 ||
      door.width > length
    ) {
      analysis.hardErrors.push(
        `Door ${door.id} must fit its supporting wall with an offset from 0 to 1.`,
      );
      continue;
    }
    const start = Math.max(
      0,
      Math.min(
        Math.max(0, length - door.width),
        Math.round(door.offset * Math.max(0, length - door.width)),
      ),
    );
    const doorX = horizontal ? Math.min(wall.x1, wall.x2) + start : wall.x1;
    const doorZ = horizontal ? wall.z1 : Math.min(wall.z1, wall.z2) + start;
    for (const object of layout.objects) {
      const d = dims(object);
      const overlaps = horizontal
        ? object.x < doorX + door.width &&
          object.x + d.width > doorX &&
          object.z < doorZ + 6 &&
          object.z + d.depth > doorZ - 6
        : object.z < doorZ + door.width &&
          object.z + d.depth > doorZ &&
          object.x < doorX + 6 &&
          object.x + d.width > doorX - 6;
      if (overlaps)
        analysis.hardErrors.push(`${object.id} blocks door ${door.id}.`);
    }
  }

  const topology: HallTopology = {
    shell,
    occupancy,
    blockedEdges: buildBlockedEdges(shell, layout.walls, layout.doors),
  };
  const entranceCells: number[] = [];
  for (
    let x = shell.exteriorDoor.x;
    x < shell.exteriorDoor.x + shell.exteriorDoor.width;
    x += 1
  ) {
    const cell = x;
    if (cell >= 0 && cell < occupancy.length && occupancy[cell] === 0)
      entranceCells.push(cell);
  }
  const accessTraversal = traverseHall(topology, entranceCells);
  const serviceCellsByObjectId = new Map<string, number[]>();
  const accessibleServiceCellsByObjectId = new Map<string, number[]>();
  const relevantObjects = layout.objects.filter((object) =>
    validObjectIds.has(object.id),
  );
  for (const object of relevantObjects) {
    const serviceCells = objectServiceCells(topology, object);
    const accessible = serviceCells.filter(
      (cell) => accessTraversal.distance[cell]! >= 0,
    );
    serviceCellsByObjectId.set(object.id, serviceCells);
    accessibleServiceCellsByObjectId.set(object.id, accessible);
    const closest = nearestReachableCell(accessible, accessTraversal);
    if (closest === undefined) analysis.inaccessibleObjectIds.push(object.id);
    else
      analysis.serviceRoutes.push({
        objectId: object.id,
        cells: routeToSource(closest, accessTraversal),
      });
  }
  analysis.accessScore =
    relevantObjects.length > 0
      ? clamp01(
          (relevantObjects.length - analysis.inaccessibleObjectIds.length) /
            relevantObjects.length,
        )
      : 1;

  type UtilityKind = "power" | "cooling" | "network";
  interface UtilitySource {
    object: DataHallObjectPlacement;
    definition: HallEquipmentDef;
    capacity: number;
    remaining: number;
    traversal: HallTraversal;
  }
  const capacityFor = (
    definition: HallEquipmentDef,
    kind: UtilityKind,
  ): number =>
    kind === "power"
      ? (definition.powerMw ?? 0)
      : kind === "cooling"
        ? (definition.coolingMw ?? 0)
        : (definition.networkGbps ?? 0);
  const sourcesFor = (kind: UtilityKind): UtilitySource[] =>
    layout.objects
      .filter(
        (object) =>
          object.kind === kind &&
          validObjectIds.has(object.id) &&
          (object.repairDaysRemaining ?? 0) <= 0,
      )
      .flatMap((object) => {
        const definition = HALL_EQUIPMENT_CATALOG.find(
          (entry) => entry.id === object.catalogId && entry.kind === kind,
        );
        const serviceCells =
          accessibleServiceCellsByObjectId.get(object.id) ?? [];
        if (
          !definition ||
          capacityFor(definition, kind) <= 0 ||
          serviceCells.length <= 0
        )
          return [];
        const capacity = capacityFor(definition, kind);
        return [
          {
            object,
            definition,
            capacity,
            remaining: capacity,
            traversal: traverseHall(topology, serviceCells),
          },
        ];
      })
      .sort((a, b) => a.object.id.localeCompare(b.object.id));
  const power = sourcesFor("power");
  const cooling = sourcesFor("cooling");
  const network = sourcesFor("network");
  const deliveredRacks = racks.filter(
    (rack) =>
      !rack.reserved &&
      rack.rackUnitId &&
      inventoryById.get(rack.rackUnitId)?.delivered,
  );

  interface UtilityAssignment {
    source: UtilitySource;
    cells: number[];
    distance: number;
  }
  const candidatesFor = (
    sources: readonly UtilitySource[],
    rackCells: readonly number[],
    demand: number,
    requireHeadroom: boolean,
  ): UtilityAssignment[] =>
    sources
      .flatMap((source) => {
        if (requireHeadroom && source.remaining + 1e-9 < demand) return [];
        const endpoint = nearestReachableCell(rackCells, source.traversal);
        if (endpoint === undefined) return [];
        const distance = source.traversal.distance[endpoint]!;
        if (
          source.definition.maxServiceDistanceCells !== undefined &&
          distance > source.definition.maxServiceDistanceCells
        )
          return [];
        const cells = routeToSource(endpoint, source.traversal);
        return cells.length > 0 ? [{ source, cells, distance }] : [];
      })
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          a.source.object.id.localeCompare(b.source.object.id),
      );
  const assign = (
    sources: readonly UtilitySource[],
    rackCells: readonly number[],
    demand: number,
  ): UtilityAssignment | undefined => {
    const assignment = candidatesFor(sources, rackCells, demand, true)[0];
    if (assignment)
      assignment.source.remaining = Math.max(
        0,
        assignment.source.remaining - demand,
      );
    return assignment;
  };
  const primaryByRack = new Map<
    string,
    {
      power?: UtilityAssignment;
      cooling?: UtilityAssignment;
      network?: UtilityAssignment;
    }
  >();
  let totalHeat = 0;
  let airflowTotal = 0;
  let aisleTotal = 0;
  let allocatedHeat = 0;
  for (const rack of deliveredRacks) {
    const unit = inventoryById.get(rack.rackUnitId!)!;
    totalHeat += unit.mw;
    const rackCells = accessibleServiceCellsByObjectId.get(rack.id) ?? [];
    const powerAssignment = assign(power, rackCells, unit.mw);
    const coolingAssignment = assign(cooling, rackCells, unit.mw);
    const networkAssignment = assign(network, rackCells, unit.networkGbps);
    primaryByRack.set(unit.unitId, {
      power: powerAssignment,
      cooling: coolingAssignment,
      network: networkAssignment,
    });
    if (powerAssignment)
      analysis.powerRoutes.push({
        rackUnitId: unit.unitId,
        equipmentId: powerAssignment.source.object.id,
        cells: powerAssignment.cells,
      });
    if (coolingAssignment) {
      allocatedHeat += unit.mw;
      analysis.coolingRoutes.push({
        rackUnitId: unit.unitId,
        equipmentId: coolingAssignment.source.object.id,
        cells: coolingAssignment.cells,
      });
    }
    if (networkAssignment)
      analysis.networkRoutes.push({
        rackUnitId: unit.unitId,
        equipmentId: networkAssignment.source.object.id,
        cells: networkAssignment.cells,
      });
    if (
      powerAssignment &&
      coolingAssignment &&
      networkAssignment &&
      rackCells.length > 0
    )
      analysis.operationalRackUnitIds.push(unit.unitId);
    else analysis.offlineRackUnitIds.push(unit.unitId);

    const d = dims(rack);
    const ownIndex = layout.objects.indexOf(rack) + 1;
    const clearance = (
      dx: number,
      dz: number,
      target: number,
      acrossX: boolean,
    ) => {
      for (let step = 1; step <= target; step += 1) {
        const sx =
          dx < 0
            ? rack.x - step
            : dx > 0
              ? rack.x + d.width - 1 + step
              : rack.x;
        const sz =
          dz < 0
            ? rack.z - step
            : dz > 0
              ? rack.z + d.depth - 1 + step
              : rack.z;
        const across = acrossX ? d.width : d.depth;
        for (let offset = 0; offset < across; offset += 1) {
          const x = sx + (acrossX ? offset : 0);
          const z = sz + (acrossX ? 0 : offset);
          if (x < 0 || z < 0 || x >= shell.width || z >= shell.depth)
            return (step - 1) / target;
          const occupant = occupancy[z * shell.width + x];
          if (occupant !== 0 && occupant !== ownIndex)
            return (step - 1) / target;
        }
      }
      return 1;
    };
    const front =
      rack.rotation === 0
        ? clearance(0, 1, 5, true)
        : rack.rotation === 180
          ? clearance(0, -1, 5, true)
          : rack.rotation === 90
            ? clearance(1, 0, 5, false)
            : clearance(-1, 0, 5, false);
    const rear =
      rack.rotation === 0
        ? clearance(0, -1, 5, true)
        : rack.rotation === 180
          ? clearance(0, 1, 5, true)
          : rack.rotation === 90
            ? clearance(-1, 0, 5, false)
            : clearance(1, 0, 5, false);
    airflowTotal += Math.min(front, rear);
    const sides =
      rack.rotation === 0 || rack.rotation === 180
        ? [clearance(-1, 0, 6, false), clearance(1, 0, 6, false)]
        : [clearance(0, -1, 6, true), clearance(0, 1, 6, true)];
    aisleTotal += Math.max(...sides);
  }
  const divisor = Math.max(1, deliveredRacks.length);
  analysis.coolingScore =
    totalHeat > 0 ? clamp01(allocatedHeat / totalHeat) : 1;
  analysis.airflowScore = clamp01(airflowTotal / divisor);
  analysis.aisleScore = clamp01(aisleTotal / divisor);

  const powerDemand = deliveredRacks.reduce(
    (sum, rack) => sum + inventoryById.get(rack.rackUnitId!)!.mw,
    0,
  );
  const coolingDemand = totalHeat;
  const networkDemand = deliveredRacks.reduce(
    (sum, rack) => sum + inventoryById.get(rack.rackUnitId!)!.networkGbps,
    0,
  );
  const powerCapacity = power.reduce((sum, source) => sum + source.capacity, 0);
  const coolingCapacity = cooling.reduce(
    (sum, source) => sum + source.capacity,
    0,
  );
  const networkCapacity = network.reduce(
    (sum, source) => sum + source.capacity,
    0,
  );
  const utilization = (demand: number, capacity: number) =>
    demand <= 0 ? 0 : capacity > 0 ? demand / capacity : 1;
  analysis.powerUtilization = utilization(powerDemand, powerCapacity);
  analysis.coolingUtilization = utilization(coolingDemand, coolingCapacity);
  analysis.networkUtilization = utilization(networkDemand, networkCapacity);
  analysis.powerHeadroomMw = powerCapacity - powerDemand;
  analysis.coolingHeadroomMw = coolingCapacity - coolingDemand;
  analysis.networkHeadroomGbps = networkCapacity - networkDemand;

  let redundancyPoints = 0;
  for (const rack of deliveredRacks) {
    const unit = inventoryById.get(rack.rackUnitId!)!;
    if (!analysis.operationalRackUnitIds.includes(unit.unitId)) continue;
    const rackCells = accessibleServiceCellsByObjectId.get(rack.id) ?? [];
    const primary = primaryByRack.get(unit.unitId)!;
    const hasAlternate = (
      sources: readonly UtilitySource[],
      demand: number,
      assigned?: UtilityAssignment,
    ) =>
      candidatesFor(
        sources.filter(
          (source) => source.object.id !== assigned?.source.object.id,
        ),
        rackCells,
        demand,
        true,
      ).length > 0;
    const powerRedundant = hasAlternate(power, unit.mw, primary.power);
    const coolingRedundant = hasAlternate(cooling, unit.mw, primary.cooling);
    const networkRedundant = hasAlternate(
      network,
      unit.networkGbps,
      primary.network,
    );
    const points =
      Number(powerRedundant) +
      Number(coolingRedundant) +
      Number(networkRedundant);
    redundancyPoints += points;
    if (points === 3) analysis.redundantRackUnitIds.push(unit.unitId);
  }
  analysis.redundancyScore =
    analysis.operationalRackUnitIds.length > 0
      ? clamp01(redundancyPoints / (analysis.operationalRackUnitIds.length * 3))
      : deliveredRacks.length > 0
        ? 0
        : 1;
  const utilityObjects = relevantObjects.filter(
    (object) => object.kind !== "rack",
  );
  const availableUtilityRatio =
    utilityObjects.length > 0
      ? utilityObjects.filter(
          (object) => (object.repairDaysRemaining ?? 0) <= 0,
        ).length / utilityObjects.length
      : 1;
  analysis.maintenanceScore = clamp01(
    analysis.accessScore * 0.55 +
      analysis.aisleScore * 0.3 +
      availableUtilityRatio * 0.15,
  );
  const maxUtilization = Math.max(
    analysis.powerUtilization,
    analysis.coolingUtilization,
    analysis.networkUtilization,
  );
  const saturationScore = clamp01(1 - Math.max(0, maxUtilization - 0.7) * 0.6);
  analysis.environmentScore = clamp01(
    analysis.coolingScore * 0.35 +
      analysis.airflowScore * 0.25 +
      analysis.aisleScore * 0.15 +
      analysis.accessScore * 0.15 +
      saturationScore * 0.1,
  );
  const performanceScore = clamp01(
    analysis.environmentScore * 0.55 +
      analysis.maintenanceScore * 0.25 +
      saturationScore * 0.2,
  );
  analysis.throughputMultiplier = 0.62 + 0.38 * performanceScore;
  analysis.pueMultiplier =
    1 +
    0.35 * (1 - analysis.environmentScore) +
    0.1 * Math.max(0, analysis.coolingUtilization - 0.7) +
    0.05 * (1 - analysis.maintenanceScore);
  analysis.incidentRiskMultiplier =
    1 +
    1.6 * (1 - analysis.maintenanceScore) +
    1.2 * (1 - analysis.redundancyScore) +
    1.4 * Math.max(0, maxUtilization - 0.85) +
    0.8 * (1 - analysis.coolingScore);

  const addUtilizationBottleneck = (kind: UtilityKind, value: number) => {
    if (value <= 0.85) return;
    const severity = value > 1 ? ("critical" as const) : ("warning" as const);
    const message = `${kind[0]!.toUpperCase()}${kind.slice(1)} is at ${Math.round(value * 100)}% of reachable capacity.`;
    analysis.bottlenecks.push({ kind, severity, message, utilization: value });
    analysis.warnings.push(message);
  };
  addUtilizationBottleneck("power", analysis.powerUtilization);
  addUtilizationBottleneck("cooling", analysis.coolingUtilization);
  addUtilizationBottleneck("network", analysis.networkUtilization);
  if (analysis.coolingScore < 0.999)
    analysis.warnings.push(
      "Some installed heat load is outside reachable local cooling capacity.",
    );
  if (analysis.airflowScore < 0.8) {
    const message = "Hot/cold aisle clearance is reducing throughput.";
    analysis.warnings.push(message);
    analysis.bottlenecks.push({
      kind: "airflow",
      severity: analysis.airflowScore < 0.5 ? "critical" : "warning",
      message,
    });
  }
  if (analysis.aisleScore < 0.8)
    analysis.warnings.push("Service aisle access is below target.");
  if (analysis.inaccessibleObjectIds.length > 0) {
    const message = `${analysis.inaccessibleObjectIds.length} object(s) cannot be reached from the exterior service entrance.`;
    analysis.warnings.push(message);
    analysis.bottlenecks.push({
      kind: "access",
      severity: "critical",
      message,
    });
  }
  const repairing = utilityObjects.filter(
    (object) => (object.repairDaysRemaining ?? 0) > 0,
  );
  if (repairing.length > 0) {
    const message = `${repairing.length} utility unit(s) are unavailable during repair.`;
    analysis.warnings.push(message);
    analysis.bottlenecks.push({
      kind: "maintenance",
      severity: "warning",
      message,
    });
  }
  if (analysis.redundancyScore < 0.999 && deliveredRacks.length > 0)
    analysis.warnings.push("Utility redundancy is below N+1 target.");
  if (analysis.offlineRackUnitIds.length)
    analysis.warnings.push(
      `${analysis.offlineRackUnitIds.length} delivered rack(s) lack reachable power, cooling, network, or service access.`,
    );
  analysis.hardErrors = [...new Set(analysis.hardErrors)];
  analysis.warnings = [...new Set(analysis.warnings)];
  analysis.valid = analysis.hardErrors.length === 0;
  return analysis;
}

function utilityPlacement(
  id: string,
  catalogId: string,
  x: number,
  z: number,
  purchasePrice = 0,
): DataHallObjectPlacement {
  const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === catalogId)!;
  return { id, kind: def.kind, catalogId, x, z, rotation: 0, purchasePrice };
}

export function createDefaultHallLayout(
  facilityId: string,
  shellId: DataHallShellId,
  inventory: readonly HallRackUnit[],
  rackCapacity: number,
): DataHallLayout {
  const shell = DATA_HALL_SHELLS[shellId];
  const delivered = inventory.filter((unit) => unit.delivered);
  const totalMw = delivered.reduce((sum, unit) => sum + unit.mw, 0);
  const totalNetwork = delivered.reduce(
    (sum, unit) => sum + unit.networkGbps,
    0,
  );
  const powerCount = Math.max(1, Math.ceil(totalMw / 5));
  const networkCount = Math.max(1, Math.ceil(totalNetwork / 25_600));
  const coolingCount = Math.max(1, Math.ceil(totalMw / 2));
  const objects: DataHallObjectPlacement[] = [];
  for (let index = 0; index < powerCount; index += 1)
    objects.push(
      utilityPlacement(
        `${facilityId}:power:${index + 1}`,
        "ups-5mw",
        2 + index * 8,
        2,
      ),
    );
  for (let index = 0; index < networkCount; index += 1)
    objects.push(
      utilityPlacement(
        `${facilityId}:network:${index + 1}`,
        "core-25t",
        shell.width - 8 - index * 6,
        2,
      ),
    );
  const coolingDefinition = HALL_EQUIPMENT_CATALOG.find(
    (entry) => entry.id === "crac-2mw",
  )!;
  for (let index = 0; index < coolingCount; index += 1) {
    // Distribute local cooling through the white space instead of treating it
    // as a global pool at one end of the building.
    const centerX = ((index + 0.5) * shell.width) / coolingCount;
    const x = Math.max(
      2,
      Math.min(
        shell.width - coolingDefinition.width - 2,
        Math.round(centerX - coolingDefinition.width / 2),
      ),
    );
    const z = Math.max(
      2,
      Math.min(
        shell.depth - coolingDefinition.depth - 2,
        Math.round(shell.depth / 2 - coolingDefinition.depth / 2),
      ),
    );
    objects.push(
      utilityPlacement(`${facilityId}:cooling:${index + 1}`, "crac-2mw", x, z),
    );
  }
  const layout: DataHallLayout = {
    version: 2,
    facilityId,
    shellId,
    revision: 0,
    autoPlaceDeliveries: true,
    preferredStrategy: "efficiency",
    objects,
    walls: [],
    doors: [],
    analysis: emptyAnalysis(0),
  };
  if (delivered.length === 0) return layout;
  const planned = autoPlanHall(
    layout,
    inventory.filter((unit) => unit.delivered),
    "efficiency",
    rackCapacity,
  );
  return {
    ...planned,
    analysis: analyzeHallLayout(planned, inventory, rackCapacity),
  };
}

/**
 * Claim a newly started shell without granting installed infrastructure.
 * Future halls enter the editor as genuinely empty space; the default-layout
 * constructor remains reserved for completed legacy saves that need their
 * historical compute preserved.
 */
export function createEmptyHallLayout(
  facilityId: string,
  shellId: DataHallShellId,
  _rackCapacity = Number.MAX_SAFE_INTEGER,
): DataHallLayout {
  const layout: DataHallLayout = {
    version: 2,
    facilityId,
    shellId,
    revision: 0,
    autoPlaceDeliveries: true,
    preferredStrategy: "efficiency",
    objects: [],
    walls: [],
    doors: [],
    analysis: emptyAnalysis(0),
  };
  // An empty shell has no placements or topology to validate. Avoid allocating
  // shell-sized occupancy/routing buffers for every claimed future hall.
  return layout;
}

interface HallUtilityAnchor {
  centerX: number;
  centerZ: number;
  /** Worst-case Manhattan distance from the anchor to its assigned zone edge. */
  coverageRadius: number;
}

function distributedUtilityAnchors(
  shell: DataHallShellTemplate,
  count: number,
): HallUtilityAnchor[] {
  if (count <= 0) return [];
  const aspect = shell.width / Math.max(1, shell.depth);
  const rows = Math.max(
    1,
    Math.min(count, Math.round(Math.sqrt(count / Math.max(0.25, aspect)))),
  );
  const basePerRow = Math.floor(count / rows);
  const extra = count % rows;
  const anchors: HallUtilityAnchor[] = [];
  for (let row = 0; row < rows; row += 1) {
    const columns = basePerRow + (row < extra ? 1 : 0);
    const zoneWidth = shell.width / Math.max(1, columns);
    const zoneDepth = shell.depth / rows;
    for (let column = 0; column < columns; column += 1)
      anchors.push({
        centerX: (column + 0.5) * zoneWidth,
        centerZ: (row + 0.5) * zoneDepth,
        coverageRadius: zoneWidth / 2 + zoneDepth / 2,
      });
  }
  return anchors;
}

function placeUtilityNearAnchor(
  layout: DataHallLayout,
  utilities: readonly DataHallObjectPlacement[],
  occupied: Uint8Array,
  definition: HallEquipmentDef,
  id: string,
  anchor: HallUtilityAnchor,
  rackCapacity: number,
): DataHallObjectPlacement | undefined {
  const shell = DATA_HALL_SHELLS[layout.shellId];
  const candidates: Array<{ x: number; z: number; distance: number }> = [];
  for (let z = 2; z + definition.depth < shell.depth - 2; z += 2)
    for (let x = 2; x + definition.width < shell.width - 2; x += 2)
      candidates.push({
        x,
        z,
        distance:
          Math.abs(x + definition.width / 2 - anchor.centerX) +
          Math.abs(z + definition.depth / 2 - anchor.centerZ),
      });
  candidates.sort(
    (a, b) => a.distance - b.distance || a.z - b.z || a.x - b.x,
  );
  for (const candidate of candidates) {
    const placement = utilityPlacement(
      id,
      definition.id,
      candidate.x,
      candidate.z,
      definition.price,
    );
    const cells = rectCells(shell, placement);
    if (cells.some((cell) => occupied[cell])) continue;
    if (
      previewHallObjectPlacement(
        { ...layout, objects: [...utilities] },
        placement,
        rackCapacity,
      ) === "invalid"
    )
      continue;
    cells.forEach((cell) => {
      occupied[cell] = 1;
    });
    return placement;
  }
  return undefined;
}

export function autoPlanHall(
  layout: DataHallLayout,
  inventory: readonly HallRackUnit[],
  strategy: HallAutoLayoutStrategy,
  rackCapacity = Number.MAX_SAFE_INTEGER,
  options: { provisionUtilities?: boolean } = {},
): DataHallLayout {
  const shell = DATA_HALL_SHELLS[layout.shellId];
  const savedReservations =
    strategy === layout.preferredStrategy
      ? layout.objects.filter(
          (object) => object.kind === "rack" && object.reserved,
        )
      : [];
  const utilities = layout.objects.filter(
    (object) => object.kind !== "rack" && !object.id.includes(":auto-plan:"),
  );
  if (options.provisionUtilities) {
    const delivered = inventory.filter((unit) => unit.delivered);
    const reserve =
      strategy === "resilience"
        ? 1.35
        : strategy === "efficiency"
          ? 1.15
          : 1.05;
    // Utility density follows the concrete rack inventory being planned, not
    // a shell's historical bay rating. The square-root term distributes
    // service anchors as the physical footprint grows without imposing a
    // separate admission ceiling.
    const scale = Math.max(1, Math.ceil(Math.sqrt(delivered.length) / 5));
    const targetMw =
      delivered.reduce((sum, unit) => sum + unit.mw, 0) * reserve;
    const targetNetwork =
      delivered.reduce((sum, unit) => sum + unit.networkGbps, 0) * reserve;
    const targets = [
      {
        kind: "power" as const,
        catalogId: "ups-5mw",
        minimum: scale + (strategy === "resilience" ? Math.ceil(scale / 2) : 0),
        capacity: targetMw,
        field: "powerMw" as const,
      },
      {
        kind: "cooling" as const,
        catalogId: "crac-2mw",
        minimum: scale + (strategy === "resilience" ? Math.ceil(scale / 2) : 0),
        capacity: targetMw,
        field: "coolingMw" as const,
      },
      {
        kind: "network" as const,
        catalogId: "core-25t",
        minimum:
          Math.max(scale, Math.ceil(targetNetwork / 25_600)) +
          (strategy === "resilience" ? 1 : 0),
        capacity: targetNetwork,
        field: "networkGbps" as const,
      },
    ];
    const occupied = new Uint8Array(shell.width * shell.depth);
    for (const object of utilities)
      for (const cell of rectCells(shell, object))
        if (cell >= 0 && cell < occupied.length) occupied[cell] = 1;
    const usedIds = new Set(utilities.map((object) => object.id));
    for (const target of targets) {
      const definition = HALL_EQUIPMENT_CATALOG.find(
        (entry) => entry.id === target.catalogId,
      )!;
      let count = utilities.filter(
        (object) => object.kind === target.kind,
      ).length;
      let capacity = utilities
        .filter((object) => object.kind === target.kind)
        .reduce(
          (sum, object) =>
            sum +
            (HALL_EQUIPMENT_CATALOG.find(
              (entry) => entry.id === object.catalogId,
            )?.[target.field] ?? 0),
          0,
        );
      let sequence = 1;
      const nextId = () => {
        while (
          usedIds.has(
            `${layout.facilityId}:auto-plan:${target.kind}:${sequence}`,
          )
        )
          sequence += 1;
        return `${layout.facilityId}:auto-plan:${target.kind}:${sequence++}`;
      };
      if (target.kind === "cooling") {
        const unitCapacity = definition[target.field] ?? 0;
        const capacityCount =
          unitCapacity > 0
            ? count +
              Math.ceil(Math.max(0, target.capacity - capacity) / unitCapacity)
            : count;
        const anchors = distributedUtilityAnchors(
          shell,
          Math.max(target.minimum, capacityCount),
        );
        const unmatched = new Set(anchors.map((_, index) => index));
        for (const object of utilities.filter(
          (candidate) => candidate.kind === "cooling",
        )) {
          const objectDefinition = HALL_EQUIPMENT_CATALOG.find(
            (entry) => entry.id === object.catalogId,
          );
          const serviceRange = objectDefinition?.maxServiceDistanceCells;
          if (serviceRange === undefined) continue;
          const size = dims(object);
          const centerX = object.x + size.width / 2;
          const centerZ = object.z + size.depth / 2;
          const match = [...unmatched]
            .map((index) => ({
              index,
              distance:
                Math.abs(centerX - anchors[index]!.centerX) +
                Math.abs(centerZ - anchors[index]!.centerZ),
            }))
            .filter(
              ({ index, distance }) =>
                distance + anchors[index]!.coverageRadius <= serviceRange,
            )
            .sort((a, b) => a.distance - b.distance || a.index - b.index)[0];
          if (match) unmatched.delete(match.index);
        }
        for (const index of unmatched) {
          const id = nextId();
          const placed = placeUtilityNearAnchor(
            layout,
            utilities,
            occupied,
            definition,
            id,
            anchors[index]!,
            rackCapacity,
          );
          if (!placed) continue;
          utilities.push(placed);
          usedIds.add(id);
          count += 1;
          capacity += definition[target.field] ?? 0;
        }
      }
      while (count < target.minimum || capacity + 1e-9 < target.capacity) {
        const id = nextId();
        let placed: DataHallObjectPlacement | undefined;
        for (
          let z = 2;
          z + definition.depth < shell.depth - 2 && !placed;
          z += 2
        ) {
          for (let x = 2; x + definition.width < shell.width - 2; x += 2) {
            const candidate = utilityPlacement(
              id,
              target.catalogId,
              x,
              z,
              definition.price,
            );
            const cells = rectCells(shell, candidate);
            if (cells.some((cell) => occupied[cell])) continue;
            if (
              previewHallObjectPlacement(
                { ...layout, objects: utilities },
                candidate,
                rackCapacity,
              ) === "invalid"
            )
              continue;
            placed = candidate;
            cells.forEach((cell) => {
              occupied[cell] = 1;
            });
            break;
          }
        }
        if (!placed) break;
        utilities.push(placed);
        usedIds.add(id);
        count += 1;
        capacity += definition[target.field] ?? 0;
      }
    }
  }
  const occupied = new Uint8Array(shell.width * shell.depth);
  for (const object of utilities) {
    for (const cell of rectCells(shell, object))
      if (cell >= 0 && cell < occupied.length) occupied[cell] = 1;
    if (options.provisionUtilities) {
      const size = dims(object);
      for (
        let z = Math.max(0, object.z - 1);
        z < Math.min(shell.depth, object.z + size.depth + 1);
        z += 1
      )
        for (
          let x = Math.max(0, object.x - 1);
          x < Math.min(shell.width, object.x + size.width + 1);
          x += 1
        )
          occupied[z * shell.width + x] = 1;
    }
  }
  const spacing =
    strategy === "density" ? 1 : strategy === "efficiency" ? 2 : 3;
  const rowGap = strategy === "density" ? 2 : strategy === "efficiency" ? 5 : 7;
  const scoreUnit = (unit: HallRackUnit): number => {
    const pf = unit.flopsPf ?? 0;
    if (strategy === "density") return pf / Math.max(1, unit.rackUnits ?? 1);
    if (strategy === "resilience") return pf / Math.max(1, unit.price ?? 1);
    return pf / Math.max(1e-9, unit.mw);
  };
  const rankedUnits = inventory
    .filter((unit) => unit.delivered)
    .sort(
      (a, b) =>
        scoreUnit(b) - scoreUnit(a) ||
        (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0),
  );
  const units = rankedUnits;
  const selectedUnitIds = new Set(units.map((unit) => unit.unitId));
  const preserveInstalled =
    !options.provisionUtilities && strategy === layout.preferredStrategy;
  const racks: DataHallObjectPlacement[] = preserveInstalled
    ? layout.objects.filter(
        (object) =>
          object.kind === "rack" &&
          !object.reserved &&
          object.rackUnitId &&
          selectedUnitIds.has(object.rackUnitId),
      )
    : [];
  for (const rack of racks) {
    for (const cell of rectCells(shell, rack))
      if (cell >= 0 && cell < occupied.length) occupied[cell] = 1;
  }
  const assignedUnitIds = new Set(
    racks.flatMap((rack) => (rack.rackUnitId ? [rack.rackUnitId] : [])),
  );
  const pendingUnits = units.filter(
    (unit) => !assignedUnitIds.has(unit.unitId),
  );
  const consumedReservations = new Set<string>();

  if (preserveInstalled) {
    for (const unit of pendingUnits.slice()) {
      const saved = savedReservations.find(
        (reservation) => !consumedReservations.has(reservation.id),
      );
      if (!saved) break;
      consumedReservations.add(saved.id);
      const rack: DataHallObjectPlacement = {
        ...saved,
        id: `rack:${unit.unitId}`,
        catalogId: unit.skuId,
        rackUnitId: unit.unitId,
        reserved: undefined,
        purchasePrice: 0,
      };
      if (
        previewHallObjectPlacement(
          { ...layout, objects: [...utilities, ...racks] },
          rack,
          rackCapacity,
        ) === "invalid"
      )
        continue;
      for (const cell of rectCells(shell, rack)) occupied[cell] = 1;
      racks.push(rack);
      assignedUnitIds.add(unit.unitId);
    }
  }
  const overflowUnits = pendingUnits.filter(
    (unit) => !assignedUnitIds.has(unit.unitId),
  );
  let cursor = 0;
  for (
    let z = 10;
    z + 5 < shell.depth && cursor < overflowUnits.length;
    z += 5 + rowGap
  ) {
    for (
      let x = 8;
      x + 3 < shell.width && cursor < overflowUnits.length;
      x += 3 + spacing
    ) {
      const rack: DataHallObjectPlacement = {
        id: `rack:${overflowUnits[cursor]!.unitId}`,
        kind: "rack",
        catalogId: overflowUnits[cursor]!.skuId,
        rackUnitId: overflowUnits[cursor]!.unitId,
        x,
        z,
        rotation: z % 2 === 0 ? 0 : 180,
        purchasePrice: 0,
      };
      const cells = rectCells(shell, rack);
      if (cells.some((cell) => occupied[cell])) continue;
      if (
        previewHallObjectPlacement(
          { ...layout, objects: [...utilities, ...racks] },
          rack,
          rackCapacity,
        ) === "invalid"
      )
        continue;
      cells.forEach((cell) => {
        occupied[cell] = 1;
      });
      racks.push(rack);
      cursor += 1;
    }
  }
  // Utilities or wide-aisle patterns can consume some preferred row slots.
  // Finish the rated plan with deterministic first-fit spaces rather than
  // silently leaving a partially planned hall.
  for (
    let z = 7;
    z + 5 < shell.depth && cursor < overflowUnits.length;
    z += 1
  ) {
    for (
      let x = 4;
      x + 3 < shell.width && cursor < overflowUnits.length;
      x += 1
    ) {
      const rack: DataHallObjectPlacement = {
        id: `rack:${overflowUnits[cursor]!.unitId}`,
        kind: "rack",
        catalogId: overflowUnits[cursor]!.skuId,
        rackUnitId: overflowUnits[cursor]!.unitId,
        x,
        z,
        rotation: 0,
        purchasePrice: 0,
      };
      const cells = rectCells(shell, rack);
      if (cells.some((cell) => occupied[cell])) continue;
      if (
        previewHallObjectPlacement(
          { ...layout, objects: [...utilities, ...racks] },
          rack,
          rackCapacity,
        ) === "invalid"
      )
        continue;
      cells.forEach((cell) => {
        occupied[cell] = 1;
      });
      racks.push(rack);
      cursor += 1;
    }
  }
  // A saved capacity plan remains useful as inventory arrives. Actual racks
  // are placed first so they replace matching planned cabinets; only
  // collision-valid unused reservations are restored around them.
  const usedIds = new Set([...utilities, ...racks].map((object) => object.id));
  for (const saved of savedReservations) {
    if (
      consumedReservations.has(saved.id) ||
      usedIds.has(saved.id)
    )
      continue;
    const reservation: DataHallObjectPlacement = {
      ...saved,
      rackUnitId: undefined,
      reserved: true,
    };
    if (
      previewHallObjectPlacement(
        { ...layout, objects: [...utilities, ...racks] },
        reservation,
        rackCapacity,
      ) === "invalid"
    )
      continue;
    racks.push(reservation);
    usedIds.add(reservation.id);
  }
  let coveredRacks = racks;
  if (options.provisionUtilities) {
    const proposed: DataHallLayout = {
      ...layout,
      preferredStrategy: strategy,
      objects: [...utilities, ...racks],
      analysis: emptyAnalysis(layout.revision),
    };
    const coverage = analyzeHallLayout(proposed, units, rackCapacity);
    if (coverage.offlineRackUnitIds.length > 0) {
      // Never advertise an auto-plan as usable when topology cannot serve it.
      // Uncovered delivered units remain staged for a later manual expansion.
      const offline = new Set(coverage.offlineRackUnitIds);
      coveredRacks = racks.filter(
        (rack) => !rack.rackUnitId || !offline.has(rack.rackUnitId),
      );
    }
  }
  return {
    ...layout,
    preferredStrategy: strategy,
    objects: [...utilities, ...coveredRacks],
    analysis: emptyAnalysis(layout.revision),
  };
}

export function migrateLegacyRackLayout(
  facilityId: string,
  shellId: DataHallShellId,
  inventory: readonly HallRackUnit[],
  rackCapacity: number,
): DataHallLayout {
  return createDefaultHallLayout(facilityId, shellId, inventory, rackCapacity);
}

/**
 * Append-only utility top-up: add the power, network, and cooling equipment a
 * hall needs to bring every inventoried rack unit online, without moving any
 * existing object. Returns the updated layout, the objects added, and their
 * total catalog price.
 */
export function provisionHallUtilities<
  T extends Pick<
    DataHallLayout,
    "facilityId" | "shellId" | "objects" | "walls" | "doors"
  >,
>(
  layout: T,
  inventory: readonly HallRackUnit[],
  rackCapacity = Number.MAX_SAFE_INTEGER,
): { layout: T; added: DataHallObjectPlacement[]; cost: number } {
  const shell = DATA_HALL_SHELLS[layout.shellId];
  const units = [...inventory];
  const demandMw = units.reduce((sum, unit) => sum + unit.mw, 0);
  const demandNetwork = units.reduce((sum, unit) => sum + unit.networkGbps, 0);
  const objects = [...layout.objects];
  const occupied = new Uint8Array(shell.width * shell.depth);
  for (const object of objects)
    for (const cell of rectCells(shell, object))
      if (cell >= 0 && cell < occupied.length) occupied[cell] = 1;
  const catalogEntry = (object: DataHallObjectPlacement) =>
    HALL_EQUIPMENT_CATALOG.find(
      (entry) => entry.id === object.catalogId && entry.kind === object.kind,
    );
  const capacityOf = (
    kind: "power" | "cooling" | "network",
    field: "powerMw" | "coolingMw" | "networkGbps",
  ) =>
    objects
      .filter((object) => object.kind === kind)
      .reduce((sum, object) => sum + (catalogEntry(object)?.[field] ?? 0), 0);
  const targets = [
    {
      kind: "power" as const,
      catalogId: "ups-5mw",
      capacity: demandMw,
      field: "powerMw" as const,
    },
    {
      kind: "cooling" as const,
      catalogId: "crac-2mw",
      capacity: demandMw,
      field: "coolingMw" as const,
    },
    {
      kind: "network" as const,
      catalogId: "core-25t",
      capacity: demandNetwork,
      field: "networkGbps" as const,
    },
  ];
  const usedIds = new Set(objects.map((object) => object.id));
  const added: DataHallObjectPlacement[] = [];
  let cost = 0;
  for (const target of targets) {
    let capacity = capacityOf(target.kind, target.field);
    let sequence = 1;
    while (capacity + 1e-9 < target.capacity) {
      const definition = HALL_EQUIPMENT_CATALOG.find(
        (entry) => entry.id === target.catalogId,
      )!;
      let id = `${layout.facilityId}:provision:${target.kind}:${sequence++}`;
      while (usedIds.has(id))
        id = `${layout.facilityId}:provision:${target.kind}:${sequence++}`;
      let placed: DataHallObjectPlacement | undefined;
      for (
        let z = 2;
        z + definition.depth <= shell.depth - 2 && !placed;
        z += 2
      ) {
        for (
          let x = 2;
          x + definition.width <= shell.width - 2 && !placed;
          x += 2
        ) {
          const candidate = utilityPlacement(
            id,
            target.catalogId,
            x,
            z,
            definition.price,
          );
          const cells = rectCells(shell, candidate);
          if (cells.some((cell) => occupied[cell])) continue;
          if (
            previewHallObjectPlacement(
              { ...layout, objects },
              candidate,
              rackCapacity,
            ) === "invalid"
          )
            continue;
          placed = candidate;
          cells.forEach((cell) => {
            occupied[cell] = 1;
          });
          break;
        }
      }
      if (!placed) break;
      objects.push(placed);
      added.push(placed);
      usedIds.add(id);
      cost += definition.price;
      capacity += definition[target.field] ?? 0;
    }
  }
  return { layout: { ...layout, objects }, added, cost };
}

function normalizeFleet(fleet: RackInstall[]): RackInstall[] {
  return fleet.map(ensureRackUnitIds);
}

function objectFitsShell(
  object: DataHallObjectPlacement,
  shell: DataHallShellTemplate,
): boolean {
  const size = dims(object);
  if (
    object.x < 0 ||
    object.z < 0 ||
    object.x + size.width > shell.width ||
    object.z + size.depth > shell.depth
  )
    return false;
  const door = shell.exteriorDoor;
  return !(
    object.x < door.x + door.width &&
    object.x + size.width > door.x &&
    object.z < door.clearance
  );
}

function wallFitsShell(
  wall: DataHallWallSegment,
  shell: DataHallShellTemplate,
): boolean {
  return (
    wall.x1 >= 0 &&
    wall.x2 >= 0 &&
    wall.z1 >= 0 &&
    wall.z2 >= 0 &&
    wall.x1 <= shell.width &&
    wall.x2 <= shell.width &&
    wall.z1 <= shell.depth &&
    wall.z2 <= shell.depth
  );
}

/**
 * Old saves used physically larger v1 shells under the same IDs. Preserve the
 * old template whenever shrinking would invalidate a live or in-construction
 * placement. This migration changes only the template ID; it never moves or
 * drops player-authored geometry.
 */
function migratedShellIdForLayout(layout: DataHallLayout): DataHallShellId {
  const legacyShellId = LEGACY_SHELL_FOR_COMPACT[layout.shellId];
  if (!legacyShellId) return layout.shellId;
  const compact = DATA_HALL_SHELLS[layout.shellId];
  const liveFits =
    layout.objects.every((object) => objectFitsShell(object, compact)) &&
    layout.walls.every((wall) => wallFitsShell(wall, compact));
  const project = layout.constructionProject;
  const targetFits =
    !project ||
    (project.targetObjects.every((object) => objectFitsShell(object, compact)) &&
      project.targetWalls.every((wall) => wallFitsShell(wall, compact)));
  return liveFits && targetFits ? layout.shellId : legacyShellId;
}

export function migrateDataHallLayouts(state: SimState): SimState {
  const halls = facilityAnchorTiles(state).filter(
    (tile) => isDcKind(tile.kind) && isDcAnchor(tile),
  );
  const fleetsNormalized =
    (state.player.rackFleet ?? []).every(
      (install) => install.unitIds?.length === install.count,
    ) &&
    state.rivals.every((rival) =>
      (rival.rackFleet ?? []).every(
        (install) => install.unitIds?.length === install.count,
      ),
    );
  const layoutsComplete = halls.every((hall) =>
    Boolean(
      state.dataHallLayouts?.[hall.campusId ?? `facility:${hall.x},${hall.y}`],
    ),
  );
  const layoutsNormalized = Object.values(state.dataHallLayouts ?? {}).every(
    (layout) => {
      const project = layout.constructionProject;
      return (
        (layout as { version?: number }).version === 2 &&
        migratedShellIdForLayout(layout) === layout.shellId &&
        (!project || Boolean(normalizeHallConstructionProject(project)))
      );
    },
  );
  if (fleetsNormalized && layoutsComplete && layoutsNormalized) return state;
  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      rackFleet: normalizeFleet(state.player.rackFleet ?? []),
    },
    rivals: state.rivals.map((rival) => ({
      ...rival,
      rackFleet: normalizeFleet(rival.rackFleet ?? []),
    })),
  };
  const layouts = Object.fromEntries(
    Object.entries(state.dataHallLayouts ?? {}).map(([facilityId, layout]) => {
      const constructionProject = normalizeHallConstructionProject(
        layout.constructionProject,
      );
      return [
        facilityId,
        {
          ...layout,
          shellId: migratedShellIdForLayout(layout),
          version: 2 as const,
          ...(constructionProject
            ? { constructionProject }
            : { constructionProject: undefined }),
        },
      ];
    }),
  );
  for (const hall of halls) {
    const facilityId = hall.campusId ?? `facility:${hall.x},${hall.y}`;
    if (layouts[facilityId]) continue;
    const ownerId = hall.owner as LabId;
    const fleet =
      ownerId === next.playerLabId
        ? next.player.rackFleet
        : (next.rivals.find((rival) => rival.id === ownerId)?.rackFleet ?? []);
    const withFacility = fleet.map((install) =>
      install.x === hall.x && install.y === hall.y && !install.facilityId
        ? { ...install, facilityId }
        : install,
    );
    if (ownerId === next.playerLabId)
      next = { ...next, player: { ...next.player, rackFleet: withFacility } };
    else
      next = {
        ...next,
        rivals: next.rivals.map((rival) =>
          rival.id === ownerId ? { ...rival, rackFleet: withFacility } : rival,
        ),
      };
    const shellId = shellIdForSize(hall.dcSize);
    const underConstruction =
      hall.buildingTarget > 0 && hall.buildingProgress < hall.buildingTarget;
    if (underConstruction) {
      // Daily migration sees every normally placed player/rival hall while its
      // shell is being built. Persisting the empty layout now prevents that
      // future completed hall from ever entering the legacy free-fitout path.
      layouts[facilityId] = createEmptyHallLayout(
        facilityId,
        shellId,
        hall.rackCapacity,
      );
    } else {
      const inventory = rackUnitsForFacility(
        next,
        facilityId,
        ownerId,
        hall,
      );
      layouts[facilityId] = migrateLegacyRackLayout(
        facilityId,
        shellId,
        inventory,
        hall.rackCapacity,
      );
    }
  }
  return { ...next, dataHallLayouts: layouts };
}

/**
 * Compatibility entry point retained for older callers. Legacy campaigns
 * without any hall layout receive one explicit baseline migration above;
 * existing layouts are never populated with free racks or utility equipment.
 */
export function repairHallLayouts(state: SimState): SimState {
  return migrateDataHallLayouts(state);
}

export function tickDataHallLayouts(state: SimState): SimState {
  let next = migrateDataHallLayouts(state);
  for (const hall of facilityAnchorTiles(next).filter(
    (tile) => isDcKind(tile.kind) && isDcAnchor(tile),
  )) {
    const facilityId = hall.campusId ?? `facility:${hall.x},${hall.y}`;
    const layout = next.dataHallLayouts?.[facilityId];
    if (!layout) continue;
    const inventory = rackUnitsForFacility(
      next,
      facilityId,
      hall.owner,
      hall,
    );

    // The saved layout remains the live compute source for the full project.
    // Only the final commissioning tick swaps in the target atomically.
    if (layout.constructionProject) {
      const progress = advanceHallConstructionProject(
        layout.constructionProject,
      );
      if (!progress.complete) {
        next = {
          ...next,
          dataHallLayouts: {
            ...(next.dataHallLayouts ?? {}),
            [facilityId]: { ...layout, constructionProject: progress.project },
          },
        };
        continue;
      }
      const project = layout.constructionProject;
      const commissioned: DataHallLayout = {
        ...layout,
        revision: Math.max(layout.revision + 1, project.targetRevision),
        preferredStrategy: project.targetPreferredStrategy,
        objects: project.targetObjects.map((object) => ({ ...object })),
        walls: project.targetWalls.map((wall) => ({ ...wall })),
        doors: project.targetDoors.map((door) => ({ ...door })),
        constructionProject: undefined,
        analysis: emptyAnalysis(
          Math.max(layout.revision + 1, project.targetRevision),
        ),
      };
      commissioned.analysis = analyzeHallLayout(
        commissioned,
        inventory,
        hall.rackCapacity,
      );
      next = {
        ...next,
        dataHallLayouts: {
          ...(next.dataHallLayouts ?? {}),
          [facilityId]: commissioned,
        },
      };
      const salvageRefund = Math.max(0, -project.infrastructureCost);
      if (salvageRefund > 0 && hall.owner === next.playerLabId) {
        const cash = next.player.cash + salvageRefund;
        next = {
          ...next,
          player: {
            ...next.player,
            cash,
            finance: { ...next.player.finance, cash },
          },
          labs: next.labs[next.playerLabId]
            ? {
                ...next.labs,
                [next.playerLabId]: {
                  ...next.labs[next.playerLabId]!,
                  cash,
                  finance: { ...next.labs[next.playerLabId]!.finance, cash },
                },
              }
            : next.labs,
        };
      }
      if (hall.owner === next.playerLabId) {
        const offline = commissioned.analysis.offlineRackUnitIds.length;
        next = {
          ...next,
          alerts: [
            {
              id: `hall-commissioned-${project.id}`,
              day: next.day,
              severity: offline > 0 ? ("warn" as const) : ("info" as const),
              message:
                offline > 0
                  ? `${hall.name || "Data hall"} refit commissioned; ${offline} rack(s) remain offline pending utility capacity or delivery.`
                  : `${hall.name || "Data hall"} refit commissioned and is now live.`,
            },
            ...next.alerts,
          ].slice(0, 40),
        };
      }
      continue;
    }

    const delivered = inventory.filter((unit) => unit.delivered);
    const placed = new Set(
      layout.objects.flatMap((object) =>
        !object.reserved && object.rackUnitId ? [object.rackUnitId] : [],
      ),
    );
    const missing = delivered.some((unit) => !placed.has(unit.unitId));
    if (layout.autoPlaceDeliveries && missing) {
      const playerOwned = hall.owner === next.playerLabId;
      // Rival facility controllers retry a blocked/cash-poor fit-out monthly.
      // The topology and inventory are unchanged between those checkpoints,
      // so daily replanning only burns simulation time without changing the
      // decision. Player deliveries remain immediate and player-controlled.
      if (!playerOwned && (layout.autoPlaceRetryDay ?? 0) > next.day) continue;
      const deferRivalFitout = () => {
        if (playerOwned) return;
        next = {
          ...next,
          dataHallLayouts: {
            ...(next.dataHallLayouts ?? {}),
            [facilityId]: { ...layout, autoPlaceRetryDay: next.day + 30 },
          },
        };
      };
      const planned = autoPlanHall(
        layout,
        inventory,
        layout.preferredStrategy,
        hall.rackCapacity,
        // Rival controllers operate their own facilities, but they obey the
        // same physical/economic rules: utility additions are visible in the
        // ghost target, paid from cash, and commissioned over time. The player
        // never receives or buys an automatic utility top-up.
        { provisionUtilities: !playerOwned },
      );
      const gainsPlacement = planned.objects.some(
        (object) =>
          !object.reserved &&
          object.rackUnitId &&
          !placed.has(object.rackUnitId),
      );
      // If the selected strategy cannot fit any more racks, leave the excess
      // in staging without churning the layout revision on every tick.
      if (!gainsPlacement) {
        if (hall.owner === next.playerLabId) {
          const id = `rack-staging-${facilityId}-${layout.revision}`;
          if (!next.alerts.some((entry) => entry.id === id))
            next = {
              ...next,
              alerts: [
                {
                  id,
                  day: next.day,
                  severity: "warn" as const,
                  message: `Some delivered racks remain staged at ${hall.name || "a data hall"} because the saved auto-layout cannot place them.`,
                },
                ...next.alerts,
              ].slice(0, 40),
            };
        }
        deferRivalFitout();
        continue;
      }
      const target = {
        ...planned,
        preferredStrategy: layout.preferredStrategy,
      };
      const targetAnalysis = analyzeHallLayout(
        target,
        inventory,
        hall.rackCapacity,
      );
      if (!targetAnalysis.valid) {
        deferRivalFitout();
        continue;
      }
      const infrastructureCost = playerOwned
        ? 0
        : Math.max(0, quoteHallPlanNetCost(layout, target));
      if (!playerOwned && infrastructureCost > 0) {
        const rival = next.rivals.find((candidate) => candidate.id === hall.owner);
        const availableCash = rival?.cash ?? next.labs[hall.owner]?.cash ?? 0;
        // Cash-poor rivals leave the delivered hardware staged. Because the
        // rack remains missing, their controller retries this paid plan on a
        // later day instead of receiving infrastructure for free.
        if (!rival || availableCash + 1e-9 < infrastructureCost) {
          deferRivalFitout();
          continue;
        }
        const cash = availableCash - infrastructureCost;
        next = {
          ...next,
          rivals: next.rivals.map((candidate) =>
            candidate.id === hall.owner
              ? {
                  ...candidate,
                  cash,
                  finance: candidate.finance
                    ? { ...candidate.finance, cash }
                    : candidate.finance,
                }
              : candidate,
          ),
          labs: next.labs[hall.owner]
            ? {
                ...next.labs,
                [hall.owner]: {
                  ...next.labs[hall.owner]!,
                  cash,
                  finance: { ...next.labs[hall.owner]!.finance, cash },
                },
              }
            : next.labs,
        };
      }
      const project = createHallConstructionProject({
        id: seededId(
          "hall-install",
          next.seed,
          next.day,
          facilityId,
          layout.revision,
        ),
        startedDay: next.day,
        current: layout,
        target,
        targetRevision: layout.revision + 1,
        infrastructureCost,
        rackPurchaseCost: 0,
      });
      next = {
        ...next,
        dataHallLayouts: {
          ...(next.dataHallLayouts ?? {}),
          [facilityId]: {
            ...layout,
            autoPlaceRetryDay: undefined,
            constructionProject: project,
          },
        },
      };
      if (hall.owner === next.playerLabId)
        next = {
          ...next,
          alerts: [
            {
              id: `hall-install-started-${project.id}`,
              day: next.day,
              severity: "info" as const,
              message: `${hall.name || "Data hall"} started a ${project.totalDays}-day rack installation; delivered hardware remains staged until commissioning.`,
            },
            ...next.alerts,
          ].slice(0, 40),
        };
    }
  }
  return next;
}

/** Infrastructure cash delta for a draft. Racks are already paid inventory. */
export function quoteHallPlanNetCost(
  current: Pick<DataHallLayout, "objects" | "walls" | "doors">,
  candidate: Pick<DataHallLayout, "objects" | "walls" | "doors">,
): number {
  const objectKey = (object: DataHallObjectPlacement) =>
    `object:${object.kind}:${object.catalogId}:${object.id}`;
  const wallKey = (wall: DataHallWallSegment) =>
    `wall:${wall.id}:${wall.x1},${wall.z1}:${wall.x2},${wall.z2}`;
  const doorKey = (door: DataHallDoorPlacement) =>
    `door:${door.id}:${door.wallId}:${door.width}`;
  const keys = (layout: Pick<DataHallLayout, "objects" | "walls" | "doors">) =>
    new Set([
      ...layout.objects.map(objectKey),
      ...layout.walls.map(wallKey),
      ...layout.doors.map(doorKey),
    ]);
  const infrastructureValue = (
    layout: Pick<DataHallLayout, "objects" | "walls" | "doors">,
    excluded: Set<string>,
  ) =>
    layout.objects.reduce((sum, object) => {
      if (object.kind === "rack" || excluded.has(objectKey(object))) return sum;
      return (
        sum +
        (HALL_EQUIPMENT_CATALOG.find(
          (entry) =>
            entry.id === object.catalogId && entry.kind === object.kind,
        )?.price ?? 0)
      );
    }, 0) +
    layout.walls.reduce(
      (sum, wall) =>
        excluded.has(wallKey(wall))
          ? sum
          : sum +
            (Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1)) *
              HALL_WALL_PRICE_PER_CELL,
      0,
    ) +
    layout.doors.reduce(
      (sum, door) =>
        excluded.has(doorKey(door)) ? sum : sum + HALL_DOOR_PRICE,
      0,
    );
  const currentKeys = keys(current);
  const candidateKeys = keys(candidate);
  const added = infrastructureValue(candidate, currentKeys);
  const removed = infrastructureValue(current, candidateKeys);
  return added - Math.floor(removed * 0.5);
}

export interface HallRackPurchaseQuote {
  drafts: number;
  cost: number;
  provisionCost: number;
  total: number;
  /** Concrete cabinet footprints drawn in the target. */
  targetRackCabinets: number;
  /** Hardware-width represented by those concrete target footprints. */
  targetRackBays: number;
  /** Owned/inbound hardware not drawn in the target remains in staging. */
  stagedFleetRackBays: number;
}

interface HallRackPlacementSummary {
  targetRackCabinets: number;
  targetRackBays: number;
  stagedFleetRackBays: number;
}

function hallRackPlacementSummary(
  state: SimState,
  candidate: Pick<DataHallLayout, "facilityId" | "objects">,
  ownerId: LabId,
): HallRackPlacementSummary {
  const anchor = facilityAnchorTiles(state, { ownerId }).find(
    (tile) =>
      (tile.campusId ?? `facility:${tile.x},${tile.y}`) ===
      candidate.facilityId,
  );
  const representedUnitIds = new Set(
    candidate.objects.flatMap((object) =>
      object.kind === "rack" && object.rackUnitId ? [object.rackUnitId] : [],
    ),
  );
  const existingBayDemandByUnitId = new Map<string, number>();
  let stagedFleetRackBays = 0;
  for (const raw of ownerFleet(state, ownerId)) {
    const belongsToHall = raw.facilityId
      ? raw.facilityId === candidate.facilityId
      : Boolean(anchor && raw.x === anchor.x && raw.y === anchor.y);
    if (!belongsToHall || raw.count <= 0) continue;
    const install = ensureRackUnitIds(raw);
    const unitBayDemand = Math.max(1, Math.floor(install.rackUnits || 1));
    for (const unitId of install.unitIds ?? []) {
      existingBayDemandByUnitId.set(unitId, unitBayDemand);
      if (!representedUnitIds.has(unitId))
        stagedFleetRackBays += unitBayDemand;
    }
  }

  const designs = ownerDesigns(state, ownerId);
  const targetRackBays = candidate.objects.reduce((sum, object) => {
    if (object.kind !== "rack") return sum;
    const existingDemand = object.rackUnitId
      ? existingBayDemandByUnitId.get(object.rackUnitId)
      : undefined;
    if (existingDemand) return sum + existingDemand;
    try {
      return (
        sum +
        Math.max(
          1,
          Math.floor(resolveRackSku(object.catalogId, designs).rackUnits || 1),
        )
      );
    } catch {
      return sum + staticRackBayDemand(object.catalogId);
    }
  }, 0);
  return {
    targetRackCabinets: candidate.objects.filter(
      (object) => object.kind === "rack",
    ).length,
    targetRackBays,
    stagedFleetRackBays,
  };
}

/** Price pending rack purchases. Utility equipment must be placed explicitly. */
export function quoteHallRackPurchases(
  state: SimState,
  candidate: Pick<
    DataHallLayout,
    "facilityId" | "shellId" | "objects" | "walls" | "doors"
  >,
  _legacyHall?: Pick<MapTile, "rackCapacity">,
): HallRackPurchaseQuote {
  const discount =
    aggregateEffects(state.player.researchUnlocked, state.player.researchRanks).chipDiscount ?? 0;
  let cost = 0;
  let drafts = 0;
  for (const object of candidate.objects) {
    if (object.kind !== "rack" || object.reserved || object.rackUnitId)
      continue;
    let sku;
    try {
      sku = resolveRackSku(object.catalogId, state.player.rackDesigns ?? []);
    } catch {
      continue;
    }
    cost += quoteRackOrder(sku, 1, { discount }).unitPrice;
    drafts += 1;
  }
  const placement = hallRackPlacementSummary(
    state,
    candidate,
    state.playerLabId,
  );
  return { drafts, cost, provisionCost: 0, total: cost, ...placement };
}

export function applyHallPlan(
  state: SimState,
  plan: DataHallEditPlan,
  ownerId: LabId = state.playerLabId,
): { state: SimState; ok: boolean; error?: string; netCost: number } {
  const current = state.dataHallLayouts?.[plan.facilityId];
  if (!current)
    return {
      state,
      ok: false,
      error: "Data hall layout was not found.",
      netCost: 0,
    };
  if (current.constructionProject)
    return {
      state,
      ok: false,
      error: "This hall already has an active construction project.",
      netCost: 0,
    };
  if (current.revision !== plan.expectedRevision)
    return {
      state,
      ok: false,
      error: "The hall changed while this plan was open. Reload the editor.",
      netCost: 0,
    };
  const hall = facilityAnchorTiles(state).find(
    (tile) =>
      (tile.campusId ?? `facility:${tile.x},${tile.y}`) === plan.facilityId,
  );
  if (!hall || hall.owner !== ownerId)
    return {
      state,
      ok: false,
      error: "You no longer own this data hall.",
      netCost: 0,
    };
  const inventory = rackUnitsForFacility(state, plan.facilityId, ownerId);
  const candidate: DataHallLayout = {
    ...current,
    preferredStrategy: plan.preferredStrategy ?? current.preferredStrategy,
    revision: current.revision + 1,
    objects: plan.objects,
    walls: plan.walls,
    doors: plan.doors,
    constructionProject: undefined,
    analysis: emptyAnalysis(current.revision + 1),
  };
  candidate.analysis = analyzeHallLayout(
    candidate,
    inventory,
    hall.rackCapacity,
  );
  if (!candidate.analysis.valid)
    return {
      state,
      ok: false,
      error: candidate.analysis.hardErrors[0],
      netCost: 0,
    };

  // Purchase-draft racks (catalogId, no unit yet): buy them into the fleet as
  // ordered installs and link each draft to its freshly minted unit.
  let next = state;
  if (
    ownerId !== state.playerLabId &&
    candidate.objects.some(
      (object) =>
        object.kind === "rack" && !object.reserved && !object.rackUnitId,
    )
  ) {
    return {
      state,
      ok: false,
      error: "Only the player can purchase racks in the hall editor.",
      netCost: 0,
    };
  }
  const discount =
    aggregateEffects(state.player.researchUnlocked, state.player.researchRanks).chipDiscount ?? 0;
  let purchaseCost = 0;
  if (ownerId === state.playerLabId) {
    const fleet = next.player.rackFleet.map((install) => ({
      ...install,
      unitIds: [...(ensureRackUnitIds(install).unitIds ?? [])],
    }));
    const objects: DataHallObjectPlacement[] = [];
    for (const object of candidate.objects) {
      if (object.kind !== "rack" || object.reserved || object.rackUnitId) {
        objects.push(object);
        continue;
      }
      let sku: RackSku;
      try {
        sku = resolveRackSku(object.catalogId, next.player.rackDesigns ?? []);
      } catch {
        return {
          state,
          ok: false,
          error: `Unknown rack type ${object.catalogId}.`,
          netCost: 0,
        };
      }
      const unitPrice = quoteRackOrder(sku, 1, { discount }).unitPrice;
      const existing = fleet.find(
        (install) =>
          install.facilityId === plan.facilityId &&
          install.skuId === sku.id &&
          install.status === "ordered",
      );
      let unitId: string;
      if (existing) {
        unitId = `${existing.id}:unit:${String(existing.count + 1).padStart(4, "0")}`;
        const prevPaid = existing.paidEach * existing.count;
        existing.count += 1;
        existing.paidEach = Math.round((prevPaid + unitPrice) / existing.count);
        existing.unitIds = [...(existing.unitIds ?? []), unitId];
        existing.rackUnits = sku.rackUnits;
      } else {
        const id = seededId(
          "rk-hall",
          next.seed,
          next.day,
          plan.facilityId,
          sku.id,
          fleet.length,
        );
        unitId = `${id}:unit:0001`;
        fleet.push({
          id,
          skuId: sku.id,
          x: hall.x,
          y: hall.y,
          count: 1,
          status: "ordered",
          daysLeft: 0,
          paidEach: unitPrice,
          rackUnits: sku.rackUnits,
          facilityId: plan.facilityId,
          unitIds: [unitId],
        });
      }
      purchaseCost += unitPrice;
      objects.push({ ...object, rackUnitId: unitId, purchasePrice: unitPrice });
    }
    candidate.objects = objects;
    next = { ...next, player: { ...next.player, rackFleet: fleet } };
  }

  // Link ordered rack identities into the ghost target. Power, network and
  // cooling are never generated here; the submitted plan must contain them.
  const postPurchaseInventory = rackUnitsForFacility(
    next,
    plan.facilityId,
    ownerId,
  );
  candidate.analysis = analyzeHallLayout(
    candidate,
    postPurchaseInventory,
    hall.rackCapacity,
  );
  if (!candidate.analysis.valid)
    return {
      state,
      ok: false,
      error: candidate.analysis.hardErrors[0],
      netCost: 0,
    };

  const infrastructureCost = quoteHallPlanNetCost(current, candidate);
  const netCost = infrastructureCost + purchaseCost;
  const committedCost = Math.max(0, infrastructureCost) + purchaseCost;
  if (next.player.cash < committedCost)
    return {
      state,
      ok: false,
      error: `Need $${(committedCost / 1e6).toFixed(2)}M to apply this plan.`,
      netCost,
    };
  const cash = next.player.cash - committedCost;
  const constructionProject = createHallConstructionProject({
    id: seededId(
      "hall-project",
      next.seed,
      next.day,
      plan.facilityId,
      current.revision + 1,
    ),
    startedDay: next.day,
    current,
    target: candidate,
    targetRevision: current.revision + 1,
    infrastructureCost,
    rackPurchaseCost: purchaseCost,
  });
  return {
    ok: true,
    netCost,
    state: {
      ...next,
      dataHallLayouts: {
        ...(next.dataHallLayouts ?? {}),
        [plan.facilityId]: { ...current, constructionProject },
      },
      player: {
        ...next.player,
        cash,
        finance: { ...next.player.finance, cash },
      },
      labs: next.labs[next.playerLabId]
        ? {
            ...next.labs,
            [next.playerLabId]: {
              ...next.labs[next.playerLabId]!,
              cash,
              finance: { ...next.labs[next.playerLabId]!.finance, cash },
            },
          }
        : next.labs,
      alerts:
        ownerId === next.playerLabId
          ? [
              {
                id: `hall-project-started-${constructionProject.id}`,
                day: next.day,
                severity: "info" as const,
                message: `${hall.name || "Data hall"} refit started: ${constructionProject.totalDays} days through build, cabling, and commissioning.`,
              },
              ...next.alerts,
            ].slice(0, 40)
          : next.alerts,
    },
  };
}

export function removeDataHallLayout(
  state: SimState,
  facilityId: string,
): SimState {
  if (!state.dataHallLayouts?.[facilityId]) return state;
  const layouts = { ...state.dataHallLayouts };
  delete layouts[facilityId];
  return { ...state, dataHallLayouts: layouts };
}

export function refreshDataHallAnalysis(
  state: SimState,
  facilityId: string,
): SimState {
  const layout = state.dataHallLayouts?.[facilityId];
  const hall = facilityAnchorTiles(state).find(
    (tile) => (tile.campusId ?? `facility:${tile.x},${tile.y}`) === facilityId,
  );
  if (!layout || !hall) return state;
  const inventory = rackUnitsForFacility(state, facilityId, hall.owner);
  const analysis = analyzeHallLayout(layout, inventory, hall.rackCapacity);
  return {
    ...state,
    dataHallLayouts: {
      ...(state.dataHallLayouts ?? {}),
      [facilityId]: { ...layout, analysis },
    },
  };
}

export function refreshAllDataHallAnalyses(state: SimState): SimState {
  let next = state;
  for (const facilityId of Object.keys(state.dataHallLayouts ?? {}))
    next = refreshDataHallAnalysis(next, facilityId);
  return next;
}

export function hallInfrastructureValue(layout?: DataHallLayout): number {
  if (!layout) return 0;
  return (
    layout.objects
      .filter((object) => object.kind !== "rack")
      .reduce((sum, object) => sum + object.purchasePrice * 0.65, 0) +
    layout.walls.reduce((sum, wall) => sum + wall.purchasePrice * 0.5, 0) +
    layout.doors.reduce((sum, door) => sum + door.purchasePrice * 0.5, 0)
  );
}

export function playerHallPueMultiplier(state: SimState): number {
  const playerFacilityIds = new Set(
    facilityAnchorTiles(state, { ownerId: state.playerLabId })
      .filter((hall) => isDcKind(hall.kind) && isDcAnchor(hall))
      .map((hall) => hall.campusId ?? `facility:${hall.x},${hall.y}`),
  );
  const layouts = Object.values(state.dataHallLayouts ?? {}).filter((layout) =>
    playerFacilityIds.has(layout.facilityId),
  );
  let racks = 0;
  let weighted = 0;
  for (const layout of layouts) {
    const count = layout.analysis.operationalRackUnitIds.length;
    if (count <= 0) continue;
    racks += count;
    weighted += count * layout.analysis.pueMultiplier;
  }
  return racks > 0 ? weighted / racks : 1;
}

export const HALL_WALL_PRICE_PER_CELL = 18_000;
export const HALL_DOOR_PRICE = 95_000;

export function createWall(
  id: string,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
): DataHallWallSegment {
  return {
    id,
    x1,
    z1,
    x2,
    z2,
    purchasePrice:
      (Math.abs(x2 - x1) + Math.abs(z2 - z1)) * HALL_WALL_PRICE_PER_CELL,
  };
}

export function createDoor(
  id: string,
  wallId: string,
  offset: number,
  width = 4,
): DataHallDoorPlacement {
  return { id, wallId, offset, width, purchasePrice: HALL_DOOR_PRICE };
}

export function rotateHallObject(
  object: DataHallObjectPlacement,
): DataHallObjectPlacement {
  const rotation = ((object.rotation + 90) % 360) as HallRotation;
  return { ...object, rotation };
}
