import type { Model, SafetyCampaign, SafetyCampaignIntensity } from '../../../../sim/types'
import { safetyCampaignEstimate } from '../../../../sim/systems/safetyCampaigns'
import { formatTokens } from '../../../../sim/balance/data'
import { money } from '../../format'
import { GameCard, MeterBar, StatRow, BlockerList } from '../../ui/kit'
import { HudButton, HudRange } from '../../ui/HudPrimitives'

import { HudDesktopDefaultDetails } from '../../ui/HudDesktopDefaultDetails'

export function SafetyCampaignSection({
  model,
  campaign,
  intensity,
  setIntensity,
  researchers,
  setResearchers,
  researcherCount,
  estimate,
  onStart,
  onCancel,
  compact = false,
}: {
  model: Model | null
  campaign: SafetyCampaign | null
  intensity: SafetyCampaignIntensity
  setIntensity: (value: SafetyCampaignIntensity) => void
  researchers: number
  setResearchers: (value: number) => void
  researcherCount: number
  estimate: ReturnType<typeof safetyCampaignEstimate> | null
  onStart: () => void
  onCancel: () => void
  compact?: boolean
}) {
  void compact
  if (campaign && (!model || campaign.modelId === model.id)) {
    const trainingProgress = campaign.progressTrainingPfDays / Math.max(0.01, campaign.targetTrainingPfDays)
    const researchProgress = campaign.progressResearchPfDays / Math.max(0.01, campaign.targetResearchPfDays)
    return (
      <GameCard
        tone="research"
        live
        eyebrow="Safety campaign"
        title={campaign.modelName}
        mobileSummary={`${Math.round(Math.min(trainingProgress, researchProgress) * 100)}% · ${campaign.assignedResearchers} researchers`}
        actions={
          <HudButton type="button" variant="danger" onClick={onCancel} className="!min-h-11 !px-2 !py-1 text-[0.6875rem] xl:!min-h-9">
            Cancel
          </HudButton>
        }
      >
        <p className="mb-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-research">
          {campaign.intensity} · source revision stays live · new checkpoint in progress
        </p>
        <div className="space-y-2">
          <MeterBar
            label="Training compute"
            value={trainingProgress}
            detail={`${campaign.progressTrainingPfDays.toFixed(2)} / ${campaign.targetTrainingPfDays.toFixed(2)} PF-d`}
            tone="research"
            live
          />
          <MeterBar
            label="Research compute"
            value={researchProgress}
            detail={`${campaign.progressResearchPfDays.toFixed(2)} / ${campaign.targetResearchPfDays.toFixed(2)} PF-d`}
            tone="research"
            live
          />
        </div>
        <p className="mt-2 font-mono text-[0.6875rem] text-muted">
          {campaign.assignedResearchers} researchers · safety set {formatTokens(campaign.safetyDataMTok)} · Q
          {campaign.safetyDataQuality.toFixed(2)}
        </p>
      </GameCard>
    )
  }

  if (!model) return null

  const blockers = estimate?.reason ? [{ text: estimate.reason, tone: 'warning' as const }] : []
  const totalPfDays = estimate
    ? estimate.trainingPfDays + estimate.researchPfDays
    : null

  return (
    <GameCard
      tone="research"
      eyebrow="Safety post-training"
      title={model.name}
      mobileSummary="Optional safety checkpoint"
      actions={
        <span className="font-mono text-[0.6875rem] text-muted">
          {model.safetyTraining?.campaigns ?? 0} complete
        </span>
      }
    >
      <HudDesktopDefaultDetails
        key={model.id}
        className="group rounded-md border border-research/25 bg-research/5"
        data-safety-setup-disclosure="true"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-research/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-research/60 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block text-[0.75rem] font-semibold text-bone">
              Configure {intensity} campaign
            </span>
            <span className="mt-0.5 block font-mono text-[0.625rem] tabular-nums text-muted">
              {totalPfDays == null
                ? 'Estimate unavailable'
                : `${totalPfDays.toFixed(2)} PF-d total · ${money(estimate!.cashBudget)}`}
            </span>
          </span>
          <span className="shrink-0 font-mono text-[0.625rem] uppercase tracking-wider text-research">
            <span className="group-open:hidden">Expand</span>
            <span className="hidden group-open:inline">Collapse</span>
            <span aria-hidden className="ml-1 inline-block transition-transform group-open:rotate-180">⌄</span>
          </span>
        </summary>

        <div className="border-t border-research/20 p-2.5">
          <p className="mb-2 text-[0.8125rem] text-muted">
            Creates a new safety-trained checkpoint/version. The source model stays
            unchanged and can remain public while this revision trains.
          </p>
          <div className="grid gap-1.5 min-[420px]:grid-cols-3">
            {(['targeted', 'standard', 'frontier'] as SafetyCampaignIntensity[]).map((option) => (
              <HudButton
                key={option}
                type="button"
                variant="ghost"
                aria-pressed={intensity === option}
                onClick={() => setIntensity(option)}
                className={`!min-h-11 !rounded-md !px-2 !py-1.5 text-[0.6875rem] capitalize transition ${
                  intensity === option
                    ? '!border-research/50 !bg-research/15 !text-research'
                    : '!border-line !text-muted hover:!text-bone'
                }`}
              >
                {option}
              </HudButton>
            ))}
          </div>
          {estimate ? (
            <div className="mt-2 space-y-0.5">
              <StatRow label="Train" value={`${estimate.trainingPfDays.toFixed(2)} PF-d`} />
              <StatRow label="Research" value={`${estimate.researchPfDays.toFixed(2)} PF-d`} tone="research" />
              <StatRow label="Cash" value={money(estimate.cashBudget)} />
            </div>
          ) : null}
          <label className="mt-2 block text-[0.6875rem] text-muted">
            Researchers {researchers} / {researcherCount}
            <HudRange
              type="range"
              min={1}
              max={Math.max(1, researcherCount)}
              value={Math.min(Math.max(1, researcherCount), researchers)}
              onChange={(event) => setResearchers(Number(event.target.value))}
              className="mt-1"
            />
          </label>
          <div className="mt-2 space-y-2">
            <BlockerList items={blockers} />
            <HudButton
              type="button"
              variant="primary"
              disabled={!estimate?.ok}
              title={!estimate?.ok ? estimate?.reason ?? 'Cannot start safety campaign' : undefined}
              onClick={onStart}
              className="w-full !bg-research !text-void"
            >
              Create {intensity} safety checkpoint
            </HudButton>
          </div>
        </div>
      </HudDesktopDefaultDetails>
    </GameCard>
  )
}
