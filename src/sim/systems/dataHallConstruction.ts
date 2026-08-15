import type {
  DataHallConstructionProject,
  DataHallDoorPlacement,
  DataHallLayout,
  DataHallObjectPlacement,
  DataHallWallSegment,
  HallAutoLayoutStrategy,
  HallConstructionStage,
  LabId,
  SimState,
} from "../types";
import { facilityAnchorTiles } from "./worldAccess";

const DAY_MIN = 3;
const DAY_MAX = 14;

type ConstructionTarget = Pick<
  DataHallLayout,
  "objects" | "walls" | "doors" | "preferredStrategy"
>;

export interface HallConstructionSchedule {
  totalDays: number;
  stageDays: DataHallConstructionProject["stageDays"];
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(
    min,
    Math.min(max, Math.round(Number.isFinite(value) ? value : min)),
  );
}

function objectChanged(
  a: DataHallObjectPlacement | undefined,
  b: DataHallObjectPlacement | undefined,
): boolean {
  if (!a || !b) return true;
  return (
    a.kind !== b.kind ||
    a.catalogId !== b.catalogId ||
    a.x !== b.x ||
    a.z !== b.z ||
    a.rotation !== b.rotation ||
    a.rackUnitId !== b.rackUnitId ||
    Boolean(a.reserved) !== Boolean(b.reserved)
  );
}

function wallChanged(
  a: DataHallWallSegment | undefined,
  b: DataHallWallSegment | undefined,
): boolean {
  if (!a || !b) return true;
  return a.x1 !== b.x1 || a.z1 !== b.z1 || a.x2 !== b.x2 || a.z2 !== b.z2;
}

function doorChanged(
  a: DataHallDoorPlacement | undefined,
  b: DataHallDoorPlacement | undefined,
): boolean {
  if (!a || !b) return true;
  return a.wallId !== b.wallId || a.offset !== b.offset || a.width !== b.width;
}

/**
 * Deterministic construction time from physical scope. A tiny partition or
 * rack move takes three days; a whole-hall refit reaches, but never exceeds,
 * two weeks. Every project visibly passes through build, cabling and
 * commissioning.
 */
export function scheduleHallConstruction(
  current: ConstructionTarget,
  target: ConstructionTarget,
): HallConstructionSchedule {
  const currentObjects = new Map(
    current.objects.map((object) => [object.id, object]),
  );
  const targetObjects = new Map(
    target.objects.map((object) => [object.id, object]),
  );
  const objectIds = new Set([
    ...currentObjects.keys(),
    ...targetObjects.keys(),
  ]);
  let changedRacks = 0;
  let changedUtilities = 0;
  for (const id of objectIds) {
    const before = currentObjects.get(id);
    const after = targetObjects.get(id);
    if (!objectChanged(before, after)) continue;
    if ((after ?? before)?.kind === "rack") changedRacks += 1;
    else changedUtilities += 1;
  }

  const currentWalls = new Map(current.walls.map((wall) => [wall.id, wall]));
  const targetWalls = new Map(target.walls.map((wall) => [wall.id, wall]));
  const wallIds = new Set([...currentWalls.keys(), ...targetWalls.keys()]);
  let changedWallCells = 0;
  for (const id of wallIds) {
    const before = currentWalls.get(id);
    const after = targetWalls.get(id);
    if (!wallChanged(before, after)) continue;
    const length = (wall?: DataHallWallSegment) =>
      wall ? Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1) : 0;
    changedWallCells += Math.max(length(before), length(after));
  }

  const currentDoors = new Map(current.doors.map((door) => [door.id, door]));
  const targetDoors = new Map(target.doors.map((door) => [door.id, door]));
  const doorIds = new Set([...currentDoors.keys(), ...targetDoors.keys()]);
  let changedDoors = 0;
  for (const id of doorIds)
    if (doorChanged(currentDoors.get(id), targetDoors.get(id)))
      changedDoors += 1;

  const build = clampInt(
    Math.ceil(
      (changedWallCells +
        changedDoors * 8 +
        changedUtilities * 12 +
        changedRacks * 3) /
        60,
    ),
    1,
    6,
  );
  const cabling = clampInt(
    Math.ceil((changedUtilities * 3 + changedRacks) / 8),
    1,
    5,
  );
  const commissioning = clampInt(
    Math.ceil((changedUtilities + changedRacks + changedDoors) / 24),
    1,
    3,
  );
  const rawTotal = build + cabling + commissioning;
  const totalDays = clampInt(rawTotal, DAY_MIN, DAY_MAX);

  // The individual caps already sum to 14. This guard keeps the invariant if
  // those weights change later without silently removing a stage.
  const excess = Math.max(0, rawTotal - totalDays);
  const stageDays = {
    build: Math.max(1, build - excess),
    cabling,
    commissioning,
  };
  return { totalDays, stageDays };
}

