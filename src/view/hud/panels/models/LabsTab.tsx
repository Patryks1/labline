import { Code, Flask, Function as FunctionIcon, MagnifyingGlass, Terminal } from "@phosphor-icons/react";
import type { PostTrainGym, PostTrainGymKind, ToolSkill, ToolSkillId } from "../../../../sim/types";
import {
  GYM_FOCUS_AXES,
  GYM_PACKAGES,
  GYM_UNLOCK_RESEARCH,
  POST_TRAIN_GYM_KINDS,
  POST_TRAIN_GYM_META,
  TOOL_PACKAGES,
  TOOL_PACKAGE_UNLOCK,
  TOOL_SKILL_META,
  TOOL_SKILL_UNLOCK,
  gymUnlocked,
  normalizePostTrainGyms,
  normalizeToolSkills,
  packageTotalCash,
  toolPackageUnlocked,
  toolSkillUnlocked,
} from "../../../../sim/balance/modelStudio";
import { money } from "../../format";
import { GameCard, MeterBar } from "../../ui/kit";
import { HudButton, StatusChip } from "../../ui/HudPrimitives";
import { ResearchUnlockLink } from "../../ui/ResearchUnlockLink";
import { SliderField } from "../../ui/SliderField";

import { HudDesktopDefaultDetails } from "../../ui/HudDesktopDefaultDetails";

type LabsResearchAllocation = {
  dataShare: number;
  safetyShare: number;
  employedResearchers: number;
  podResearchers: number;
  fixedResearchers: number;
};

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

