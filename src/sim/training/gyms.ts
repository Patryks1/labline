import { TRAINING_V4 } from "./constants";
import type { Gym, GymKind, PostTrainPoolKind } from "./types";

/** Cash to found a gym campus (player only). */
export const GYM_CREATE_CASH = 2_000_000;

export const GYM_RESEARCHER_MAX = 20;

/** Per-gym cap on the shared research PF pool. */
export const GYM_RESEARCH_SHARE_MAX = 0.25;

/** Step for the gym compute slider (1% of the research pool). */
export const GYM_RESEARCH_SHARE_STEP = 0.01;

/** Aggregate gym slice of the research pool (legacy + V4). */
export const GYM_RESEARCH_SHARE_CAP = 0.75;

export const GYM_BUDGET_MONTH_MAX = 1_500_000;
export const GYM_BUDGET_MONTH_STEP = 25_000;
export const GYM_DAYS_PER_MONTH = 30;

/** Research node that unlocks assigning a checkpoint as a gym teacher. */
export const GYM_SYNTH_TEACHER_NODE = "data_synth";

/** Monthly operating budget that unlocks each campus rung. */
export const GYM_TIER_MONTHLY = [0, 150_000, 450_000, 1_200_000] as const;

const SAFETY_PREF_MTOK_PER_TASK = 0.02;
const THROUGHPUT_SCALE = 3.4;
const THROUGHPUT_DIMINISH = 0.4;
/** Synthetic teachers fill labor at this fraction of a full human crew. */
const SYNTH_LABOR_FILL = 0.55;
/** Extra research-PF seat when a teacher is grading. */
const SYNTH_COMPUTE_SEAT_MULT = 1.8;
/** Teacher-only emit quality vs a matched human crew. */
const SYNTH_QUALITY_MULT = 0.42;
const QUALITY_CAP = [0.5, 0.68, 0.84, 0.96] as const;

export type GymBottleneck = "researchers" | "compute" | "budget";

export interface GymYieldContext {
  /** 0–1 capability of the assigned teacher checkpoint. */
  teacherStrength: number;
  /** Lab synthetic-quality modifier (1 = baseline). */
  syntheticQuality: number;
}

export function gymTierSpec(tier: number) {
  const clamped = Math.max(0, Math.min(3, Math.floor(tier)));
  return TRAINING_V4.gyms.tiers[clamped] ?? TRAINING_V4.gyms.tiers[0];
}

export function gymProductionKind(kind: GymKind): PostTrainPoolKind {
  if (kind === "agentic") return "toolTrajectories";
  if (kind === "safety") return "preferenceMTok";
  return "verifiableTasks";
}

export function gymResearchShare(gym: Gym): number {
  return Math.max(0, gym.researchShare ?? 0);
}

export function gymBudgetPerDay(gym: Gym): number {
  return Math.max(0, gym.budgetPerDay ?? 0);
}

export function gymMonthlyBudget(gym: Gym): number {
  return gymBudgetPerDay(gym) * GYM_DAYS_PER_MONTH;
}

export function monthlyBudgetToPerDay(monthly: number): number {
  return Math.max(0, monthly) / GYM_DAYS_PER_MONTH;
}

export function gymAuditShare(gym: Gym): number {
  const share = gym.auditShare ?? 0;
  return Math.max(0, Math.min(1, share));
}

export function gymHasTeacher(gym: Gym, teacherStrength = 0): boolean {
  return Boolean(gym.teacherCheckpointId) && teacherStrength > 1e-6;
}

export function gymHasGrader(gym: Gym, teacherStrength = 0): boolean {
  return (gym.researchers ?? 0) > 0 || gymHasTeacher(gym, teacherStrength);
}

export function gymTierFromMonthly(monthly: number): number {
  if (monthly + 1e-9 >= GYM_TIER_MONTHLY[3]) return 3;
  if (monthly + 1e-9 >= GYM_TIER_MONTHLY[2]) return 2;
  if (monthly + 1e-9 >= GYM_TIER_MONTHLY[1]) return 1;
  return 0;
}

/** Apply campus rung from the current monthly operating budget. */
export function applyGymCampus(gym: Gym): Gym {
  const tier = gymTierFromMonthly(gymMonthlyBudget(gym));
  const spec = gymTierSpec(tier);
  if (gym.tier === spec.tier && gym.tasksPerDay === spec.tasksPerDay && !gym.upgrade) {
    return gym;
  }
  return {
    ...gym,
    tier: spec.tier,
    tasksPerDay: spec.tasksPerDay,
    upgrade: undefined,
  };
}

function tierScale(tier: number): number {
  return Math.max(1, Math.min(4, Math.floor(tier) + 1));
}

/** Researchers that count as a full staff fill at this campus tier. */
export function gymResearcherSeat(tier: number): number {
  return 4 * tierScale(tier);
}

/** Research-pool share that counts as a full compute fill at this campus tier. */
export function gymComputeSeat(tier: number, teacher = false): number {
  return 0.05 * tierScale(tier) * (teacher ? SYNTH_COMPUTE_SEAT_MULT : 1);
}

/** Daily operating cash that counts as a full budget fill at this campus tier. */
export function gymBudgetSeatPerDay(tier: number): number {
  return 5_000 * tierScale(tier);
}

function fillRatio(have: number, seat: number): number {
  if (!(seat > 0) || !(have > 0)) return 0;
  return have / seat;
}

