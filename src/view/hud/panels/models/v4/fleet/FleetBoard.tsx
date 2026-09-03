import { EmptyState, HudButton } from "../../../../ui/HudPrimitives";
import { CardGrid } from "../../../../ui/kit";
import { gb, money } from "../../../../format";
import { useGameStore } from "../../../../../../store/gameStore";
import { trainingStateOf } from "../../../../../../sim/training/state";
import { selectFleet } from "../../viewModels/selectors";
import { MonoStat } from "../../ui/MonoStat";
import type { FleetVM } from "../../viewModels/types";
import { EndpointCard } from "./EndpointCard";
import { eligibleCheckpoints, orderFleetEndpoints, trySim } from "./fleetModel";

const EMPTY_FLEET: FleetVM = {
  endpoints: [],
  totalRevenuePerDay: 0,
  totalHbmGB: 0,
};

const ROUTER_NEED_REASON = "Need at least two kept or released checkpoints";

export function FleetBoard({
  onOpenRouter,
  onOpenSunset,
  onSelect,
  selectedId,
  vm: vmProp,
}: {
  onOpenRouter: (endpointId?: string) => void;
  onOpenSunset: (endpointId: string) => void;
  onSelect: (endpointId: string) => void;
  selectedId?: string;
  vm?: FleetVM;
}) {
  const state = useGameStore((s) => s.state);
  const vm =
    vmProp ??
    trySim(() => selectFleet(state), EMPTY_FLEET);
  const checkpoints = trainingStateOf(state, state.playerLabId).checkpoints;
  const routerReady = eligibleCheckpoints(checkpoints).length >= 2;
  const liveCount = vm.endpoints.filter((endpoint) => endpoint.status === "live").length;
  const { live, sunset, retired } = orderFleetEndpoints(vm.endpoints);
  const visible = [...live, ...sunset];

  return (
    <div className="space-y-4 min-w-0" data-fleet-board="true">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-stretch sm:justify-between">
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
          <MonoStat label="Live endpoints" value={String(liveCount)} />
          <MonoStat label="Revenue/day" value={money(vm.totalRevenuePerDay)} />
          <MonoStat label="HBM" value={gb(vm.totalHbmGB)} />
        </div>
        <HudButton
          variant="primary"
          className="flex min-h-11 h-auto shrink-0 items-center justify-center self-stretch sm:min-w-[7.5rem]"
          disabled={!routerReady}
          disabledReason={routerReady ? undefined : ROUTER_NEED_REASON}
          onClick={() => onOpenRouter()}
        >
          New router
        </HudButton>
      </header>

      {vm.endpoints.length === 0 ? (
        <EmptyState
          title="No endpoints yet"
          description="Release a checkpoint from the Pipeline to create your first endpoint."
        />
      ) : null}

      {visible.length > 0 ? (
        <CardGrid min="16rem">
          {visible.map((endpoint) => (
            <EndpointCard
              key={endpoint.id}
              vm={endpoint}
              selected={selectedId === endpoint.id}
              onSelect={onSelect}
              onOpenRouter={onOpenRouter}
              onOpenSunset={onOpenSunset}
            />
          ))}
        </CardGrid>
      ) : null}

      {retired.length > 0 ? (
        <details className="min-w-0 rounded-lg border border-line/65 bg-panel-2/45" data-retired-disclosure="true">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[0.75rem] text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint/60 [&::-webkit-details-marker]:hidden">
            <span>Retired</span>
            <span className="font-mono tabular-nums text-bone">{retired.length}</span>
          </summary>
          <div className="border-t border-line/40 p-3">
            <CardGrid min="16rem">
              {retired.map((endpoint) => (
                <EndpointCard
                  key={endpoint.id}
                  vm={endpoint}
                  selected={selectedId === endpoint.id}
                  onSelect={onSelect}
                  onOpenRouter={onOpenRouter}
                  onOpenSunset={onOpenSunset}
                />
              ))}
            </CardGrid>
          </div>
        </details>
      ) : null}
    </div>
  );
}