function gymFreeResearchers(researchAllocation: LabsResearchAllocation): number {
  return Math.max(
    0,
    researchAllocation.employedResearchers -
      researchAllocation.podResearchers -
      researchAllocation.fixedResearchers,
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
    allocation: {
      assignedResearchers?: number;
      researchShare?: number;
      focusBias?: number;
    },
  ) => void;
  onTeachTool: (skillId: ToolSkillId, packageId: string) => void;
  researchAllocation: LabsResearchAllocation;
}) {
  const normalizedGyms = normalizePostTrainGyms(gyms);
  const normalizedTools = normalizeToolSkills(tools);
  const freeResearchers = gymFreeResearchers(researchAllocation);
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
        <HudDesktopDefaultDetails className="group mt-3 rounded-md border border-line/55 bg-void/25" data-labs-research-split="collapsed">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.6875rem] text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-research/60 [&::-webkit-details-marker]:hidden">
            <span>Research compute split</span>
            <span className="font-mono tabular-nums text-bone">Gym {Math.round(gymShare * 100)}% · <span className="group-open:hidden">Details</span><span className="hidden group-open:inline">Hide</span></span>
          </summary>
        <div
          className="grid gap-2 border-t border-line/40 p-2.5 sm:grid-cols-3"
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
        </HudDesktopDefaultDetails>
      </section>

      <div className="grid gap-3 xl:grid-cols-3" data-labs-gym-grid="true">
        {normalizedGyms.map((gym) => {
          const meta = POST_TRAIN_GYM_META[gym.kind];
          const unlocked = gymUnlocked(gym.kind, researchUnlocked);
          const tier = Math.max(0, gym.tier ?? 0);
          const activePack = GYM_PACKAGES.find((pack) => pack.id === gym.activePackageId);
          const nextPack = GYM_PACKAGES.find((pack) => pack.tier === tier + 1);
          const staffed =
            (gym.assignedResearchers ?? 0) > 0 ||
            (gym.assignedEngineers ?? 0) > 0 ||
            (gym.assignedDataStaff ?? 0) > 0;
          return (
            <GameCard
              key={gym.id}
              eyebrow={meta.grades}
              title={meta.name}
              mobileSummary={`${Math.round(gym.quality * 100)}% quality · ${unlocked ? `tier ${tier}` : "locked"}`}
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
              <p className="hud-mobile-detail text-[0.6875rem] leading-5 text-muted">{meta.blurb}</p>
              <div className="mt-2">
                <MeterBar
                  label="Quality"
                  value={gym.quality}
                  detail={`${Math.round(gym.quality * 100)}%`}
                  tone="research"
                />
              </div>
              {unlocked ? (
                <div className="mt-3">
                  <SliderField
                    label="Focus"
                    sublabel={
                      <span className="font-mono text-[0.5625rem] text-muted">
                        {GYM_FOCUS_AXES[gym.kind].low} → {GYM_FOCUS_AXES[gym.kind].high}
                      </span>
                    }
                    value={gym.focusBias ?? 0.5}
                    hint
                    hoverContent={
                      <p className="text-[0.6875rem] leading-5 text-muted">
                        {GYM_FOCUS_AXES[gym.kind].hint}
                      </p>
                    }
                    onChange={(next) =>
                      onSetGymAllocation(gym.kind, { focusBias: next })
                    }
                  />
                </div>
              ) : null}
              {unlocked ? (
                <p className="mt-2 font-mono text-[0.625rem] leading-4 text-muted" data-gym-auto-staff="true">
                  Auto {gym.assignedResearchers ?? 0} researchers
                  {" · "}
                  {gym.assignedEngineers ?? 0} engineers
                  {" · "}
                  {gym.assignedDataStaff ?? 0} data
                  {" · "}
                  {Math.round((gym.researchShare ?? 0) * 100)}% PF
                  {staffed ? "" : " · fills from free HQ seats"}
                </p>
              ) : null}
              {activePack ? (
                <div className="mt-2">
                  <MeterBar
                    label={`${activePack.label} research`}
                    value={(gym.progressPfDays ?? 0) / Math.max(0.001, gym.targetPfDays ?? activePack.researchPfDays)}
                    detail={`${(gym.progressPfDays ?? 0).toFixed(1)} / ${(gym.targetPfDays ?? activePack.researchPfDays).toFixed(1)} PF-d`}
                    tone="research"
                  />
                </div>
              ) : null}
              <div className="mt-3 grid gap-1.5">
                {unlocked ? (
                  nextPack && !activePack ? [nextPack].map((pack) => {
                    const total = packageTotalCash(pack);
                    const unaffordable = cash + 1e-9 < total;
                    const shortStaff = freeResearchers < pack.minResearchers;
                    const disabled = unaffordable || shortStaff;
                    return (
                      <HudButton
                        key={pack.id}
                        type="button"
                        variant="secondary"
                        disabled={disabled}
                        title={
                          unaffordable
                            ? `Needs ${money(total)}.`
                            : shortStaff
                              ? `Need ${pack.minResearchers} free HQ researchers.`
                              : pack.hint
                        }
                        className="!min-h-11 !w-full !items-start !justify-between !px-2.5 !py-2 !text-left"
                        onClick={() => onInvestGym(gym.kind, pack.id)}
                      >
                        <span>
                          <strong className="block text-[0.75rem]">{pack.label}</strong>
                          <span className="hud-mobile-detail block text-[0.625rem] font-normal text-muted">
                            {pack.researchPfDays} PF-days · auto {pack.minResearchers} researchers · {money(pack.operatingCostPerDay)}/day
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[0.6875rem] text-mint">
                          {money(total)}
                        </span>
                      </HudButton>
                    );
                  }) : activePack ? null : (
                    <p className="rounded-md border border-research/25 bg-research/5 p-2.5 text-[0.6875rem] text-muted">
                      Full campus commissioned. Crew stays auto-assigned.
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
            const skillUnlocked = toolSkillUnlocked(skill.id, researchUnlocked);
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
                mobileSummary={
                  skillUnlocked
                    ? `${Math.round(skill.proficiency * 100)}% proficiency`
                    : "research locked"
                }
                actions={
                  skillUnlocked ? (
                    <StatusChip tone="train">{Math.round(skill.proficiency * 100)}%</StatusChip>
                  ) : (
                    <StatusChip tone="warning">locked</StatusChip>
                  )
                }
              >
                <p className="hud-mobile-detail text-[0.6875rem] leading-5 text-muted">{meta.blurb}</p>
                <p className="mt-1 font-mono text-[0.5625rem] uppercase tracking-wider text-muted">
                  Feeds the tools post-train stage
                </p>
                <div className="mt-2">
                  <MeterBar
                    label="Proficiency"
                    value={skill.proficiency}
                    detail={`${Math.round(skill.proficiency * 100)}%`}
                    tone="train"
                  />
                </div>
                <div className="mt-3 grid gap-1.5">
                  {!skillUnlocked ? (
                    <ResearchUnlockLink
                      nodeId={TOOL_SKILL_UNLOCK[skill.id]}
                      label="Unlock this tool"
                    />
                  ) : (
                    TOOL_PACKAGES.map((pack) => {
                      const total = packageTotalCash(pack);
                      const packNode = TOOL_PACKAGE_UNLOCK[pack.id];
                      const packUnlocked = toolPackageUnlocked(
                        pack.id,
                        researchUnlocked,
                      );
                      const unaffordable = cash + 1e-9 < total;
                      const disabled = unaffordable || !packUnlocked;
                      return (
                        <HudButton
                          key={pack.id}
                          type="button"
                          variant="ghost"
                          disabled={disabled}
                          title={
                            !packUnlocked && packNode
                              ? pack.hint
                              : unaffordable
                                ? `Needs ${money(total)}.`
                                : pack.hint
                          }
                          className="!min-h-11 !w-full !items-start !justify-between !px-2 !py-2 !text-left"
                          onClick={() => onTeachTool(skill.id, pack.id)}
                        >
                          <span>
                            <span className="block text-[0.6875rem] font-semibold text-bone">
                              {pack.label}
                            </span>
                            <span className="mt-0.5 block text-[0.5625rem] leading-4 text-muted">
                              {pack.hint}
                            </span>
                          </span>
                          <span className="shrink-0 text-right font-mono text-[0.625rem] text-mint">
                            {money(total)}
                          </span>
                        </HudButton>
                      );
                    })
                  )}
                </div>
              </GameCard>
            );
          })}
        </div>
      </section>
    </div>
  );
}