export function hallConstructionStage(
  totalDays: number,
  remainingDays: number,
  stageDays: DataHallConstructionProject["stageDays"],
): HallConstructionStage {
  const elapsed = Math.max(0, totalDays - remainingDays);
  if (elapsed < stageDays.build) return "build";
  if (elapsed < stageDays.build + stageDays.cabling) return "cabling";
  return "commissioning";
}

export function createHallConstructionProject(input: {
  id: string;
  startedDay: number;
  current: ConstructionTarget;
  target: ConstructionTarget;
  targetRevision: number;
  infrastructureCost: number;
  rackPurchaseCost: number;
}): DataHallConstructionProject {
  const schedule = scheduleHallConstruction(input.current, input.target);
  return {
    id: input.id,
    startedDay: Math.max(0, Math.floor(input.startedDay)),
    totalDays: schedule.totalDays,
    remainingDays: schedule.totalDays,
    stage: "build",
    stageDays: schedule.stageDays,
    targetRevision: Math.max(0, Math.floor(input.targetRevision)),
    targetObjects: input.target.objects.map((object) => ({ ...object })),
    targetWalls: input.target.walls.map((wall) => ({ ...wall })),
    targetDoors: input.target.doors.map((door) => ({ ...door })),
    targetPreferredStrategy: input.target.preferredStrategy,
    infrastructureCost: Math.round(input.infrastructureCost),
    rackPurchaseCost: Math.max(0, Math.round(input.rackPurchaseCost)),
    totalCost: Math.round(input.infrastructureCost + input.rackPurchaseCost),
  };
}

export function advanceHallConstructionProject(
  project: DataHallConstructionProject,
): {
  complete: boolean;
  project?: DataHallConstructionProject;
} {
  const remainingDays = Math.max(0, project.remainingDays - 1);
  if (remainingDays === 0) return { complete: true };
  return {
    complete: false,
    project: {
      ...project,
      remainingDays,
      stage: hallConstructionStage(
        project.totalDays,
        remainingDays,
        project.stageDays,
      ),
    },
  };
}

function isStrategy(value: unknown): value is HallAutoLayoutStrategy {
  return (
    value === "density" || value === "efficiency" || value === "resilience"
  );
}

