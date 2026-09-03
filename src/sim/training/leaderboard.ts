import type { CapabilityDomain, Model, SimState } from "../types";
import {
  currentSeason,
  deflatePublicScore,
  overallFromDomainScores,
  publicScoresForBudget,
} from "./evaluate";
import { TRAINING_V4 } from "./constants";
import { trainingStateOf } from "./state";
import type { EvalMetric, TierBudget } from "./types";

export interface LeaderboardRow {
  labId: string;
  labName: string;
  entryId: string;
  name: string;
  kind: "endpoint" | "legacyModel";
  isPlayer: boolean;
  tierBudget: TierBudget;
  scores: Partial<Record<EvalMetric, number>>;
  overall: number;
  season: number;
  contaminated: EvalMetric[];
}

const DOMAIN_LIST: readonly CapabilityDomain[] = [
  "language",
  "reasoning",
  "code",
  "math",
  "science",
  "vision",
  "video",
  "audio",
  "tools",
];

function emptyDomains(value: number): Record<CapabilityDomain, number> {
  return {
    language: value,
    reasoning: value,
    code: value,
    math: value,
    science: value,
    vision: value,
    video: value,
    audio: value,
    tools: value,
  };
}

function isLiveLegacyModel(model: Model): boolean {
  return model.release === "released" && model.commerciallyOffered === true;
}

function legacyScores(state: SimState, model: Model): Partial<Record<EvalMetric, number>> {
  const difficulty = currentSeason(state).difficultyIndex;
  const domains = model.capabilities?.domains ?? emptyDomains(model.capability);
  const scores: Partial<Record<EvalMetric, number>> = {};
  for (const domain of DOMAIN_LIST) {
    scores[domain] = Math.round(deflatePublicScore(domains[domain] ?? 0, difficulty) * 10) / 10;
  }
  if (model.capabilities) {
    scores.safety = Math.round(deflatePublicScore(model.capabilities.safety, difficulty) * 10) / 10;
    scores.steerability = Math.round(
      deflatePublicScore(model.capabilities.steerability, difficulty) * 10,
    ) / 10;
    scores.reliability = Math.round(
      deflatePublicScore(model.capabilities.reliability, difficulty) * 10,
    ) / 10;
  }
  const deflatedDomains: Partial<Record<CapabilityDomain, number>> = {};
  for (const domain of DOMAIN_LIST) deflatedDomains[domain] = scores[domain];
  scores.overall = Math.round(overallFromDomainScores(deflatedDomains) * 10) / 10;
  return scores;
}

function rowFromScores(
  args: {
    labId: string;
    labName: string;
    entryId: string;
    name: string;
    kind: LeaderboardRow["kind"];
    isPlayer: boolean;
    tierBudget: TierBudget;
    scores: Partial<Record<EvalMetric, number>>;
    season: number;
    contaminated: EvalMetric[];
  },
): LeaderboardRow | null {
  if (Object.keys(args.scores).length === 0) return null;
  return {
    ...args,
    overall: args.scores.overall ?? 0,
  };
}

export function leaderboardRows(state: SimState, tierBudget: TierBudget): LeaderboardRow[] {
  const season = currentSeason(state);
  const rows: LeaderboardRow[] = [];

  const playerSlice = trainingStateOf(state, state.playerLabId);
  for (const endpoint of playerSlice.endpoints) {
    if (endpoint.status !== "live") continue;
    const row = rowFromScores({
      labId: state.playerLabId,
      labName: state.player.name,
      entryId: endpoint.id,
      name: endpoint.name,
      kind: "endpoint",
      isPlayer: true,
      tierBudget,
      scores: publicScoresForBudget(state, endpoint.id, tierBudget),
      season: season.season,
      contaminated: season.contamination[endpoint.id] ?? [],
    });
    if (row) rows.push(row);
  }

  for (const rival of state.rivals) {
    const slice = trainingStateOf(state, rival.id);
    if (slice.endpoints.length > 0) {
      for (const endpoint of slice.endpoints) {
        if (endpoint.status !== "live") continue;
        const row = rowFromScores({
          labId: rival.id,
          labName: rival.name,
          entryId: endpoint.id,
          name: endpoint.name,
          kind: "endpoint",
          isPlayer: false,
          tierBudget,
          scores: publicScoresForBudget(state, endpoint.id, tierBudget),
          season: season.season,
          contaminated: season.contamination[endpoint.id] ?? [],
        });
        if (row) rows.push(row);
      }
      continue;
    }
    for (const model of rival.models) {
      if (!isLiveLegacyModel(model)) continue;
      const row = rowFromScores({
        labId: rival.id,
        labName: rival.name,
        entryId: model.id,
        name: model.name,
        kind: "legacyModel",
        isPlayer: false,
        tierBudget,
        scores: legacyScores(state, model),
        season: season.season,
        contaminated: season.contamination[model.id] ?? [],
      });
      if (row) rows.push(row);
    }
  }

  rows.sort((a, b) => b.overall - a.overall || a.name.localeCompare(b.name));
  return rows;
}

export function playerBestOverall(state: SimState): number | null {
  let best: number | null = null;
  for (const budget of TRAINING_V4.postTrain.tierBudgets) {
    for (const row of leaderboardRows(state, budget)) {
      if (!row.isPlayer) continue;
      if (best == null || row.overall > best) best = row.overall;
    }
  }
  return best;
}

export function frontierOverall(state: SimState): number {
  let best = 0;
  for (const budget of TRAINING_V4.postTrain.tierBudgets) {
    for (const row of leaderboardRows(state, budget)) {
      if (row.overall > best) best = row.overall;
    }
  }
  return best;
}
