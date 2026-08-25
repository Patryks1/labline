import { Code, Flask, Function as FunctionIcon, MagnifyingGlass, Terminal } from "@phosphor-icons/react";
import type { PostTrainGym, PostTrainGymKind, ToolSkill, ToolSkillId } from "../../../../sim/types";
import {
  GYM_PACKAGES,
  GYM_UNLOCK_RESEARCH,
  POST_TRAIN_GYM_KINDS,
  POST_TRAIN_GYM_META,
  TOOL_PACKAGES,
  TOOL_SKILL_META,
  gymUnlocked,
  normalizePostTrainGyms,
  normalizeToolSkills,
  packageTotalCash,
} from "../../../../sim/balance/modelStudio";
import { money } from "../../format";
import { GameCard, MeterBar } from "../../ui/kit";
import { HudButton, HudInput, HudRange, StatusChip } from "../../ui/HudPrimitives";
import { ResearchUnlockLink } from "../../ui/ResearchUnlockLink";

const TOOL_ICONS: Record<ToolSkillId, typeof Code> = {
  json: FunctionIcon,
  grep: MagnifyingGlass,
  python: Code,
  shell: Terminal,
  web: Flask,
};

export function TrainingLabsPicker({
  gyms,
  researchUnlocked,
  selected,
  onChange,
}: {
  gyms?: readonly PostTrainGym[];
  researchUnlocked: readonly string[];
  selected: readonly PostTrainGymKind[];
  onChange: (kinds: PostTrainGymKind[]) => void;
}) {
  const normalized = normalizePostTrainGyms(gyms);
  const selectedSet = new Set(selected);
  return (
    <div
      className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3"
      data-training-labs-picker="true"
    >
      {normalized.map((gym) => {
        const meta = POST_TRAIN_GYM_META[gym.kind];
        const unlocked = gymUnlocked(gym.kind, researchUnlocked);
        const on = selectedSet.has(gym.kind);
        return (
          <HudButton
            key={gym.id}
            type="button"
            variant="ghost"
            disabled={!unlocked}
            aria-pressed={on}
            title={
              unlocked
                ? `${meta.blurb} Quality ${Math.round(gym.quality * 100)}%.`
                : `Research ${meta.unlock} to attach this lab.`
            }
            className={`!min-h-11 !justify-start !rounded-md !border !px-2.5 !py-2 !text-left ${
              on
                ? "!border-research/50 !bg-research/10"
                : "!border-line/70 !bg-void/30"
            }`}
            onClick={() => {
              if (!unlocked) return;
              onChange(
                on
                  ? selected.filter((kind) => kind !== gym.kind)
                  : [...selected, gym.kind],
              );
            }}
          >
            <span className="block text-[0.75rem] font-semibold text-bone">
              {meta.name}
            </span>
            <span className="mt-0.5 block font-mono text-[0.625rem] text-muted">
              {unlocked
                ? `${Math.round(gym.quality * 100)}% · ${on ? "on run" : "off"}`
                : "locked"}
            </span>
          </HudButton>
        );
      })}
    </div>
  );
}

