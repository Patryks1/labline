import { defaultServePrecisionForModel, estimateServingMemory } from "../balance/tokenServe";
import { soldApiRouters, releasedRouterMemberIds } from "../balance/modelRouter";
import { planExposedModelIdsWithEndpoints } from "./plans";
import { endpointHbmGB } from "../training/endpoints";
import { trainingStateOf } from "../training/state";
import type {
  Model,
  ModelRouter,
  ProductPricing,
  ServePrecision,
  SimState,
} from "../types";
import { isLivePublicModel, isV4ProjectedModel } from "../modelRelease";

export interface HostedServingPlacement {
  model: Model;
  precision: ServePrecision;
  concurrentRequests: number;
  contextTokens: number;
  memory: ReturnType<typeof estimateServingMemory>;
}

export interface ServingPlacementNeed {
  placements: HostedServingPlacement[];
  hbmNeedGb: number;
  systemRamNeedGb: number;
}

function publicModels(models: Model[]): Model[] {
  return models.filter(isLivePublicModel);
}

/** Models that must be resident at once for the active API and enabled plans. */
export function hostedServingModels(input: {
  models: Model[];
  pricing: ProductPricing;
  modelRouters?: readonly ModelRouter[];
  activeModelRouterId?: string | null;
}): Model[] {
  const published = publicModels(input.models);
  if (published.length === 0) return [];
  const fallback = published.find(
    (model) => model.id === input.pricing.activeModelId,
  ) ?? [...published].sort((a, b) => b.capability - a.capability)[0];
  const publicIds = new Set(published.map((model) => model.id));
  const apiIds = new Set(
    (input.pricing.apiModelIds ?? (fallback ? [fallback.id] : [])).filter(
      (id) => publicIds.has(id),
    ),
  );
  for (const model of published) {
    if (isV4ProjectedModel(model)) apiIds.add(model.id);
  }
  for (const router of soldApiRouters({
    apiRouterIds: input.pricing.apiRouterIds,
    apiModelIds: input.pricing.apiModelIds,
    activeModelRouterId: input.activeModelRouterId,
    routers: input.modelRouters,
    models: input.models,
  })) {
    for (const id of releasedRouterMemberIds(router, input.models)) {
      if (publicIds.has(id)) apiIds.add(id);
    }
  }
  const subscriptionIds = new Set<string>();
  for (const plan of input.pricing.plans) {
    if (!plan.enabled) continue;
    for (const id of planExposedModelIdsWithEndpoints(
      plan,
      input.models,
      input.modelRouters,
    )) {
      if (publicIds.has(id)) subscriptionIds.add(id);
    }
  }
  if (subscriptionIds.size === 0 && fallback) subscriptionIds.add(fallback.id);
  const ids = new Set([...apiIds, ...subscriptionIds]);
  const selected = published.filter((model) => ids.has(model.id));
  return selected;
}

/** Use the highest-memory precision promised by any channel serving the model. */
export function servingPrecisionForModel(
  pricing: ProductPricing,
  model: Model,
  apiListed = true,
  routers?: readonly ModelRouter[],
): ServePrecision {
  const candidates: ServePrecision[] = [
    ...(apiListed
      ? [
          pricing.apiServePrecisionByModel?.[model.id] ??
            defaultServePrecisionForModel(model),
        ]
      : []),
    ...pricing.plans
      .filter(
        (plan) =>
          plan.enabled &&
          planExposedModelIdsWithEndpoints(plan, [model], routers).includes(model.id),
      )
      .map(
        (plan) =>
          plan.servePrecisionByModel?.[model.id] ??
          defaultServePrecisionForModel(model),
      ),
  ];
  return (
    candidates.sort(
      (a, b) =>
        estimateServingMemory({ model, precision: b }).residentMemoryGb -
        estimateServingMemory({ model, precision: a }).residentMemoryGb,
    )[0] ?? defaultServePrecisionForModel(model)
  );
}

/** Shared placement calculation used by both capacity admission and the HUD. */
export function servingPlacementNeedForLab(input: {
  models: Model[];
  pricing: ProductPricing;
  demandMTok: number;
  modelRouters?: readonly ModelRouter[];
  activeModelRouterId?: string | null;
}): ServingPlacementNeed {
  const models = hostedServingModels(input);
  if (models.length === 0) {
    return { placements: [], hbmNeedGb: 0, systemRamNeedGb: 0 };
  }
  const averageRequestTokens = 1_408;
  const peakConcurrency = Math.max(
    1,
    Math.ceil(
      ((Math.max(0, input.demandMTok) * 1e6) /
        averageRequestTokens /
        86_400) *
        12,
    ),
  );
  const concurrentRequests = Math.max(
    1,
    Math.ceil(peakConcurrency / models.length),
  );
  const apiIds = new Set(input.pricing.apiModelIds ?? []);
  for (const router of soldApiRouters({
    apiRouterIds: input.pricing.apiRouterIds,
    apiModelIds: input.pricing.apiModelIds,
    activeModelRouterId: input.activeModelRouterId,
    routers: input.modelRouters,
    models: input.models,
  })) {
    for (const id of releasedRouterMemberIds(router, input.models)) {
      apiIds.add(id);
    }
  }
  const implicitApiFallback = input.pricing.apiModelIds == null;
  const placements = models.map((model) => {
    const precision = servingPrecisionForModel(
      input.pricing,
      model,
      apiIds.has(model.id) ||
        (implicitApiFallback && model.id === input.pricing.activeModelId),
      input.modelRouters,
    );
    const contextTokens = Math.max(
      1_024,
      Math.round((model.contextK ?? 1) * 1_024),
    );
    return {
      model,
      precision,
      concurrentRequests,
      contextTokens,
      memory: estimateServingMemory({
        model,
        precision,
        concurrentRequests,
        avgInputTokens: contextTokens,
      }),
    };
  });
  return {
    placements,
    hbmNeedGb: placements.reduce(
      (sum, placement) => sum + placement.memory.residentMemoryGb,
      0,
    ),
    systemRamNeedGb: placements.reduce(
      (sum, placement) => sum + placement.memory.requiredSystemRamGb,
      0,
    ),
  };
}

export function servingPlacementNeed(state: SimState): ServingPlacementNeed {
  const need = servingPlacementNeedForLab({
    models: state.player.models,
    pricing: state.player.pricing,
    modelRouters: state.player.modelRouters,
    activeModelRouterId: state.player.activeModelRouterId,
    demandMTok: state.lastMarket?.playerDemandMTok ?? 0,
  });
  const training = trainingStateOf(state, state.playerLabId);
  if (training.endpoints.length === 0) return need;
  const placements = need.placements.map((placement) => {
    const endpoint = training.endpoints.find(
      (entry) =>
        entry.id === placement.model.endpointId ||
        entry.id === placement.model.id,
    );
    if (!endpoint) return placement;
    const residentMemoryGb = endpointHbmGB(state, endpoint);
    return {
      ...placement,
      memory: {
        ...placement.memory,
        weightMemoryGb: residentMemoryGb / 1.15,
        residentMemoryGb,
      },
    };
  });
  return {
    placements,
    hbmNeedGb: placements.reduce(
      (sum, placement) => sum + placement.memory.residentMemoryGb,
      0,
    ),
    systemRamNeedGb: placements.reduce(
      (sum, placement) => sum + placement.memory.requiredSystemRamGb,
      0,
    ),
  };
}
