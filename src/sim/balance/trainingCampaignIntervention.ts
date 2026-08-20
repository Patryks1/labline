import type {
  TrainingCampaignChoiceEffects,
  TrainingCampaignEventKind,
  TrainingJob,
} from "../types";

export interface CampaignInterventionAxisLimit {
  min: number;
  max: number;
}

export interface CampaignInterventionLimits {
  cashCost: CampaignInterventionAxisLimit;
  extraComputeFraction: CampaignInterventionAxisLimit;
  progressRollbackFraction: CampaignInterventionAxisLimit;
  capabilityDelta: CampaignInterventionAxisLimit;
  reliabilityDelta: CampaignInterventionAxisLimit;
  safetyDelta: CampaignInterventionAxisLimit;
  breakthroughBias: CampaignInterventionAxisLimit;
  stumbleRisk: CampaignInterventionAxisLimit;
  dataQualityDelta: CampaignInterventionAxisLimit;
  minResearchers: CampaignInterventionAxisLimit;
}

const DEFAULT_LIMITS: CampaignInterventionLimits = {
  cashCost: { min: 0, max: 12_000_000 },
  extraComputeFraction: { min: 0, max: 0.16 },
  progressRollbackFraction: { min: 0, max: 0.12 },
  capabilityDelta: { min: -2, max: 2.2 },
  reliabilityDelta: { min: -5, max: 5 },
  safetyDelta: { min: -3, max: 4 },
  breakthroughBias: { min: 0, max: 0.08 },
  stumbleRisk: { min: -0.1, max: 0.12 },
  dataQualityDelta: { min: -5, max: 5 },
  minResearchers: { min: 0, max: 48 },
};

export const EMPTY_CAMPAIGN_INTERVENTION: TrainingCampaignChoiceEffects = {
  cashCost: 0,
  extraComputeFraction: 0,
  progressRollbackFraction: 0,
  capabilityDelta: 0,
  reliabilityDelta: 0,
  safetyDelta: 0,
  breakthroughBias: 0,
  stumbleRisk: 0,
  dataQualityDelta: 0,
  minResearchers: 0,
};

export function campaignInterventionLimits(
  kind: TrainingCampaignEventKind,
): CampaignInterventionLimits {
  const limits: CampaignInterventionLimits = {
    cashCost: { ...DEFAULT_LIMITS.cashCost },
    extraComputeFraction: { ...DEFAULT_LIMITS.extraComputeFraction },
    progressRollbackFraction: { ...DEFAULT_LIMITS.progressRollbackFraction },
    capabilityDelta: { ...DEFAULT_LIMITS.capabilityDelta },
    reliabilityDelta: { ...DEFAULT_LIMITS.reliabilityDelta },
    safetyDelta: { ...DEFAULT_LIMITS.safetyDelta },
    breakthroughBias: { ...DEFAULT_LIMITS.breakthroughBias },
    stumbleRisk: { ...DEFAULT_LIMITS.stumbleRisk },
    dataQualityDelta: { ...DEFAULT_LIMITS.dataQualityDelta },
    minResearchers: { ...DEFAULT_LIMITS.minResearchers },
  };
  if (kind === "hardware_fault") {
    limits.capabilityDelta.max = 0.45;
    limits.breakthroughBias.max = 0.02;
  }
  if (kind === "recursive_research") {
    limits.extraComputeFraction.max = 0.18;
    limits.minResearchers.max = 48;
    limits.safetyDelta.min = -2.5;
  }
  if (kind === "data_anomaly") {
    limits.dataQualityDelta.max = 5;
  }
  return limits;
}

function clampAxis(
  value: number | undefined,
  range: CampaignInterventionAxisLimit,
  fallback = 0,
): number {
  const numeric = Number.isFinite(value) ? (value as number) : fallback;
  return Math.max(range.min, Math.min(range.max, numeric));
}

export function clampTrainingCampaignIntervention(
  kind: TrainingCampaignEventKind,
  effects: TrainingCampaignChoiceEffects,
): TrainingCampaignChoiceEffects {
  const limits = campaignInterventionLimits(kind);
  const next: TrainingCampaignChoiceEffects = {
    cashCost: clampAxis(effects.cashCost, limits.cashCost),
    extraComputeFraction: clampAxis(
      effects.extraComputeFraction,
      limits.extraComputeFraction,
    ),
    progressRollbackFraction: clampAxis(
      effects.progressRollbackFraction,
      limits.progressRollbackFraction,
    ),
    capabilityDelta: clampAxis(effects.capabilityDelta, limits.capabilityDelta),
    reliabilityDelta: clampAxis(
      effects.reliabilityDelta,
      limits.reliabilityDelta,
    ),
    safetyDelta: clampAxis(effects.safetyDelta, limits.safetyDelta),
    breakthroughBias: clampAxis(
      effects.breakthroughBias,
      limits.breakthroughBias,
    ),
    stumbleRisk: clampAxis(effects.stumbleRisk, limits.stumbleRisk),
    dataQualityDelta: clampAxis(
      effects.dataQualityDelta,
      limits.dataQualityDelta,
    ),
    minResearchers: Math.round(
      clampAxis(effects.minResearchers, limits.minResearchers),
    ),
  };
  if (kind === "recursive_research") {
    next.verifiedRecursiveCapabilityBonus = Math.max(
      0,
      effects.verifiedRecursiveCapabilityBonus ?? 0,
    );
  }
  return next;
}