export function LabsTab({
  cash,
  gyms,
  tools,
  researchUnlocked,
  onInvestGym,
  onSetGymAllocation,
  onTeachTool,
  researchAllocation,
}: {
  cash: number;
  gyms?: readonly PostTrainGym[];
  tools?: readonly ToolSkill[];
  researchUnlocked: readonly string[];
  onInvestGym: (kind: PostTrainGymKind, packageId: string) => void;
  onSetGymAllocation: (
    kind: PostTrainGymKind,
    allocation: { assignedResearchers?: number; researchShare?: number },
  ) => void;
  onTeachTool: (skillId: ToolSkillId, packageId: string) => void;
  researchAllocation: {
    dataShare: number;
    safetyShare: number;
    employedResearchers: number;
    podResearchers: number;
    fixedResearchers: number;
  };
}) {
  const normalizedGyms = normalizePostTrainGyms(gyms);
  const normalizedTools = normalizeToolSkills(tools);
  const meanGym =
    normalizedGyms.reduce((sum, gym) => sum + gym.quality, 0) /
    Math.max(1, normalizedGyms.length);
  const meanTool =
    normalizedTools.reduce((sum, skill) => sum + skill.proficiency, 0) /
    Math.max(1, normalizedTools.length);
  const unlockedCount = POST_TRAIN_GYM_KINDS.filter((kind) =>
    gymUnlocked(kind, researchUnlocked),
  ).length;
  const gymShare = Math.min(
    0.75,
    normalizedGyms.reduce(
      (sum, gym) =>
        sum +
        ((gym.assignedResearchers ?? 0) > 0 &&
        (Boolean(gym.activePackageId) || (gym.tier ?? 0) > 0)
          ? (gym.researchShare ?? 0)
          : 0),
      0,
    ),
  );
  const techShare = Math.max(
    0,
    1 - researchAllocation.dataShare - researchAllocation.safetyShare - gymShare,
  );

  return (
    <div className="space-y-4" data-models-labs="true">
      <section className="rounded-lg border border-line/65 bg-panel-2/45 p-3">
        <p className="hud-eyebrow">Campus gyms</p>
        <h3 className="mt-1 text-sm font-semibold text-bone">
          Unlock, fund, attach to a run
        </h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <MeterBar
            label="Lab quality"
            value={meanGym}
            detail={`${unlockedCount}/${POST_TRAIN_GYM_KINDS.length} unlocked`}
            tone="research"
          />
          <MeterBar
            label="Tool curriculum"
            value={meanTool}
            detail={`${Math.round(meanTool * 100)}%`}
            tone="train"
          />
        </div>
        <div
          className="mt-3 grid gap-2 sm:grid-cols-3"
          aria-label="Research compute split"
        >
          {[
            ["Tech research", techShare, "catalog"],
            ["Synthetic & audit", researchAllocation.dataShare, "data"],
            ["Gym R&D", gymShare, "post-train"],
          ].map(([label, share, detail]) => (
            <div key={String(label)} className="rounded-md border border-line/60 bg-void/35 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.6875rem] font-semibold text-bone">{label}</span>
                <span className="font-mono text-[0.6875rem] text-mint">
                  {Math.round(Number(share) * 100)}%
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line/35">
                <div
                  className="h-full rounded-full bg-mint transition-[width] duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, Number(share) * 100))}%` }}
                />
              </div>
              <span className="mt-1 block font-mono text-[0.5625rem] uppercase tracking-wider text-muted">
                {detail}
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-3 xl:grid-cols-3">
        {normalizedGyms.map((gym) => {
          const meta = POST_TRAIN_GYM_META[gym.kind];
          const unlocked = gymUnlocked(gym.kind, researchUnlocked);
          const tier = Math.max(0, gym.tier ?? 0);
          const activePack = GYM_PACKAGES.find((pack) => pack.id === gym.activePackageId);
          const nextPack = GYM_PACKAGES.find((pack) => pack.tier === tier + 1);
          const otherGymResearchers = normalizedGyms.reduce(
            (sum, entry) =>
              sum + (entry.kind === gym.kind ? 0 : Math.max(0, entry.assignedResearchers ?? 0)),
            0,
          );
          const researcherMax = Math.max(
            0,
              researchAllocation.employedResearchers -
              researchAllocation.podResearchers -
              researchAllocation.fixedResearchers -
              otherGymResearchers,
          );
          const otherGymShare = normalizedGyms.reduce(
            (sum, entry) =>
              sum + (entry.kind === gym.kind ? 0 : Math.max(0, entry.researchShare ?? 0)),
            0,
          );
          const shareMax = Math.max(
            0,
            0.85 -
              researchAllocation.dataShare -
              researchAllocation.safetyShare -
              otherGymShare,
          );
          const allocationReady =
            Boolean(nextPack) &&
            (gym.assignedResearchers ?? 0) >= (nextPack?.minResearchers ?? 0) &&
            (gym.researchShare ?? 0) >= 0.05;
          return (
            <GameCard
              key={gym.id}
              eyebrow={meta.grades}
              title={meta.name}
              tone="research"
              actions={
                activePack ? (
                  <StatusChip tone="warning">building T{activePack.tier}</StatusChip>
                ) : unlocked ? (
                  <StatusChip tone="research">tier {tier}</StatusChip>
                ) : (
                  <StatusChip tone="warning">locked</StatusChip>
                )
              }
            >
              <p className="text-[0.6875rem] leading-5 text-muted">{meta.blurb}</p>
              <div className="mt-2">
                <MeterBar
                  label="Quality"
                  value={gym.quality}
                  detail={`${Math.round(gym.quality * 100)}%`}
                  tone="research"
                />
              </div>
              <p className="mt-2 font-mono text-[0.625rem] text-muted">
                Sunk {money(gym.investedCash)} cash · {money(gym.investedComputeCash)} compute
              </p>
              {unlocked ? (
                <div className="mt-3 rounded-md border border-research/25 bg-research/5 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="hud-eyebrow">HQ research team</span>
                    <span className="font-mono text-[0.625rem] text-muted">
                      {gym.assignedResearchers ?? 0}/{researcherMax}
                    </span>
                  </div>
                  <label className="mt-2 grid grid-cols-[1fr_4.5rem] items-center gap-2 text-[0.6875rem] text-muted">
                    Researchers assigned
                    <HudInput
                      type="number"
                      min={0}
                      max={researcherMax}
                      step={1}
                      value={gym.assignedResearchers ?? 0}
                      aria-label={`${meta.name} assigned researchers`}
                      onChange={(event) =>
                        onSetGymAllocation(gym.kind, {
                          assignedResearchers: Number(event.currentTarget.value),
                        })
                      }
                    />
                  </label>
                  <label className="mt-2 block text-[0.6875rem] text-muted">
                    <span className="flex items-center justify-between gap-2">
                      Research compute
                      <strong className="font-mono text-mint">
                        {Math.round((gym.researchShare ?? 0) * 100)}%
                      </strong>
                    </span>
                    <HudRange
                      min={0}
                      max={Math.round(shareMax * 100)}
                      step={5}
                      value={Math.round((gym.researchShare ?? 0) * 100)}
                      aria-label={`${meta.name} research compute percentage`}
                      onChange={(event) =>
                        onSetGymAllocation(gym.kind, {
                          researchShare: Number(event.currentTarget.value) / 100,
                        })
                      }
                    />
                  </label>
                  <p className="mt-1 text-[0.625rem] leading-4 text-muted">
                    Shared with tech research and synthetic data. Staff are reserved from the HQ pool.
                  </p>
                </div>
              ) : null}
              {activePack ? (
                <div className="mt-3">
                  <MeterBar
                    label={`${activePack.label} research`}
                    value={(gym.progressPfDays ?? 0) / Math.max(0.001, gym.targetPfDays ?? activePack.researchPfDays)}
                    detail={`${(gym.progressPfDays ?? 0).toFixed(1)} / ${(gym.targetPfDays ?? activePack.researchPfDays).toFixed(1)} PF-d`}
                    tone="research"
                  />
                  <p className="mt-1 font-mono text-[0.625rem] text-muted">
                    Opex {money(activePack.operatingCostPerDay)}/day · needs {activePack.minResearchers} researchers
                  </p>
                </div>
              ) : null}
              <div className="mt-3 grid gap-1.5">
                {unlocked ? (
                  nextPack && !activePack ? [nextPack].map((pack) => {
                    const total = packageTotalCash(pack);
                    const unaffordable = cash + 1e-9 < total;
                    const disabled = unaffordable || !allocationReady;
                    return (
                      <HudButton
                        key={pack.id}
                        type="button"
                        variant="secondary"
                        disabled={disabled}
                        title={
                          unaffordable
                            ? `Needs ${money(total)}.`
                            : !allocationReady
                              ? `Assign ${pack.minResearchers} researchers and at least 5% research compute.`
                              : pack.hint
                        }
                        className="!min-h-11 !w-full !items-start !justify-between !px-2.5 !py-2 !text-left"
                        onClick={() => onInvestGym(gym.kind, pack.id)}
                      >
                        <span>
                          <strong className="block text-[0.75rem]">{pack.label}</strong>
                          <span className="block text-[0.625rem] font-normal text-muted">
                            {pack.researchPfDays} PF-days · {pack.minResearchers} researchers · {money(pack.operatingCostPerDay)}/day
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[0.6875rem] text-mint">
                          {money(total)}
                        </span>
                      </HudButton>
                    );
                  }) : activePack ? null : (
                    <p className="rounded-md border border-research/25 bg-research/5 p-2.5 text-[0.6875rem] text-muted">
                      Full campus commissioned. Keep staff and compute assigned to improve curriculum quality.
                    </p>
                  )
                ) : (
                  <ResearchUnlockLink nodeId={GYM_UNLOCK_RESEARCH[gym.kind]} />
                )}
              </div>
            </GameCard>
          );
        })}
      </div>

      <section>
        <p className="hud-eyebrow">Tool curricula</p>
        <h3 className="mt-1 text-sm font-semibold text-bone">
          Teach tools before the tools stage
        </h3>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {normalizedTools.map((skill) => {
            const meta = TOOL_SKILL_META[skill.id];
            const Icon = TOOL_ICONS[skill.id];
            return (
              <GameCard
                key={skill.id}
                eyebrow={skill.id}
                title={
                  <span className="flex items-center gap-2">
                    <Icon size="1rem" className="text-mint" />
                    {meta.name}
                  </span>
                }
              >
                <p className="text-[0.6875rem] leading-5 text-muted">{meta.blurb}</p>
                <div className="mt-2">
                  <MeterBar
                    label="Proficiency"
                    value={skill.proficiency}
                    detail={`${Math.round(skill.proficiency * 100)}%`}
                    tone="train"
                  />
                </div>
                <div className="mt-3 grid gap-1.5">
                  {TOOL_PACKAGES.map((pack) => {
                    const total = packageTotalCash(pack);
                    return (
                      <HudButton
                        key={pack.id}
                        type="button"
                        variant="ghost"
                        disabled={cash + 1e-9 < total}
                        title={pack.hint}
                        className="!min-h-10 !w-full !justify-between !px-2 !text-left"
                        onClick={() => onTeachTool(skill.id, pack.id)}
                      >
                        <span className="text-[0.6875rem]">{pack.label}</span>
                        <span className="font-mono text-[0.625rem] text-muted">
                          {money(total)}
                        </span>
                      </HudButton>
                    );
                  })}
                </div>
              </GameCard>
            );
          })}
        </div>
      </section>
    </div>
  );
}