/** Drop malformed partial projects from old/beta saves without commissioning them. */
export function normalizeHallConstructionProject(
  value: unknown,
): DataHallConstructionProject | undefined {
  if (!value || typeof value !== "object") return undefined;
  const project = value as Partial<DataHallConstructionProject>;
  if (
    !Array.isArray(project.targetObjects) ||
    !Array.isArray(project.targetWalls) ||
    !Array.isArray(project.targetDoors)
  )
    return undefined;
  if (!isStrategy(project.targetPreferredStrategy)) return undefined;
  if (!project.stageDays || typeof project.stageDays !== "object")
    return undefined;
  const totalDays = clampInt(Number(project.totalDays), DAY_MIN, DAY_MAX);
  const remainingDays = clampInt(Number(project.remainingDays), 1, totalDays);
  const stageDays = {
    build: clampInt(Number(project.stageDays.build), 1, 6),
    cabling: clampInt(Number(project.stageDays.cabling), 1, 5),
    commissioning: clampInt(Number(project.stageDays.commissioning), 1, 3),
  };
  return {
    id:
      typeof project.id === "string" && project.id
        ? project.id
        : "hall-construction-restored",
    startedDay: Math.max(0, Math.floor(Number(project.startedDay) || 0)),
    totalDays,
    remainingDays,
    stage: hallConstructionStage(totalDays, remainingDays, stageDays),
    stageDays,
    targetRevision: Math.max(
      0,
      Math.floor(Number(project.targetRevision) || 0),
    ),
    targetObjects: project.targetObjects.map((object) => ({ ...object })),
    targetWalls: project.targetWalls.map((wall) => ({ ...wall })),
    targetDoors: project.targetDoors.map((door) => ({ ...door })),
    targetPreferredStrategy: project.targetPreferredStrategy,
    infrastructureCost: Math.round(Number(project.infrastructureCost) || 0),
    rackPurchaseCost: Math.max(
      0,
      Math.round(Number(project.rackPurchaseCost) || 0),
    ),
    totalCost: Math.round(
      Number(project.totalCost) ||
        (Number(project.infrastructureCost) || 0) +
          (Number(project.rackPurchaseCost) || 0),
    ),
  };
}

type EquipmentOpexProfile = {
  catalogValue: number;
  annualMaintenanceRate: number;
  operatingOverheadDay: number;
};

const EQUIPMENT_OPEX: Record<string, EquipmentOpexProfile> = {
  "crac-2mw": {
    catalogValue: 3_200_000,
    annualMaintenanceRate: 0.065,
    operatingOverheadDay: 1_400,
  },
  "inrow-350kw": {
    catalogValue: 720_000,
    annualMaintenanceRate: 0.06,
    operatingOverheadDay: 320,
  },
  "pdu-2mw": {
    catalogValue: 1_150_000,
    annualMaintenanceRate: 0.045,
    operatingOverheadDay: 120,
  },
  "ups-5mw": {
    catalogValue: 5_800_000,
    annualMaintenanceRate: 0.055,
    operatingOverheadDay: 900,
  },
  "core-6t": {
    catalogValue: 980_000,
    annualMaintenanceRate: 0.05,
    operatingOverheadDay: 180,
  },
  "core-25t": {
    catalogValue: 3_600_000,
    annualMaintenanceRate: 0.055,
    operatingOverheadDay: 620,
  },
};

/** Installed (live, not ghost-plan) utility maintenance and control-plane overhead. */
export function hallInstalledEquipmentOpexDay(layout?: DataHallLayout): number {
  if (!layout) return 0;
  return layout.objects.reduce((total, object) => {
    if (object.kind === "rack") return total;
    const profile = EQUIPMENT_OPEX[object.catalogId];
    if (!profile) return total;
    const maintainedValue = Math.max(
      profile.catalogValue,
      object.purchasePrice || 0,
    );
    return (
      total +
      (maintainedValue * profile.annualMaintenanceRate) / 365 +
      profile.operatingOverheadDay
    );
  }, 0);
}

/** Symmetric installed-equipment opex for the player and every rival lab. */
export function labHallEquipmentOpexDay(state: SimState, labId: LabId): number {
  const ownedFacilityIds = new Set(
    facilityAnchorTiles(state, {
      ownerId: labId,
      underConstruction: false,
    }).map((hall) => hall.campusId ?? `facility:${hall.x},${hall.y}`),
  );
  return Object.values(state.dataHallLayouts ?? {}).reduce(
    (total, layout) =>
      ownedFacilityIds.has(layout.facilityId)
        ? total + hallInstalledEquipmentOpexDay(layout)
        : total,
    0,
  );
}
