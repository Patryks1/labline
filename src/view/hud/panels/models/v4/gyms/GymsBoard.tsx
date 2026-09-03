import { useGameStore } from "../../../../../../store/gameStore";
import { CardGrid, GameCard } from "../../../../ui/kit";
import { HudButton } from "../../../../ui/HudPrimitives";
import { money, num } from "../../../../format";
import { MonoStat } from "../../ui/MonoStat";
import { selectGyms } from "../../viewModels/selectors";
import type { GymsVM } from "../../viewModels/types";
import { trySim } from "../fleet/fleetModel";
import { GymCard } from "./GymCard";
import { GYM_COPY, GYM_CREATE_CASH, GYM_KINDS } from "./gymModel";

const EMPTY_GYMS: GymsVM = {
  gyms: [],
  pools: {
    instructionMTok: 0,
    preferenceMTok: 0,
    verifiableTasks: 0,
    toolTrajectories: 0,
  },
};

export function GymsBoard({
  onSelect,
  selectedId,
  vm: vmProp,
}: {
  onSelect: (gymId: string) => void;
  selectedId?: string;
  vm?: GymsVM;
}) {
  const state = useGameStore((s) => s.state);
  const createGym = useGameStore((s) => s.createGym);
  const vm = vmProp ?? trySim(() => selectGyms(state), EMPTY_GYMS);
  const byKind = new Map(vm.gyms.map((gym) => [gym.kind, gym]));
  const seedCost = GYM_CREATE_CASH;

  return (
    <div className="space-y-4 min-w-0" data-gyms-board="true">
      <header className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MonoStat label="Instruction" value={`${num(vm.pools.instructionMTok, 1)} MTok`} />
        <MonoStat label="Preference" value={`${num(vm.pools.preferenceMTok, 1)} MTok`} />
        <MonoStat label="Verifiable tasks" value={num(vm.pools.verifiableTasks, 0)} />
        <MonoStat label="Tool trajectories" value={num(vm.pools.toolTrajectories, 0)} />
      </header>

      <div data-gym-slots="true">
        <CardGrid min="16rem">
          {GYM_KINDS.map((kind) => {
            const existing = byKind.get(kind);
            if (existing) {
              return (
                <GymCard
                  key={existing.id}
                  vm={existing}
                  selected={selectedId === existing.id}
                  onSelect={onSelect}
                />
              );
            }
            const copy = GYM_COPY[kind];
            return (
              <GameCard
                key={kind}
                eyebrow="Empty slot"
                title={copy.title}
                className="min-w-0"
              >
                <div className="space-y-2" data-build-gym={kind}>
                  <p className="text-[0.75rem] text-muted">{copy.blurb}</p>
                  <p className="font-mono text-[0.6875rem] tabular-nums text-muted">
                    Opens at tier 0 · {money(seedCost)} · campus grows with monthly spend
                  </p>
                  <HudButton
                    variant="primary"
                    className="min-h-11"
                    onClick={() => {
                      trySim(() => {
                        createGym(kind);
                      }, undefined);
                    }}
                  >
                    Build gym
                  </HudButton>
                </div>
              </GameCard>
            );
          })}
        </CardGrid>
      </div>
    </div>
  );
}
