import { useState } from "react";
import { Graph, Plus, Trash } from "@phosphor-icons/react";
import type { Model, ModelRouter, ModelRouterLane } from "../../../../sim/types";
import { isLivePublicModel } from "../../../../sim/modelRelease";
import {
  ROUTER_LANE_META,
  ROUTER_LANES,
  ROUTER_UNLOCK_RESEARCH,
  normalizeModelRouters,
  routerUnlocked,
} from "../../../../sim/balance/modelStudio";
import {
  composeRouterModel,
  publicRouterParts,
  routerLaneScore,
  routerUnitCostPf,
  strongestModelForLane,
} from "../../../../sim/balance/modelRouter";
import { GameCard } from "../../ui/kit";
import {
  EmptyState,
  HudButton,
  HudInput,
  HudSelect,
  StatusChip,
} from "../../ui/HudPrimitives";
import { ResearchUnlockLink } from "../../ui/ResearchUnlockLink";

export function RoutersTab({
  routers,
  activeRouterId,
  models,
  onCreate,
  onSetLane,
  onActivate,
  onDelete,
  researchUnlocked,
}: {
  routers?: readonly ModelRouter[];
  activeRouterId?: string | null;
  models: readonly Model[];
  researchUnlocked?: readonly string[];
  onCreate: (name: string) => void;
  onSetLane: (
    routerId: string,
    lane: ModelRouterLane,
    modelId: string | null,
  ) => void;
  onActivate: (routerId: string | null) => void;
  onDelete: (routerId: string) => void;
}) {
  const [name, setName] = useState("");
  const list = normalizeModelRouters(routers);
  const released = models.filter(isLivePublicModel);
  const internal = models.filter((model) => !isLivePublicModel(model));
  const unlocked = routerUnlocked(researchUnlocked);

  if (!unlocked) {
    return (
      <div className="space-y-3" data-models-routers="true">
        <EmptyState
          title="Router locked"
          description="Research Model Router to assign one specialist per category and mix them on the board."
        />
        <ResearchUnlockLink
          nodeId={ROUTER_UNLOCK_RESEARCH}
          label="Unlock Model Router"
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-models-routers="true">
      <section className="rounded-lg border border-line/65 bg-panel-2/45 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="hud-eyebrow">Serving routers</p>
            <h3 className="mt-1 text-sm font-semibold text-bone">
              One specialist per category. Chat, code, math, and science each pick a model.
            </h3>
            <p className="mt-1 max-w-3xl text-[0.6875rem] leading-5 text-muted">
              Live routers show on the public board as a blend. Subs and API
              use the mix more when it is capable and fairly priced.
            </p>
          </div>
          <Graph size="1.25rem" className="text-mint" weight="duotone" />
        </div>
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(name.trim());
            setName("");
          }}
        >
          <label className="min-w-0 flex-1 text-[0.6875rem] text-muted">
            Router name
            <HudInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production mix"
              className="mt-1 min-h-11 w-full"
            />
          </label>
          <HudButton type="submit" variant="primary" className="min-h-11">
            <Plus size="0.85rem" />
            Create router
          </HudButton>
          {activeRouterId ? (
            <HudButton
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => onActivate(null)}
            >
              Use automatic mix
            </HudButton>
          ) : null}
        </form>
      </section>

      {list.length === 0 ? (
        <EmptyState
          title="No routers yet"
          description="Create a named mix, assign released models to lanes, then activate it. Until then, plans keep the automatic quality/efficiency mix."
        />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {list.map((router) => {
            const active = router.id === activeRouterId;
            const parts = publicRouterParts(router, models);
            const composed = composeRouterModel(router, parts);
            const costPf = routerUnitCostPf(parts);
            return (
              <GameCard
                key={router.id}
                eyebrow={active ? "Live" : "Draft"}
                title={router.name}
                tone={active ? "mint" : undefined}
                selected={active}
                actions={
                  <StatusChip tone={active ? "positive" : "neutral"}>
                    {active ? "serving" : "idle"}
                  </StatusChip>
                }
              >
                <div className="grid gap-2">
                  {ROUTER_LANES.map((lane) => {
                    const rankedReleased = [...released].sort(
                      (a, b) =>
                        routerLaneScore(b, lane) - routerLaneScore(a, lane),
                    );
                    const rankedInternal = [...internal].sort(
                      (a, b) =>
                        routerLaneScore(b, lane) - routerLaneScore(a, lane),
                    );
                    const strongest = strongestModelForLane(
                      [...released, ...internal],
                      lane,
                    );
                    return (
                      <label
                        key={lane}
                        className="grid gap-1 text-[0.6875rem] text-muted"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <strong className="text-bone">
                            {ROUTER_LANE_META[lane].label}
                          </strong>
                          <span className="text-[0.625rem]">
                            {ROUTER_LANE_META[lane].blurb}
                          </span>
                        </span>
                        <HudSelect
                          value={router.lanes[lane] ?? ""}
                          onChange={(event) =>
                            onSetLane(
                              router.id,
                              lane,
                              event.target.value || null,
                            )
                          }
                          className="min-h-11 w-full text-[0.75rem]"
                        >
                          <option value="">Unassigned</option>
                          {rankedReleased.length > 0 ? (
                            <optgroup label="Released">
                              {rankedReleased.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.name} ·{" "}
                                  {routerLaneScore(model, lane).toFixed(0)}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                          {rankedInternal.length > 0 ? (
                            <optgroup label="Internal (draft until release)">
                              {rankedInternal.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.name} ·{" "}
                                  {routerLaneScore(model, lane).toFixed(0)}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                        </HudSelect>
                        {strongest && router.lanes[lane] !== strongest.id ? (
                          <span className="text-[0.625rem] text-muted">
                            Strongest {ROUTER_LANE_META[lane].label.toLowerCase()}
                            : {strongest.name}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
                {composed ? (
                  <p className="mt-2 font-mono text-[0.625rem] tabular-nums text-muted">
                    Board mix cap {composed.capability.toFixed(0)} · code{" "}
                    {composed.benchmarks.coding.toFixed(0)} · math{" "}
                    {composed.benchmarks.math.toFixed(0)} · {costPf.toFixed(3)} PF/MTok
                  </p>
                ) : (
                  <p className="mt-2 text-[0.625rem] text-muted">
                    Assign released models to see the board mix.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <HudButton
                    type="button"
                    variant={active ? "secondary" : "primary"}
                    onClick={() => onActivate(active ? null : router.id)}
                  >
                    {active ? "Deactivate" : "Make live"}
                  </HudButton>
                  <HudButton
                    type="button"
                    variant="danger"
                    onClick={() => onDelete(router.id)}
                  >
                    <Trash size="0.85rem" />
                    Delete
                  </HudButton>
                </div>
              </GameCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