/** Independent verification is the only path that can mint recursive headroom. */
export function meetsIndependentVerificationGate(
  effects: TrainingCampaignChoiceEffects,
): boolean {
  return (
    (effects.cashCost ?? 0) >= 200_000 &&
    (effects.extraComputeFraction ?? 0) >= 0.1 &&
    (effects.minResearchers ?? 0) >= 32
  );
}

export function withCampaignEvidencePrecision(
  effects: TrainingCampaignChoiceEffects,
  evidenceAccuracy?: number,
): TrainingCampaignChoiceEffects {
  if ((effects.cashCost ?? 0) <= 0) return effects;
  const accuracy = Math.max(0.25, Math.min(0.98, evidenceAccuracy ?? 0.35));
  return {
    ...effects,
    reliabilityDelta: (effects.reliabilityDelta ?? 0) + accuracy * 0.8,
    stumbleRisk: (effects.stumbleRisk ?? 0) - accuracy * 0.012,
  };
}

export function previewTrainingCampaignIntervention(
  job: Pick<
    TrainingJob,
    "targetPfDays" | "recommendedPfDays" | "progressPfDays"
  >,
  effects: TrainingCampaignChoiceEffects,
) {
  const funded = Math.max(1e-9, job.recommendedPfDays ?? job.targetPfDays);
  const extraCompute = funded * Math.max(0, effects.extraComputeFraction ?? 0);
  const rollback = Math.max(
    0,
    Math.min(0.5, effects.progressRollbackFraction ?? 0),
  );
  return {
    cashCost: Math.max(0, effects.cashCost ?? 0),
    extraPfDays: extraCompute,
    nextFundedPfDays: funded + extraCompute,
    nextProgressPfDays: Math.max(0, job.progressPfDays * (1 - rollback)),
    rollbackFraction: rollback,
    minResearchers: Math.max(0, effects.minResearchers ?? 0),
    capabilityDelta: effects.capabilityDelta ?? 0,
    reliabilityDelta: effects.reliabilityDelta ?? 0,
    safetyDelta: effects.safetyDelta ?? 0,
    breakthroughBias: effects.breakthroughBias ?? 0,
    stumbleRisk: effects.stumbleRisk ?? 0,
    dataQualityDelta: effects.dataQualityDelta ?? 0,
    verifiedRecursiveCapabilityBonus:
      effects.verifiedRecursiveCapabilityBonus ?? 0,
  };
}

function signed(value: number, digits = 2): string {
  const abs = Math.abs(value);
  const shown =
    abs >= 10 ? abs.toFixed(0) : abs.toFixed(digits).replace(/\.?0+$/, "");
  return `${value >= 0 ? "+" : "−"}${shown}`;
}

function signedPct(value: number): string {
  return `${value >= 0 ? "+" : "−"}${(Math.abs(value) * 100).toFixed(1)}%`;
}

export function describeCampaignIntervention(
  effects: TrainingCampaignChoiceEffects,
): string {
  const parts: string[] = [];
  const cash = effects.cashCost ?? 0;
  if (cash > 0) {
    parts.push(
      cash >= 1_000_000
        ? `$${(cash / 1_000_000).toFixed(cash >= 10_000_000 ? 0 : 1)}M`
        : `$${Math.round(cash / 1_000)}k`,
    );
  }
  if ((effects.extraComputeFraction ?? 0) > 0) {
    parts.push(`+${((effects.extraComputeFraction ?? 0) * 100).toFixed(1)}% PF`);
  }
  if ((effects.progressRollbackFraction ?? 0) > 0) {
    parts.push(
      `−${((effects.progressRollbackFraction ?? 0) * 100).toFixed(1)}% progress`,
    );
  }
  if (effects.capabilityDelta)
    parts.push(`${signed(effects.capabilityDelta)} cap`);
  if (effects.reliabilityDelta)
    parts.push(`${signed(effects.reliabilityDelta)} rel`);
  if (effects.safetyDelta) parts.push(`${signed(effects.safetyDelta)} safety`);
  if (effects.stumbleRisk)
    parts.push(`${signedPct(effects.stumbleRisk)} stumble`);
  if (effects.dataQualityDelta)
    parts.push(`${signed(effects.dataQualityDelta)} data`);
  if (effects.breakthroughBias)
    parts.push(`${signedPct(effects.breakthroughBias)} breakthrough`);
  if (effects.minResearchers)
    parts.push(`${effects.minResearchers} researchers`);
  if ((effects.verifiedRecursiveCapabilityBonus ?? 0) > 0) {
    parts.push("verified loop");
  }
  return parts.join(" · ") || "Hold course";
}
