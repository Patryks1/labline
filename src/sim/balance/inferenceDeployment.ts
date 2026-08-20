import type { Model, ServePrecision } from "../types";
import { estimateServingMemory } from "./tokenServe";

export interface ReplicaFit {
  residentMemoryGb: number;
  devicesPerReplica: number;
  replicas: number;
  extraDevices: number;
}

export function devicesPerReplica(input: {
  residentMemoryGb: number;
  hbmGbPerDevice: number;
}): number {
  const hbm = Math.max(0, input.hbmGbPerDevice);
  if (hbm <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil((Math.max(0, input.residentMemoryGb) - 1e-9) / hbm));
}

export function replicaLayout(input: {
  model: Pick<Model, "paramsB" | "activeParamsB" | "family">;
  precision?: ServePrecision;
  contextTokens?: number;
  concurrency?: number;
  availableDevices: number;
  hbmGbPerDevice: number;
}): ReplicaFit {
  const memory = estimateServingMemory({
    model: input.model,
    precision: input.precision ?? "bf16",
    avgInputTokens: input.contextTokens ?? 1_024,
    avgOutputTokens: 1,
    concurrentRequests: Math.max(1, input.concurrency ?? 1),
  });
  const perReplica = devicesPerReplica({
    residentMemoryGb: memory.residentMemoryGb,
    hbmGbPerDevice: input.hbmGbPerDevice,
  });
  const available = Math.max(0, Math.floor(input.availableDevices));
  const replicas =
    Number.isFinite(perReplica) && perReplica > 0
      ? Math.floor(available / perReplica)
      : 0;
  return {
    residentMemoryGb: memory.residentMemoryGb,
    devicesPerReplica: perReplica,
    replicas,
    extraDevices: Math.max(0, available - replicas * (Number.isFinite(perReplica) ? perReplica : 0)),
  };
}

export function dailyDecodeCapacity(input: {
  singleStreamTokPerSec: number;
  replicas: number;
  utilisation?: number;
}): number {
  const rate = Math.max(0, input.singleStreamTokPerSec);
  const replicas = Math.max(0, input.replicas);
  const util = Math.max(0, Math.min(1, input.utilisation ?? 0.7));
  return rate * replicas * util * 86_400;
}

export function trainingPaybackDays(input: {
  trainingInvestmentGbp: number;
  dailyContributionGbp: number;
}): number | null {
  const investment = Math.max(0, input.trainingInvestmentGbp);
  const daily = input.dailyContributionGbp;
  if (!(daily > 0) || investment <= 0) return null;
  return investment / daily;
}

export function unitGrossMargin(input: {
  listPrice: number;
  servingCost: number;
}): number {
  const price = Math.max(0, input.listPrice);
  if (price <= 0) return 0;
  return (price - Math.max(0, input.servingCost)) / price;
}
