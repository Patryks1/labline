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
import { HudButton, StatusChip } from "../../ui/HudPrimitives";
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
  onTeachTool,
}: {
  cash: number;
  gyms?: readonly PostTrainGym[];
  tools?: readonly ToolSkill[];
  researchUnlocked: readonly string[];
  onInvestGym: (kind: PostTrainGymKind, packageId: string) => void;
  onTeachTool: (skillId: ToolSkillId, packageId: string) => void;
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
      </section>

      <div className="grid gap-3 xl:grid-cols-3">
        {normalizedGyms.map((gym) => {
          const meta = POST_TRAIN_GYM_META[gym.kind];
          const unlocked = gymUnlocked(gym.kind, researchUnlocked);
          return (
            <GameCard
              key={gym.id}
              eyebrow={meta.grades}
              title={meta.name}
              tone="research"
              actions={
                unlocked ? (
                  <StatusChip tone="research">open</StatusChip>
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
              <div className="mt-3 grid gap-1.5">
                {unlocked ? (
                  GYM_PACKAGES.map((pack) => {
                    const total = packageTotalCash(pack);
                    const unaffordable = cash + 1e-9 < total;
                    return (
                      <HudButton
                        key={pack.id}
                        type="button"
                        variant="secondary"
                        disabled={unaffordable}
                        title={pack.hint}
                        className="!min-h-11 !w-full !items-start !justify-between !px-2.5 !py-2 !text-left"
                        onClick={() => onInvestGym(gym.kind, pack.id)}
                      >
                        <span>
                          <strong className="block text-[0.75rem]">{pack.label}</strong>
                          <span className="block text-[0.625rem] font-normal text-muted">
                            {pack.hint}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[0.6875rem] text-mint">
                          {money(total)}
                        </span>
                      </HudButton>
                    );
                  })
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
