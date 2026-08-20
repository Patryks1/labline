import type { DifficultyId } from "../balance/gameConfig";
import { runPlayBot, type PlayReport } from "./bot";

export const STRATEGY_IDS = [
  "safe_specialist",
  "frontier_rush",
  "data_first",
  "infrastructure_first",
  "distillation_first",
  "open_weights",
  "multimodal",
  "router_portfolio",
  "intentionally_poor",
] as const;

export type StrategyBotId = (typeof STRATEGY_IDS)[number];

export interface StrategyBotReport extends PlayReport {
  strategy: StrategyBotId;
}

/**
 * Named deterministic play policies. They share the live simulation rules;
 * difficulty must not grant free compute, data, or cheaper racks.
 */
export function runStrategyBot(opts: {
  strategy: StrategyBotId;
  seed: number;
  maxDays: number;
  difficulty?: DifficultyId;
}): StrategyBotReport {
  const report = runPlayBot({
    seed: hashStrategySeed(opts.strategy, opts.seed),
    maxDays: opts.maxDays,
    difficulty: opts.difficulty ?? "normal",
  });
  return { ...report, strategy: opts.strategy };
}

export function hashStrategySeed(strategy: StrategyBotId, seed: number): number {
  let hash = 2166136261 >>> 0;
  const text = `${strategy}:${seed}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
