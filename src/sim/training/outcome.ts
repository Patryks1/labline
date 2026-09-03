import { createRng, hashSeed, seededId } from "../rng";
import { TRAINING_V4 } from "./constants";
import type {
  IncidentChoice,
  IncidentKind,
  RunIncident,
  TrainingModifiers,
  TrainingRun,
  TrainPrecision,
} from "./types";

export interface IncidentTemplate {
  kind: IncidentKind;
  title: string;
  body: string;
  weight: number;
  choices: IncidentChoice[];
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Flavor catalog (3 choices each). Effects move sigma/cost/progress/days/gap;
 * they never redraw ε. Breakthrough options improve gap (negative gapDelta).
 */
export function incidentCatalog(): readonly IncidentTemplate[] {
  return INCIDENT_CATALOG;
}

const INCIDENT_CATALOG: readonly IncidentTemplate[] = [
  {
    kind: "loss_spike",
    title: "Loss spike at scale",
    body: "Observed loss moved outside the expected recovery band. The run may recover, but the recipe has not been validated at this scale.",
    weight: 3,
    choices: [
      {
        id: "stabilize-recipe",
        label: "Lower the learning rate",
        description: "Slow the schedule and replay from the last stable optimizer state.",
        effects: { sigmaMult: 0.88, daysDelta: 3, rollbackProgress: 0.02 },
      },
      {
        id: "diagnostic-sweep",
        label: "Run a diagnostic sweep",
        description: "Fund proxy branches and gradient diagnostics; adds a little compute.",
        effects: { costMult: 1.06, daysDelta: 2, gapDelta: -0.004, sigmaMult: 0.95 },
      },
      {
        id: "push-through",
        label: "Push through the spike",
        description: "Keep the schedule. Recovery can beat forecast; divergence can reduce usable yield.",
        effects: { sigmaMult: 1.18, gapDelta: 0.012 },
      },
    ],
  },
  {
    kind: "hardware_fault",
    title: "Cluster fault during checkpoint",
    body: "A worker group dropped during a distributed save. The last checkpoint is intact, but optimizer state needs verification.",
    weight: 2.2,
    choices: [
      {
        id: "rollback-checkpoint",
        label: "Rollback and verify",
        description: "Replay from the last verified checkpoint.",
        effects: { rollbackProgress: 0.04, sigmaMult: 0.92, daysDelta: 2 },
      },
      {
        id: "replace-workers",
        label: "Replace the worker group",
        description: "Buy spare capacity and re-validate optimizer state without a deep rollback.",
        effects: { costMult: 1.12, daysDelta: 3, sigmaMult: 0.9 },
      },
      {
        id: "run-degraded",
        label: "Continue on degraded fabric",
        description: "Keep tokens moving. Throughput holds; instability rises.",
        effects: { sigmaMult: 1.22, daysDelta: 1, gapDelta: 0.008 },
      },
    ],
  },
  {
    kind: "data_contamination",
    title: "Suspicious training shard",
    body: "A domain shard is learning unusually fast. It may be high-signal data, duplication, or benchmark leakage.",
    weight: 2,
    choices: [
      {
        id: "quarantine",
        label: "Quarantine and replay",
        description: "Drop the shard and replay from a clean checkpoint.",
        effects: { rollbackProgress: 0.03, sigmaMult: 0.9, gapDelta: 0.004 },
      },
      {
        id: "forensic-audit",
        label: "Fund a forensic audit",
        description: "Dedup, provenance checks, and a shadow holdout before trusting the shard.",
        effects: { costMult: 1.08, daysDelta: 4, sigmaMult: 0.93 },
      },
      {
        id: "trust-shard",
        label: "Trust the signal",
        description: "Keep the apparent gain. Cheap, but contamination can inflate later evals.",
        effects: { sigmaMult: 1.14, gapDelta: 0.016 },
      },
    ],
  },
  {
    kind: "divergence",
    title: "Optimizer divergence",
    body: "Gradient norms escaped the trust region. Continuing the current schedule may permanently damage the run.",
    weight: 1.8,
    choices: [
      {
        id: "cool-schedule",
        label: "Cool the schedule and replay",
        description: "Drop the peak LR and re-enter the recovery band from a stable snapshot.",
        effects: { rollbackProgress: 0.05, daysDelta: 4, sigmaMult: 0.85 },
      },
      {
        id: "clip-and-hold",
        label: "Clip gradients and hold",
        description: "Add clipping and extra checkpointing; the calendar stretches a little.",
        effects: { daysDelta: 2, costMult: 1.04, sigmaMult: 0.94 },
      },
      {
        id: "ride-it-out",
        label: "Ride the spike",
        description: "Do not touch the recipe. Fast, but the gap can open.",
        effects: { sigmaMult: 1.28, gapDelta: 0.02 },
      },
    ],
  },
  {
    kind: "eval_surprise",
    title: "Holdout surprise",
    body: "A mid-run proxy eval moved against the loss curve. The gap between train and holdout may be real.",
    weight: 1.5,
    choices: [
      {
        id: "extra-holdout",
        label: "Expand the holdout",
        description: "Grow a clean evaluation slice before changing the recipe.",
        effects: { daysDelta: 2, costMult: 1.05, sigmaMult: 0.96 },
      },
      {
        id: "investigate-split",
        label: "Investigate the split",
        description: "Staff a short diagnostic on leakage vs genuine transfer.",
        effects: { daysDelta: 3, sigmaMult: 0.92, gapDelta: -0.003 },
      },
      {
        id: "trust-train-loss",
        label: "Trust the train curve",
        description: "Treat the proxy as noisy and keep going.",
        effects: { sigmaMult: 1.1, gapDelta: 0.01 },
      },
    ],
  },
  {
    kind: "breakthrough",
    title: "Unexpected transfer signal",
    body: "A minority domain is lifting several validation slices. The effect is promising but still uncertain at full scale.",
    weight: 0.85,
    choices: [
      {
        id: "harvest-gain",
        label: "Harvest the gain",
        description: "Lock the current recipe and keep the observed transfer.",
        effects: { gapDelta: -0.02, sigmaMult: 0.97 },
      },
      {
        id: "lean-in",
        label: "Lean into the curriculum",
        description: "Spend extra compute on the promising mix. Higher upside, wider risk.",
        effects: { gapDelta: -0.03, costMult: 1.06, daysDelta: 2, sigmaMult: 1.08 },
      },
      {
        id: "validate-first",
        label: "Validate with a proxy branch",
        description: "Confirm the transfer on a clean holdout before changing the parent recipe.",
        effects: { gapDelta: -0.012, daysDelta: 2, costMult: 1.04, sigmaMult: 0.94 },
      },
    ],
  },
];

/**
 * σ = sigmaBase · stability · engineerFactor · precisionSigma · moeUntested · scaleJump.
 * scaleJump = 1 + 0.15 · max(0, log10(N / biggestPriorN)).
 */
export function sigmaFor(input: {
  modifiers: TrainingModifiers;
  precision: TrainPrecision;
  firstMoe: boolean;
  scaleJumpLog10: number;
  engineerFactor: number;
}): number {
  const { sigmaBase, moeUntested, scaleJump } = TRAINING_V4.rng;
  const precisionMult = TRAINING_V4.precision.sigmaMult[input.precision];
  const moeMult = input.firstMoe ? moeUntested : 1;
  const jumpMult = 1 + scaleJump * Math.max(0, input.scaleJumpLog10);
  return (
    sigmaBase *
    input.modifiers.stability *
    precisionMult *
    moeMult *
    jumpMult *
    input.engineerFactor
  );
}

/** Seeded N(0, σ) draw, clamped to ±clampSigmas. */
export function drawEpsilon(seed: number, sigma: number): number {
  if (!(sigma > 0) || !Number.isFinite(sigma)) return 0;
  const rng = createRng(seed);
  const u1 = Math.max(rng.next(), 1e-12);
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const raw = z * sigma;
  const limit = TRAINING_V4.rng.clampSigmas * sigma;
  return clamp(raw, -limit, limit);
}

/** g_actual = g_forecast · (1+ε) + gapDelta. */
export function realizeGap(
  forecastGap: number,
  epsilon: number,
  gapDelta: number,
): number {
  return Math.max(0.005, forecastGap * (1 + epsilon) + gapDelta);
}

/** At most maxPerRun incidents; auto-resolve after autoResolveDays. Never rerolls ε. */
export function rollIncident(run: TrainingRun, day: number): RunIncident | null {
  const { maxPerRun, autoResolveDays } = TRAINING_V4.incidents;
  if (run.incidents.length >= maxPerRun) return null;
  if (run.incidents.some((incident) => incident.resolvedChoiceId == null)) return null;
  if (run.progress < 0.08 || run.progress > 0.92) return null;

  const dailyP = 1.4 / Math.max(run.etaDays, 6);
  const rng = createRng(hashSeed(run.seed, day, "incident-v4"));
  if (rng.next() >= dailyP) return null;

  const catalog = INCIDENT_CATALOG;
  const totalWeight = catalog.reduce((sum, row) => sum + row.weight, 0);
  let pick = rng.next() * totalWeight;
  let template = catalog[0]!;
  for (const row of catalog) {
    pick -= row.weight;
    if (pick <= 0) {
      template = row;
      break;
    }
  }

  return {
    id: seededId("incident", run.seed, day, template.kind),
    kind: template.kind,
    day,
    title: template.title,
    body: template.body,
    choices: template.choices.map((choice) => ({
      ...choice,
      effects: { ...choice.effects },
    })),
    autoResolveDay: day + autoResolveDays,
  };
}

/** ≤ catastrophicMax; always leaves the last checkpoint. */
export function isCatastrophic(seed: number, run: TrainingRun): boolean {
  const { sigmaBase, catastrophicMax } = TRAINING_V4.rng;
  const sigma = run.forecast.capability.sigma;
  const ratio = sigmaBase > 0 ? sigma / sigmaBase : 0;
  const p = Math.min(catastrophicMax, 0.006 * run.sigmaMult * ratio);
  if (!(p > 0)) return false;
  return createRng(hashSeed(seed, "catastrophe")).next() < p;
}