export function gymStaffingFills(
  gym: Gym,
  ctx: GymYieldContext = { teacherStrength: 0, syntheticQuality: 1 },
): {
  researchers: number;
  compute: number;
  budget: number;
} {
  const teacher = gymHasTeacher(gym, ctx.teacherStrength);
  const labor =
    fillRatio(gym.researchers ?? 0, gymResearcherSeat(gym.tier)) +
    (teacher ? SYNTH_LABOR_FILL : 0);
  return {
    researchers: labor,
    compute: fillRatio(gymResearchShare(gym), gymComputeSeat(gym.tier, teacher)),
    budget: fillRatio(gymBudgetPerDay(gym), gymBudgetSeatPerDay(gym.tier)),
  };
}

export function gymEmitQuality(
  gym: Gym,
  ctx: GymYieldContext = { teacherStrength: 0, syntheticQuality: 1 },
): number {
  if (!gymHasGrader(gym, ctx.teacherStrength)) return 0;
  const seat = gymResearcherSeat(gym.tier);
  const human =
    (gym.researchers ?? 0) > 0
      ? 0.22 + 0.55 * Math.min(1, (gym.researchers ?? 0) / Math.max(1, seat))
      : 0;
  const synthMod = Math.max(0.4, ctx.syntheticQuality);
  const teacher = gymHasTeacher(gym, ctx.teacherStrength)
    ? Math.max(0, ctx.teacherStrength) * SYNTH_QUALITY_MULT * synthMod
    : 0;
  const mixed =
    human > 0 && teacher > 0
      ? 1 - (1 - human) * (1 - teacher * 0.45)
      : Math.max(human, teacher);
  const audited = mixed + (1 - mixed) * 0.7 * gymAuditShare(gym);
  const cap = QUALITY_CAP[Math.max(0, Math.min(3, gym.tier))] ?? QUALITY_CAP[0];
  return Math.max(0, Math.min(cap, audited));
}

/**
 * Geometric-mean staffing. Dumping one lever (heads, PF, or cash) does not
 * scale yield; matched graders + compute + budget does. No grader → no yield.
 */
export function gymBalance(
  gym: Gym,
  ctx: GymYieldContext = { teacherStrength: 0, syntheticQuality: 1 },
): {
  fills: ReturnType<typeof gymStaffingFills>;
  geo: number;
  throughput: number;
  bottleneck: GymBottleneck | null;
} {
  const fills = gymStaffingFills(gym, ctx);
  if (!gymHasGrader(gym, ctx.teacherStrength)) {
    return { fills, geo: 0, throughput: 0, bottleneck: "researchers" };
  }
  const product = fills.researchers * fills.compute * fills.budget;
  const geo = product > 0 ? product ** (1 / 3) : 0;
  const throughput = (THROUGHPUT_SCALE * geo) / (1 + THROUGHPUT_DIMINISH * geo);
  const entries: [GymBottleneck, number][] = [
    ["researchers", fills.researchers],
    ["compute", fills.compute],
    ["budget", fills.budget],
  ];
  const min = entries.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
  const max = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  const bottleneck =
    max[1] > 0.15 && min[1] < max[1] * 0.45 ? min[0] : null;
  return { fills, geo, throughput, bottleneck };
}

/**
 * Daily pool yield. code/math/science → verifiableTasks;
 * agentic → toolTrajectories; safety → preferenceMTok at 0.02·tasksPerDay.
 * Amount scales with balanced graders, research compute, and operating budget.
 * Audit discards volume in exchange for a higher emit grade.
 */
export function gymDailyYield(
  gym: Gym,
  ctx: GymYieldContext = { teacherStrength: 0, syntheticQuality: 1 },
): { kind: PostTrainPoolKind; amount: number; quality: number } {
  const kind = gymProductionKind(gym.kind);
  const { throughput } = gymBalance(gym, ctx);
  const quality = gymEmitQuality(gym, ctx);
  const keep = 1 - 0.55 * gymAuditShare(gym);
  let amount: number;
  if (gym.kind === "safety") {
    amount = SAFETY_PREF_MTOK_PER_TASK * gym.tasksPerDay * throughput * keep;
  } else {
    amount = gym.tasksPerDay * throughput * keep;
  }
  return { kind, amount, quality };
}

/** Research-pool share reserved by V4 gyms. */
export function v4GymResearchReservationShare(
  gyms: readonly Gym[] | undefined,
  exceptId?: string,
): number {
  const share = (gyms ?? []).reduce((sum, gym) => {
    if (gym.id === exceptId) return sum;
    return sum + gymResearchShare(gym);
  }, 0);
  return Math.max(0, Math.min(GYM_RESEARCH_SHARE_CAP, share));
}

/** Clamp a requested gym share against the gym bucket and leftover research pool. */
export function capGymResearchShare(input: {
  requested: number;
  otherV4: number;
  legacy: number;
  dataShare: number;
  safetyShare: number;
}): number {
  const remainingGymCap = Math.max(
    0,
    GYM_RESEARCH_SHARE_CAP - input.otherV4 - input.legacy,
  );
  const remainingPool = Math.max(
    0,
    1 - input.dataShare - input.safetyShare - input.otherV4 - input.legacy,
  );
  const max = Math.min(GYM_RESEARCH_SHARE_MAX, remainingGymCap, remainingPool);
  return Math.max(0, Math.min(max, input.requested));
}
