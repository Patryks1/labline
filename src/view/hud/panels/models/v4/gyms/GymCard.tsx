import { GameCard } from "../../../../ui/kit";
import { HudButton, HudMeter, HudSelect, StatusChip } from "../../../../ui/HudPrimitives";
import { SliderField } from "../../../../ui/SliderField";
import { money, num, pct } from "../../../../format";
import { useGameStore } from "../../../../../../store/gameStore";
import type { GymCardVM } from "../../viewModels/types";
import {
  GYM_BUDGET_MONTH_MAX,
  GYM_BUDGET_MONTH_STEP,
  GYM_COPY,
  GYM_DAYS_PER_MONTH,
  GYM_RESEARCH_SHARE_MAX,
  GYM_RESEARCH_SHARE_STEP,
  GYM_RESEARCHER_MAX,
} from "./gymModel";
import { trySim } from "../fleet/fleetModel";

const BOTTLENECK_COPY: Record<NonNullable<GymCardVM["bottleneck"]>, string> = {
  researchers: "Starved for researchers",
  compute: "Starved for research compute",
  budget: "Starved for operating budget",
};

function graderCopy(vm: GymCardVM): string {
  if (vm.synthUnlocked) return "Need a researcher or an AI teacher";
  return "Need a researcher";
}

export function GymCard({
  vm,
  onSelect,
  selected = false,
}: {
  vm: GymCardVM;
  onSelect: (gymId: string) => void;
  selected?: boolean;
}) {
  const assignGymResearchers = useGameStore((s) => s.assignGymResearchers);
  const assignGymResearchShare = useGameStore((s) => s.assignGymResearchShare);
  const assignGymMonthlyBudget = useGameStore((s) => s.assignGymMonthlyBudget);
  const assignGymTeacher = useGameStore((s) => s.assignGymTeacher);
  const assignGymAuditShare = useGameStore((s) => s.assignGymAuditShare);
  const cleanPostTrainPool = useGameStore((s) => s.cleanPostTrainPool);
  const copy = GYM_COPY[vm.kind];
  const monthly = Math.round(vm.budgetPerDay * GYM_DAYS_PER_MONTH);
  const researcherMax = Math.max(vm.researchers, vm.researchers + vm.spareResearchers);
  const computeMax = Math.max(
    vm.researchShare,
    vm.researchShare + vm.spareResearchShare,
  );
  const yieldLabel = vm.yieldUnit === "preferenceMTok" ? "pref MTok/day" : "tasks/day";

  return (
    <GameCard
      eyebrow={copy.title}
      title={copy.blurb}
      selected={selected}
      live={vm.yieldPerDay > 0}
      tone="research"
      className="min-w-0"
      onActivate={() => onSelect(vm.id)}
    >
      <div className="space-y-3" data-gym-card={vm.id} data-gym-kind={vm.kind}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" aria-label={`Tier ${vm.tier} of 3`}>
            {[0, 1, 2, 3].map((pip) => (
              <span
                key={pip}
                className={`h-2 w-2 rounded-full ${
                  pip <= vm.tier ? "bg-research" : "bg-line"
                }`}
                data-tier-pip={pip}
                data-tier-filled={pip <= vm.tier ? "true" : "false"}
              />
            ))}
          </div>
          <StatusChip tone="research">Tier {vm.tier}</StatusChip>
        </div>

        <HudMeter
          label="Quality"
          value={vm.quality}
          detail={`${Math.round(vm.quality * 100)}%`}
          tone="research"
        />

        <p className="font-mono text-sm tabular-nums text-bone">
          {num(vm.yieldPerDay, vm.yieldUnit === "preferenceMTok" ? 2 : 1)}{" "}
          <span className="text-[0.6875rem] text-muted">{yieldLabel}</span>
        </p>
        {vm.pausedForCash ? (
          <p className="text-[0.6875rem] text-amber">Paused — operating budget exceeds cash.</p>
        ) : vm.needsGrader ? (
          <p className="text-[0.6875rem] text-amber">{graderCopy(vm)}</p>
        ) : vm.bottleneck ? (
          <p className="text-[0.6875rem] text-amber">{BOTTLENECK_COPY[vm.bottleneck]}</p>
        ) : null}

        <div className="space-y-2.5">
          <div data-gym-slider={`${vm.id}-researchers`}>
            <SliderField
              label="Researchers"
              value={vm.researchers}
              min={0}
              max={Math.min(GYM_RESEARCHER_MAX, researcherMax)}
              step={1}
              colorClass="bg-research"
              format={(value) => String(Math.round(value))}
              onChange={(value) => {
                trySim(() => {
                  assignGymResearchers(vm.id, Math.round(value));
                }, undefined);
              }}
            />
          </div>
          <div data-gym-slider={`${vm.id}-compute`}>
            <SliderField
              label="Research compute"
              value={vm.researchShare}
              min={0}
              max={Math.min(GYM_RESEARCH_SHARE_MAX, computeMax)}
              step={GYM_RESEARCH_SHARE_STEP}
              colorClass="bg-research"
              format={(value) => pct(value, 0)}
              onChange={(value) => {
                trySim(() => {
                  assignGymResearchShare(vm.id, value);
                }, undefined);
              }}
            />
          </div>
          <div data-gym-slider={`${vm.id}-budget`}>
            <SliderField
              label="Budget / mo"
              value={monthly}
              min={0}
              max={GYM_BUDGET_MONTH_MAX}
              step={GYM_BUDGET_MONTH_STEP}
              colorClass="bg-research"
              format={(value) => money(value)}
              onChange={(value) => {
                trySim(() => {
                  assignGymMonthlyBudget(vm.id, value);
                }, undefined);
              }}
            />
          </div>
          <div data-gym-slider={`${vm.id}-audit`}>
            <SliderField
              label="Audit & clean"
              value={vm.auditShare}
              min={0}
              max={1}
              step={0.05}
              colorClass="bg-research"
              format={(value) => pct(value, 0)}
              hoverContent={
                <p className="text-[0.75rem] text-muted">
                  Keep fewer tasks and raise the emit grade. HQ pools train stronger
                  post-train recipes.
                </p>
              }
              onChange={(value) => {
                trySim(() => {
                  assignGymAuditShare(vm.id, value);
                }, undefined);
              }}
            />
          </div>
        </div>

        {vm.synthUnlocked ? (
          <label className="block text-[0.6875rem] text-muted">
            AI teacher
            <HudSelect
              className="mt-1 min-h-11"
              data-gym-teacher={vm.id}
              value={vm.teacherCheckpointId ?? ""}
              onChange={(event) => {
                trySim(() => {
                  assignGymTeacher(vm.id, event.target.value);
                }, undefined);
              }}
            >
              <option value="">Researchers only</option>
              {vm.teachers.map((teacher) => (
                <option key={teacher.id} value={teacher.id}>
                  {teacher.name}
                </option>
              ))}
            </HudSelect>
            <span className="mt-1 block text-[0.6875rem] text-muted">
              Teachers are less efficient than researchers and need more compute.
            </span>
          </label>
        ) : (
          <p className="text-[0.6875rem] text-muted" data-gym-teacher-locked={vm.id}>
            Unlock Synthetic Generators to assign an AI teacher. Teachers are less
            efficient and burn more research compute.
          </p>
        )}

        <div className="space-y-1.5">
          <p className="text-[0.6875rem] text-muted">
            Pool grade {pct(vm.poolQuality, 0)} · {num(vm.poolAmount, vm.yieldUnit === "preferenceMTok" ? 2 : 0)}{" "}
            stored
          </p>
          <HudButton
            variant="secondary"
            className="min-h-11"
            data-gym-clean={vm.id}
            disabled={!vm.canClean}
            disabledReason={
              vm.poolAmount <= 0
                ? "No stored tasks to clean."
                : "Not enough cash to audit this pool."
            }
            onClick={() => {
              trySim(() => {
                cleanPostTrainPool(vm.poolKind);
              }, undefined);
            }}
          >
            Clean pool {vm.cleanCash > 0 ? money(vm.cleanCash) : ""}
          </HudButton>
        </div>

        {vm.nextTierMonthly != null ? (
          <p className="text-[0.6875rem] text-muted">
            Campus grows automatically at {money(vm.nextTierMonthly)}/mo
          </p>
        ) : (
          <StatusChip tone="positive">Max campus</StatusChip>
        )}
      </div>
    </GameCard>
  );
}
