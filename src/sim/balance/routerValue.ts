import type { Model } from "../types";

export interface RoutedValueInput {
  taskQuality: number;
  servingCost: number;
  latencyPenalty: number;
  misroutingRisk: number;
  routerOverhead: number;
}

// V4-DELETE: legacy routed-value composite; V4 uses compositeCapabilities in training/endpoints.
export function expectedRoutedValue(input: RoutedValueInput): number {
  return (
    Math.max(0, input.taskQuality) -
    Math.max(0, input.servingCost) -
    Math.max(0, input.latencyPenalty) -
    Math.max(0, input.misroutingRisk) -
    Math.max(0, input.routerOverhead)
  );
}

export function routerInventedCapability(
  models: readonly Pick<Model, "io">[],
  modality: "image" | "video" | "audio",
): boolean {
  return models.some(
    (model) =>
      (model.io?.inputs[modality] ?? 0) > 0 || (model.io?.outputs[modality] ?? 0) > 0,
  );
}

export function demandInertiaShare(input: {
  previousShare: number;
  targetShare: number;
  switchingFriction?: number;
}): number {
  const inertia = Math.max(0, Math.min(0.995, input.switchingFriction ?? 0.72));
  return input.previousShare * inertia + input.targetShare * (1 - inertia);
}
